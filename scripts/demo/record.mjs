/**
 * Records the 3-minute Chimera Rx demo video with a scripted voiceover.
 * Run with `pnpm demo:record`. Synthetic data only; the voice is macOS `say` (a synthetic voice).
 *
 * What it does, in order:
 *   1. builds the web app, starts its OWN API on port 4560 with a temp DATA_DIR (LG_DEMO=1, LLM_PROVIDER=mock),
 *   2. speaks every beat of docs/DEMO_SCRIPT.md with `say` (the script text is never edited),
 *   3. drives the real UI in Chromium (CDP screencast, 1440x900) so each beat lasts as long as its audio,
 *   4. builds one audio track with every clip at its recorded start offset,
 *   5. muxes H.264 + AAC with scripts/demo/mux.swift (the Playwright ffmpeg has no H.264 or audio encoders, and recordVideo drifted against the clock, so frames come from a CDP screencast),
 *   6. writes demo-video/chimera-rx-demo.{mp4,srt} and a poster PNG, then stops its own API by PID.
 * Output is git-ignored. Env: DEMO_RATE (say words per minute, default 172), DEMO_VOICE (default Samantha),
 * DEMO_PORT (default 4560), SKIP_BUILD=1.
 */
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "demo-video");
const AUDIO = path.join(OUT, "audio");
const PORT = Number(process.env.DEMO_PORT ?? 4560);
const RATE = Number(process.env.DEMO_RATE ?? 172);
const VOICE = process.env.DEMO_VOICE ?? "Samantha";
const BASE = `http://localhost:${PORT}`;
const PW = "moonlight-rx-2026";
const NOTICE = "Demo environment · synthetic data only · not for clinical use · not HIPAA-compliant · a pharmacist approves every message";
if ([4000, 5173, 5174].includes(PORT)) throw new Error("port reserved for the live demo stack");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[demo]", ...a);
fs.mkdirSync(AUDIO, { recursive: true });

// ---- 1. parse the script -------------------------------------------------------------------------------------------
const beats = fs.readFileSync(path.join(ROOT, "docs/DEMO_SCRIPT.md"), "utf8").split("\n").filter((l) => /^\| \d:\d\d \|/.test(l)).map((l) => {
  const c = l.split("|").map((s) => s.trim());
  const [m, s] = c[1].split(":").map(Number);
  return { sched: m * 60 + s, screen: c[2], say: c[3].replace(/^"|"$/g, "") };
});
if (beats.length !== 11) throw new Error(`expected 11 beats in docs/DEMO_SCRIPT.md, found ${beats.length}`);
const CAPTIONS = [
  "Today's pharmacy software knows who got the drug, not which lot",
  "Chimera Rx records lot and serial: 197 units on the shelf, 17 patients",
  "Recall fax read by OCR in the browser, confirmed against openFDA",
  "A stand-in model invents a lot. The Coroner drops it: only lots printed in the notice survive",
  "One click: exact units quarantined, patients listed by consent",
  "An agent drafts, a pharmacist attests and sends. Sandbox outbox only",
  "Eight AI agents: rules decide, a model explains, a gate checks, a pharmacist decides",
  "GS1 EPCIS 2.0 export and a sandbox verifier. A stand-in, not a filing",
  "Refills know the lot: recall hold stays after the recall closes",
  "Encrypted fields, rotating keys, hash-chained audit log",
  "Built with Kiro. Eleven safety rules, property tests on the lot gate",
];

// ---- 2. build + stack -----------------------------------------------------------------------------------------------
if (process.env.SKIP_BUILD !== "1") { log("building web"); execFileSync("pnpm", ["build:web"], { cwd: ROOT, stdio: "ignore" }); }
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crx-demo-"));
const env = { ...process.env, API_PORT: String(PORT), DATA_DIR: dataDir, LG_DEMO: "1", LLM_PROVIDER: "mock", AGENTS_BACKGROUND: "1" };
const api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: path.join(ROOT, "apps/api"), env, stdio: "ignore" });
log("API pid", api.pid, "port", PORT, "data", dataDir);
let browser;
// A stand-in "model" for beat 4 only: an OpenAI-compatible endpoint that answers like a model that invents a lot. It makes the real
// Coroner gate drop that lot on camera (the offline mock never invents anything). Listens on 127.0.0.1 only and returns fixed text.
const stub = http.createServer((req, res) => {
  req.resume(); req.on("end", () => {
    const content = JSON.stringify({ ndcs: [], lots: [
      { value: "PRORX050925-1", expiry: "2027-09-30", confidence: 0.97 }, { value: "PRORX050925-3", expiry: "2027-09-30", confidence: 0.96 },
      { value: "PRORX050925-7", expiry: "2027-09-30", confidence: 0.9 }], notes: "Three lots." });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "stub", object: "chat.completion", model: "stub-model", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }));
  });
}).listen(PORT + 1, "127.0.0.1");
const cleanup = () => { try { api.kill("SIGTERM"); } catch {} try { stub.close(); } catch {} };
process.on("exit", cleanup);
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(500); if (i === 59) throw new Error("API did not start"); }

  // ---- 3. audio clips ----------------------------------------------------------------------------------------------
  for (const [i, b] of beats.entries()) {
    const f = path.join(AUDIO, `beat-${i + 1}.aiff`);
    execFileSync("say", ["-v", VOICE, "-r", String(RATE), "-o", f, b.say]);
    const wav = path.join(AUDIO, `beat-${i + 1}.wav`);
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@44100", "-c", "1", f, wav]);
    b.wav = wav;
    b.pcm = readWavPcm(wav);
    b.dur = b.pcm.length / 44100;
  }
  log("speech seconds", beats.reduce((a, b) => a + b.dur, 0).toFixed(1));

  // ---- 4. record ---------------------------------------------------------------------------------------------------
  const vdir = path.join(os.tmpdir(), `crx-video-${Date.now()}`);
  browser = await chromium.launch();
  // Frames come from the CDP screencast with their own timestamps (Playwright recordVideo drifted about 4% against the wall clock,
  // which would put the voice out of sync). The screencast is resampled to a constant 25 fps below.
  fs.mkdirSync(vdir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(OVERLAY);
  const api0 = await browser.newContext({ viewport: { width: 1440, height: 900 } }); // control context, never recorded
  const login = (c, who = "j.rivera") => c.request.post(`${BASE}/api/auth/login`, { data: { storeId: "store-7", email: `${who}@elmstreetrx.example`, password: PW, trusted: true } });
  await login(api0); await api0.request.post(`${BASE}/api/demo/reset`, { data: {} }); // clean state, signed out afterwards

  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  const shots = []; let nShot = 0;
  cdp.on("Page.screencastFrame", (f) => {
    const file = path.join(vdir, `s${String(nShot++).padStart(6, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, "base64"));
    shots.push({ t: f.metadata.timestamp, file });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  const v0 = Date.now();
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
  p.on("pageerror", (e) => log("pageerror", e.message));
  let cx = 720, cy = 450;
  const moveTo = async (x, y) => {
    const d = Math.hypot(x - cx, y - cy), n = Math.max(10, Math.min(46, Math.round(d / 14)));
    const x0 = cx, y0 = cy;
    for (let i = 1; i <= n; i++) { const t = i / n, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; await p.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e); await sleep(16); }
    cx = x; cy = y; await sleep(120);
  };
  const center = async (loc) => { await loc.first().waitFor({ timeout: 20000 }); await loc.first().scrollIntoViewIfNeeded(); const b = await loc.first().boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
  const hover = async (loc) => { const [x, y] = await center(loc); await moveTo(x, y); };
  const click = async (loc) => { await hover(loc); await sleep(220); await p.mouse.down(); await sleep(70); await p.mouse.up(); await sleep(300); };
  const scroll = async (dy) => { const n = 12; for (let i = 0; i < n; i++) { await p.mouse.wheel(0, dy / n); await sleep(30); } await sleep(250); };
  const cap = (t) => p.evaluate((x) => window.__cap?.(x), t).catch(() => {});
  const nav = (name) => click(p.locator("nav[aria-label='Main']").getByRole("link", { name, exact: false }).first());
  const signIn = async (typed) => {
    await p.waitForSelector("#email");
    if (typed) {
      await click(p.locator("#email")); await p.keyboard.press("Meta+A"); await p.keyboard.type("j.rivera@elmstreetrx.example", { delay: 45 });
      await click(p.locator("#pw")); await p.keyboard.press("Meta+A"); await p.keyboard.type(PW, { delay: 45 });
    }
    await click(p.getByRole("button", { name: "Sign in", exact: true }).first());
    await p.waitForSelector("nav[aria-label='Main']", { timeout: 15000 });
  };

  const starts = [];
  const runBeat = async (i, fn) => {
    const wait = beats[i].sched * 1000 - (Date.now() - v0);
    if (wait > 0) await sleep(wait);
    const t = Date.now();
    starts[i] = (t - v0) / 1000;
    await cap(CAPTIONS[i]);
    log(`beat ${i + 1} at ${starts[i].toFixed(1)}s`);
    try { await fn(); } catch (e) { log(`beat ${i + 1} action failed: ${e.message.split("\n")[0]}`); await p.screenshot({ path: path.join(OUT, `fail-beat-${i + 1}.png`) }).catch(() => {}); }
    const rest = beats[i].dur * 1000 + 700 - (Date.now() - t);
    if (rest > 0) await sleep(rest);
  };
  const terminal = async (title, body) => {
    await p.route("**/__demo/term", (r) => r.fulfill({ contentType: "text/html", body: terminalHtml(title, body) }));
    await p.goto(`${BASE}/__demo/term`);
    await cap(CAPTIONS[currentBeat]);
    await p.mouse.move(cx, cy);
  };
  let currentBeat = 0;

  // beat 1: sign-in page, demo notice
  await p.goto(BASE); await p.waitForSelector("#email"); await p.mouse.move(cx, cy);
  currentBeat = 0;
  await runBeat(0, async () => {
    await sleep(1500); await hover(p.getByText(/Demo environment/).first()); await sleep(3500);
    await moveTo(720, 600); await sleep(1500);
    await click(p.locator("#email")); await p.keyboard.press("Meta+A"); await p.keyboard.type("j.rivera@elmstreetrx.example", { delay: 40 });
    await click(p.locator("#pw")); await p.keyboard.press("Meta+A"); await p.keyboard.type(PW, { delay: 40 });
  });
  // beat 2: sign in, Today, recall banner
  currentBeat = 1;
  await runBeat(1, async () => {
    await click(p.getByRole("button", { name: "Sign in", exact: true }).first());
    await p.waitForSelector("text=Recall fax received", { timeout: 15000 });
    await sleep(900); await hover(p.getByText(/Recall fax received/).first()); await sleep(2200);
    await hover(p.getByText(/197 units on hand/).first()); await sleep(2500);
  });
  // beat 3: Recalls, read the fax with OCR
  currentBeat = 2;
  await runBeat(2, async () => {
    await nav("Recalls"); await p.waitForSelector("text=Fax inbox");
    await sleep(1200);
    await click(p.getByRole("button", { name: "Read this fax with OCR" }));
    await p.waitForSelector("text=Already with patients", { timeout: 120000 });
    await sleep(500); await hover(p.getByText("Lots read from the notice")); await sleep(1500);
  });
  // beat 4: Coroner drops an invented lot (AI agents, Coroner sample run)
  currentBeat = 3;
  await runBeat(3, async () => {
    await login(api0);
    await api0.request.post(`${BASE}/api/agents/provider`, { data: { provider: "openai-compatible", model: "stub-model", baseUrl: `http://127.0.0.1:${PORT + 1}/v1` } });
    await nav("AI agents"); await p.waitForSelector("article[aria-label='Coroner']");
    await sleep(800);
    await click(p.locator("article[aria-label='Coroner']").getByRole("button", { name: "Run with sample input" }));
    await p.waitForSelector("text=What the gate dropped", { timeout: 20000 });
    await sleep(600);
    await hover(p.getByText("What the gate dropped")); await sleep(300);
    await scroll(250);
    await hover(p.locator("li:has(strong)").first()); await sleep(1800);
    await api0.request.post(`${BASE}/api/agents/provider`, { data: { provider: "mock" } }); // back to the offline mock for everything else
  });
  // beat 5: impact, quarantine, patients, channels
  currentBeat = 4;
  await runBeat(4, async () => {
    await nav("Recalls"); await p.waitForSelector("text=Already with patients", { timeout: 15000 });
    await sleep(900); await hover(p.getByText("197 units").first()); await sleep(1500);
    await hover(p.getByText("13 by text").first()); await sleep(1500);
    await scroll(300); await hover(p.getByText("Maria Alvarez").first());
  });
  // beat 6: messages, AI draft, attestation, send, sandbox outbox
  currentBeat = 5;
  await runBeat(5, async () => {
    await click(p.getByRole("button", { name: "Continue to patient messages" }));
    await p.waitForSelector("text=Text message", { timeout: 15000 });
    await click(p.getByRole("button", { name: "Use AI draft" }));
    await p.waitForSelector("text=/pieces are AI wording/", { timeout: 20000 }).catch(() => {});
    await scroll(400); await sleep(1200);
    await click(p.getByLabel(/I am the pharmacist/));
    await click(p.getByRole("button", { name: /^Start \d+ calls/ }));
    await p.waitForSelector("text=Patients contacted for recall", { timeout: 60000 });
    await sleep(2500);
    await nav("Demo guide"); await p.waitForSelector("text=Demo tools");
    await click(p.getByRole("link", { name: /Sandbox outbox/ }));
    await p.waitForSelector("text=/STOP/", { timeout: 20000 }).catch(() => {});
    await sleep(1500); await scroll(250);
  });
  // beat 7: AI agents, provider card, Rx Guardian "Agent catches it", Today suggestions, accept one on Fill
  currentBeat = 6;
  await runBeat(6, async () => {
    await nav("AI agents"); await p.waitForSelector("section[aria-label='Provider']");
    await hover(p.locator("section[aria-label='Provider']").getByText("Now:").first()); await sleep(1500);
    await hover(p.locator("section[aria-label='Provider'] select")); await sleep(1800);
    const group = p.getByRole("group", { name: "Rx Guardian background mode" });
    await group.scrollIntoViewIfNeeded(); await sleep(600);
    const sw = group.getByRole("switch");
    if ((await sw.getAttribute("aria-checked")) !== "true") await click(sw);
    await group.getByText("On", { exact: true }).waitFor({ timeout: 8000 });
    await sleep(1200);
    await nav("Demo guide"); await p.waitForSelector("text=Demo scenarios");
    await click(p.getByRole("button", { name: /Agent catches it/ }));
    await sleep(1500);
    if (await p.locator("#email").count()) await signIn(false); // the scenario resets the demo and signs everyone out
    await p.goto(`${BASE}/#/agents`); await p.waitForSelector("section[aria-label='Agents']");
    const g2 = p.getByRole("group", { name: "Rx Guardian background mode" });
    await g2.scrollIntoViewIfNeeded();
    await click(g2.getByRole("button", { name: "Run now" })); await sleep(1500);
    await nav("Today"); await p.locator("section[aria-labelledby=sugg] li").first().waitFor({ timeout: 25000 });
    await hover(p.locator("section[aria-labelledby=sugg] li").first()); await sleep(1800);
    await p.goto(`${BASE}/#/fill?rx=0072301`);
    await p.waitForSelector("text=Evidence from the history", { timeout: 20000 });
    await sleep(1000); await hover(p.getByText("Evidence from the history").first()); await sleep(1500);
    await click(p.getByRole("button", { name: "Accept: hold the order" }).first());
    await click(p.getByRole("button", { name: "Put order on hold" }));
    await sleep(1500);
  });
  // beat 8: DSCSA & trace
  currentBeat = 7;
  await runBeat(7, async () => {
    await nav("DSCSA"); await p.waitForSelector("text=Verification requests");
    await sleep(800);
    const dl = p.waitForEvent("download", { timeout: 15000 }).catch(() => null);
    await click(p.getByRole("link", { name: "Download .jsonld" })); await dl;
    await click(p.getByRole("button", { name: "Preview" }));
    await sleep(800); await scroll(200);
    await click(p.getByRole("button", { name: "Ask the sandbox verifier" })); await sleep(1800);
  });
  // beat 9: Refills, recall hold row (scenario resets the demo, so sign in again; the recall is looked up through the API)
  currentBeat = 8;
  const c2 = api0; await login(c2);
  await c2.request.post(`${BASE}/api/demo/scenarios/recall-aware-refill`, { data: {} });
  await login(c2); await c2.request.post(`${BASE}/api/recalls/lookup`, { data: { number: "D-0611-2026" } });
  await runBeat(8, async () => {
    await p.goto(BASE); // session was cleared by the scenario reset
    await p.waitForSelector("#email"); await signIn(false);
    await nav("Refills"); await p.waitForSelector("text=Recall hold", { timeout: 15000 });
    await sleep(900); await hover(p.getByText("Recall hold").first()); await sleep(2500);
  });
  // beat 10: encryption and audit proof
  currentBeat = 9;
  const keys = (() => { try { return execFileSync("pnpm", ["--filter", "@chimera-rx/api", "keys:status"], { cwd: ROOT, env, encoding: "utf8" }); } catch (e) { return String(e.stdout ?? e.message); } })();
  const verify = await (await ctx.request.get(`${BASE}/api/audit/verify`)).text();
  await runBeat(9, async () => {
    await terminal("Encryption and audit", `<span class=c>$ pnpm --filter @chimera-rx/api keys:status</span>\n${esc(keys.split("\n").filter((l) => l.trim() && !/^>|^\s*$/.test(l)).join("\n"))}\n\n<span class=c>$ curl -s /api/audit/verify</span>\n${esc(verify)}\n\n<span class=c>$ grep -n "Audit log" docs/SECURITY.md</span>\n${esc(fs.readFileSync(path.join(ROOT, "docs/SECURITY.md"), "utf8").split("\n").filter((l) => /^- \*\*Audit log/.test(l)).join("\n").slice(0, 400))}`);
    await sleep(500);
  });
  // beat 11: the .kiro folder
  currentBeat = 10;
  const lsKiro = fs.readdirSync(path.join(ROOT, ".kiro")).join("   ");
  const lsSteer = fs.readdirSync(path.join(ROOT, ".kiro/steering")).filter((f) => !f.startsWith("aidlc")).join("   ");
  const safety = fs.readFileSync(path.join(ROOT, ".kiro/steering/pharmacy-safety.md"), "utf8").split("\n").slice(0, 16).join("\n");
  await runBeat(10, async () => {
    await terminal("Built with Kiro", `<span class=c>$ ls .kiro</span>\n${esc(lsKiro)}\n\n<span class=c>$ ls .kiro/steering</span>\n${esc(lsSteer)}\n\n<span class=c>$ head -16 .kiro/steering/pharmacy-safety.md</span>\n${esc(safety)}`);
  });
  await sleep(1500);
  await p.evaluate(() => window.__capOff?.()).catch(() => {});
  const total = (Date.now() - v0) / 1000;
  await cdp.send("Page.stopScreencast").catch(() => {});
  await ctx.close(); await api0.close();
  await browser.close(); browser = null;
  log("recorded", total.toFixed(1), "s,", shots.length, "screencast frames");

  // ---- 5. audio track, resampled frames, mux --------------------------------------------------------------------------
  const sr = 44100, track = new Int16Array(Math.ceil((total + 2) * sr));
  beats.forEach((b, i) => { b.offset = starts[i]; track.set(b.pcm, Math.round(b.offset * sr)); });
  const mixWav = path.join(AUDIO, "voiceover.wav");
  fs.writeFileSync(mixWav, wavFile(track, sr));
  const mp4 = path.join(OUT, "chimera-rx-demo.mp4");
  const bin = path.join(os.tmpdir(), "crx-mux");
  execFileSync("swiftc", ["-O", "-suppress-warnings", path.join(ROOT, "scripts/demo/mux.swift"), "-o", bin], { stdio: "ignore" });
  const FPS = 25, t0 = v0 / 1000, lines = [];
  for (let k = 0, j = 0; k < Math.floor(total * FPS); k++) {
    const t = k / FPS;
    while (j + 1 < shots.length && shots[j + 1].t - t0 <= t) j++;
    lines.push(shots[j].file);
  }
  const manifest = path.join(vdir, "frames.txt");
  fs.writeFileSync(manifest, lines.join("\n"));
  log("muxing H.264 + AAC");
  log(execFileSync(bin, [manifest, String(FPS), mixWav, mp4], { encoding: "utf8" }).trim());
  fs.copyFileSync(shots[Math.min(shots.length - 1, shots.findIndex((x) => x.t - t0 > starts[1] + 4))].file, path.join(OUT, "poster-source.jpg"));
  // captions + poster
  fs.writeFileSync(path.join(OUT, "chimera-rx-demo.srt"), beats.map((b, i) => `${i + 1}\n${ts(b.offset)} --> ${ts(b.offset + b.dur)}\n${b.say}\n`).join("\n"));
  execFileSync("sips", ["-s", "format", "png", "--resampleHeightWidth", "720", "1280", path.join(OUT, "poster-source.jpg"), "--out", path.join(OUT, "poster.png")], { stdio: "ignore" });
  fs.rmSync(path.join(OUT, "poster-source.jpg"), { force: true });
  fs.rmSync(vdir, { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, "beats.json"), JSON.stringify({ voice: VOICE, rate: RATE, totalSeconds: total, beats: beats.map((b, i) => ({ n: i + 1, scheduled: b.sched, start: starts[i], audioOffset: b.offset, audioSeconds: b.dur })) }, null, 1));
  log("done", mp4);
} finally {
  if (browser) await browser.close().catch(() => {});
  cleanup();
}

// ---- helpers -------------------------------------------------------------------------------------------------------------
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function ts(s) { const ms = Math.round(s * 1000); const f = (n, w = 2) => String(n).padStart(w, "0"); return `${f(Math.floor(ms / 3600000))}:${f(Math.floor(ms / 60000) % 60)}:${f(Math.floor(ms / 1000) % 60)},${f(ms % 1000, 3)}`; }
function readWavPcm(file) {
  const b = fs.readFileSync(file); let o = 12;
  while (o + 8 <= b.length) { const id = b.toString("ascii", o, o + 4), sz = b.readUInt32LE(o + 4); if (id === "data") { const len = Math.min(sz, b.length - o - 8) & ~1; return new Int16Array(b.buffer.slice(b.byteOffset + o + 8, b.byteOffset + o + 8 + len)); } o += 8 + sz + (sz & 1); }
  throw new Error("no data chunk in " + file);
}
function wavFile(pcm, sr) {
  const h = Buffer.alloc(44), n = pcm.length * 2;
  h.write("RIFF", 0); h.writeUInt32LE(36 + n, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, n)]);
}
function terminalHtml(title, body) {
  return `<!doctype html><meta charset=utf-8><title>${title}</title><style>
body{margin:0;background:#14121f;color:#e8e6f5;font:15px/1.5 ui-monospace,Menlo,monospace}
.n{background:#fff7e6;color:#a15c00;text-align:center;font:12px/27px system-ui,sans-serif;border-bottom:1px solid #f0dcb4}
h1{font:600 20px system-ui,sans-serif;margin:26px 40px 8px}pre{margin:0 40px;white-space:pre-wrap;word-break:break-word}.c{color:#9d8bff}
footer{position:fixed;left:40px;bottom:80px;font:12px system-ui,sans-serif;color:#9a97b3}</style>
<div class=n>${NOTICE}</div><h1>${title}</h1><pre>${body}</pre><footer>${NOTICE}</footer>`;
}
/** Cursor dot and caption bar, injected into every document. The caption survives page loads through sessionStorage. */
function OVERLAY() {
  const make = () => {
    if (!document.body || document.getElementById("__cur")) return;
    const dot = document.createElement("div"); dot.id = "__cur";
    dot.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(108,76,255,.35);border:2px solid #6c4cff;z-index:2147483647;pointer-events:none;transition:transform .02s";
    const bar = document.createElement("div"); bar.id = "__capbar";
    bar.style.cssText = "position:fixed;left:50%;bottom:22px;transform:translateX(-50%);max-width:1100px;padding:10px 22px;border-radius:10px;background:rgba(20,18,31,.82);color:#fff;font:500 18px/1.3 system-ui,sans-serif;z-index:2147483646;pointer-events:none;text-align:center";
    document.body.append(dot, bar);
    const t = sessionStorage.getItem("__cap"); bar.textContent = t || ""; bar.style.display = t ? "block" : "none";
    const pos = sessionStorage.getItem("__pos"); if (pos) { const [x, y] = pos.split(","); dot.style.transform = `translate(${x}px,${y}px)`; }
  };
  window.addEventListener("mousemove", (e) => { make(); const d = document.getElementById("__cur"); if (d) d.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; sessionStorage.setItem("__pos", `${e.clientX},${e.clientY}`); }, true);
  document.addEventListener("DOMContentLoaded", make); if (document.readyState !== "loading") make();
  window.__cap = (t) => { make(); sessionStorage.setItem("__cap", t); const b = document.getElementById("__capbar"); if (b) { b.textContent = t; b.style.display = "block"; } };
  window.__capOff = () => { sessionStorage.removeItem("__cap"); document.getElementById("__capbar")?.remove(); document.getElementById("__cur")?.remove(); };
}
