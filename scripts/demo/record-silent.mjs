/**
 * Records the two SILENT screen recordings for the owner's own voiceover:
 *   pnpm demo:record:full   -> demo-video/chimera-rx-full-tour.mp4  (about 10 to 11 minutes, follows docs/DEMO_FULL.md)
 *   pnpm demo:record:cut    -> demo-video/chimera-rx-cut-3min.mp4   (about 3 minutes, follows docs/DEMO_CUT3.md)
 * Each run also writes <name>.cues.md (every beat with its timecode and the first words to read), <name>.chapters.txt
 * and <name>.json. There is no synthetic speech. Output is git-ignored. Synthetic data and sandboxes only.
 *
 * Pacing: every section has a time target taken from the script (its speech time at about 150 words a minute), and
 * every beat inside a section starts when its spoken paragraph starts. A caption bar names the screen and action, a
 * progress bar along the top shows the section letter, and a ring marks each clicked control for about a second.
 * Slow waits (OCR, bulk sends, role switches) are cut out of the picture (jump cuts); time codes are picture time.
 *
 * Own stack: API on DEMO_PORT (default 4580) with a temp DATA_DIR, LG_DEMO=1, LLM_PROVIDER=mock. Never ports 4000, 5173,
 * 5174. Env: DEMO_PORT, SKIP_BUILD=1, DEMO_ONLY=B5,B6 (record only those sections, for development), NOMUX=1.
 */
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { NOTICE, OVERLAY, esc, first, mmss, parseCut, parseFull, terminalHtml, words } from "./lib.mjs";

const MODE = (process.argv[2] ?? process.env.DEMO_MODE ?? "full").replace(/^--/, "");
if (!["full", "cut"].includes(MODE)) throw new Error("usage: record-silent.mjs full|cut");
const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "demo-video");
const NAME = MODE === "full" ? "chimera-rx-full-tour" : "chimera-rx-cut-3min";
const PORT = Number(process.env.DEMO_PORT ?? 4580);
const BASE = `http://localhost:${PORT}`;
const PW = "moonlight-rx-2026";
const ONLY = process.env.DEMO_ONLY ? new Set(process.env.DEMO_ONLY.split(",")) : null;
if ([4000, 5173, 5174].includes(PORT) || [4000, 5173, 5174].includes(PORT + 1)) throw new Error("port reserved for the live demo stack");
const WHO = { pharmacist: "j.rivera", technician: "k.patel", cashier: "m.diaz", admin: "s.grant" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[demo]", ...a);
fs.mkdirSync(OUT, { recursive: true });
const DOC = parseFull(path.join(ROOT, "docs/DEMO_FULL.md"));
const CUT = parseCut(path.join(ROOT, "docs/DEMO_CUT3.md"));
const WPS = 2.5; // 150 words a minute

// ---- section plans (target seconds of picture each) ---------------------------------------------------------------------
// Full: the script's own section windows (docs/DEMO_FULL.md headings), with extra time for the sections that show many paths.
const FULL = [
  ["A", "A", "The problem and the modernization story", 88], ["B1", "B", "Sign in and roles", 20], ["B2", "B", "Today", 21],
  ["B3", "B", "Receiving", 38], ["B4", "B", "Inventory", 15], ["B5", "B", "Fill & pickup, every path", 125], ["B6", "B", "Register", 15],
  ["B7", "B", "Patients", 12], ["B8", "B", "Refills", 19], ["B9", "B", "Recalls, end to end", 70], ["B10", "B", "Transfers and two stores", 13],
  ["C", "C", "How the AI agents work", 86], ["D", "D", "DSCSA and EPCIS", 16], ["E", "E", "Security and privacy", 53],
  ["F", "F", "How it was built with Kiro", 36], ["G", "G", "Integration and the future", 19], ["H", "H", "Close", 10]
];
// Cut: the windows of docs/DEMO_CUT3.md, each beat a little tighter than its time range so the total lands near 3:05.
const CUTP = [["1", "1", "The problem", 20], ["2", "2", "The recall", 28], ["3", "3", "Messages", 21], ["4", "4", "The counter", 30], ["5", "5", "The agents", 26],
  ["6", "6", "Security", 14], ["7", "7", "Built with Kiro", 25], ["8", "8", "Close", 16]];
const PLAN = (MODE === "full" ? FULL : CUTP).filter(([id]) => !ONLY || ONLY.has(id));
const LETTERS = MODE === "full" ? ["A", "B", "C", "D", "E", "F", "G", "H"] : ["1", "2", "3", "4", "5", "6", "7", "8"];

// ---- stack ----------------------------------------------------------------------------------------------------------------
if (process.env.SKIP_BUILD !== "1") { log("building web"); execFileSync("pnpm", ["build:web"], { cwd: ROOT, stdio: "ignore" }); }
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crx-silent-"));
const env = { ...process.env, API_PORT: String(PORT), DATA_DIR: dataDir, LG_DEMO: "1", LLM_PROVIDER: "mock", AGENTS_BACKGROUND: "1" };
const api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: path.join(ROOT, "apps/api"), env, stdio: "ignore" });
log("API pid", api.pid, "port", PORT, "data", dataDir);
let browser;
// Stand-in model for the Coroner moment only: an OpenAI-compatible endpoint on 127.0.0.1 that answers like a model that invents one lot.
// The real Coroner gate then drops it on camera (the offline mock never invents anything). The captions say "stand-in model".
const stub = http.createServer((req, res) => {
  req.resume(); req.on("end", () => {
    const content = JSON.stringify({ ndcs: [], lots: [{ value: "PRORX050925-1", expiry: "2027-09-30", confidence: 0.97 }, { value: "PRORX050925-3", expiry: "2027-09-30", confidence: 0.96 }, { value: "PRORX050925-7", expiry: "2027-09-30", confidence: 0.9 }], notes: "Three lots." });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "stub", object: "chat.completion", model: "stub-model", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }));
  });
}).listen(PORT + 1, "127.0.0.1");
const cleanup = () => { try { api.kill("SIGTERM"); } catch {} try { stub.close(); } catch {} };
process.on("exit", cleanup);

const failed = []; // beats that did not play as planned
const cues = []; // { t, id, caption, read }
const skips = []; // [wallStart, wallEnd] seconds, cut from the picture
let skipped = 0, v0 = 0;
const wall = () => (Date.now() - v0) / 1000;
const vnow = () => wall() - skipped;

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(500); if (i === 59) throw new Error("API did not start"); }
  browser = await chromium.launch();
  const vdir = path.join(os.tmpdir(), `crx-silent-frames-${Date.now()}`);
  fs.mkdirSync(vdir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(OVERLAY);
  const ctl = await browser.newContext({ viewport: { width: 1440, height: 900 } }); // control context, never recorded
  const apiLogin = (c, who = "pharmacist", storeId = "store-7", dom = "elmstreetrx.example", user) => c.request.post(`${BASE}/api/auth/login`, { data: { storeId, email: `${user ?? WHO[who]}@${dom}`, password: PW, trusted: true } });
  const ctlApi = async (method, url, data) => { const r = await ctl.request.fetch(`${BASE}${url}`, { method, data: data ?? {} }); return r.ok() ? r.json().catch(() => ({})) : { error: r.status(), body: await r.text() }; };
  await apiLogin(ctl); await ctlApi("POST", "/api/demo/reset"); await apiLogin(ctl);
  const labels = (await ctlApi("GET", "/api/demo/labels")).labels;
  const find = (lot, serial) => labels.find((l) => l.lot === lot && (!serial || l.serial === serial));
  const gs1 = (l, withSerial = true) => `(01)${l.gtin}(17)${l.expiry.replace(/-/g, "").slice(2, 8)}(10)${l.lot}${withSerial ? `(21)${l.serial}` : ""}`;

  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  const shots = []; let nShot = 0;
  cdp.on("Page.screencastFrame", (f) => {
    const file = path.join(vdir, `s${String(nShot++).padStart(6, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, "base64"));
    shots.push({ t: f.metadata.timestamp, file });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  p.on("pageerror", (e) => log("pageerror", e.message));
  await p.goto(`${BASE}/`); await p.waitForSelector("#email");
  v0 = Date.now();
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });

  // ---- primitives -----------------------------------------------------------------------------------------------------
  let cx = 720, cy = 450;
  const moveTo = async (x, y) => {
    const d = Math.hypot(x - cx, y - cy), n = Math.max(8, Math.min(30, Math.round(d / 22)));
    const x0 = cx, y0 = cy;
    for (let i = 1; i <= n; i++) { const t = i / n, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; await p.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e); await sleep(14); }
    cx = x; cy = y; await sleep(90);
  };
  const box = async (loc) => { const l = loc.first(); await l.waitFor({ timeout: 15000 }); await l.scrollIntoViewIfNeeded(); await sleep(60); return l.boundingBox(); };
  const hover = async (loc) => { const b = await box(loc); await moveTo(b.x + b.width / 2, b.y + Math.min(b.height / 2, 40)); return b; };
  const ring = (b) => p.evaluate(([x, y, w, h]) => window.__ring?.(x, y, w, h), [b.x, b.y, Math.min(b.width, 900), Math.min(b.height, 120)]).catch(() => {});
  const click = async (loc) => { const b = await hover(loc); void ring(b); await sleep(260); await p.mouse.down(); await sleep(60); await p.mouse.up(); await sleep(260); };
  const typeInto = async (loc, text, delay = 28) => { await click(loc); await p.keyboard.press("Meta+A"); await p.keyboard.type(text, { delay }); };
  const scroll = async (dy) => { const n = 10; for (let i = 0; i < n; i++) { await p.mouse.wheel(0, dy / n); await sleep(28); } await sleep(200); };
  const cap = (t) => p.evaluate((x) => window.__cap?.(x), t).catch(() => {});
  const tryHover = async (loc, ms = 800) => { try { await hover(loc); await sleep(ms); } catch { /* optional highlight */ } };
  const nav = (name) => click(p.locator("nav[aria-label='Main']").getByRole("link", { name, exact: false }).first());
  /** Cut a slow, uneventful wait out of the picture. */
  const skipWhile = async (fn) => { const a = wall(); try { return await fn(); } finally { const b = wall(); if (b - a > 0.5) { skips.push([a, b]); skipped += b - a; } } };
  /** Switch role off camera (jump cut): a session cookie for that role, then reload on the given hash route. */
  const as = (role, hash, opts = {}) => skipWhile(async () => {
    const r = await apiLogin(ctx, role, opts.storeId, opts.dom, opts.user);
    if (!r.ok()) throw new Error(`login ${role} ${r.status()}`);
    await p.goto(`${BASE}/#${hash}`); await p.reload();
    await p.waitForSelector("nav[aria-label='Main']", { timeout: 15000 });
    await sleep(900); await p.mouse.move(cx, cy);
  });
  const go = async (hash, sel) => { await p.goto(`${BASE}/#${hash}`); if (sel) await p.waitForSelector(sel, { timeout: 15000 }); await sleep(500); };
  const guard = async (label, fn) => { try { await fn(); } catch (e) { const m = String(e.message).split("\n")[0]; log(`FAILED ${label}: ${m}`); failed.push({ at: mmss(vnow()), label, error: m }); await p.screenshot({ path: path.join(OUT, `fail-${NAME}-${label.replace(/\W+/g, "_").slice(0, 40)}.png`) }).catch(() => {}); } };

  // ---- timeline -------------------------------------------------------------------------------------------------------
  let lastPi = 0, secIdx = 0, secStart = 0, secOffsets = [], curId = "", secTarget = 0;
  const until = async (t) => { const w = t - vnow(); if (w > 0 && !ONLY) await sleep(w * 1000); };
  /** Start of a beat inside a section: waits for its spoken paragraph to start, logs a cue, sets the caption. */
  const beat = async (caption, pi) => {
    let nowait = false; if (typeof pi === "string") { pi = Number(pi); nowait = true; }
    if (!nowait && pi !== undefined && secOffsets[pi] !== undefined && pi >= lastPi) { await until(secStart + secOffsets[pi]); lastPi = pi; }
    const spoken = MODE === "full" ? DOC[curId]?.[pi ?? -1] : CUT[curId]?.[pi ?? -1];
    const read = pi === undefined ? "(no new words: keep reading the paragraph you are on)" : spoken ? `"${first(spoken, 10)}..."` : "(no new words)";
    cues.push({ t: vnow(), id: curId, caption, read, pi });
    log(`${mmss(vnow())} ${curId} ${caption}`);
    await cap(caption);
  };
  const section = async ([id, letter, title, target], fn) => {
    curId = id; secTarget = target; secStart = vnow(); lastPi = 0;
    const n = MODE === "full" ? (DOC[id]?.length ?? 1) : (CUT[id]?.length ?? 1);
    // paragraph start offsets: proportional to their word counts, stretched to the section target
    const arr = MODE === "full" ? (DOC[id] ?? []) : (CUT[id] ?? []);
    const wc = arr.map((s) => words([s])), tot = wc.reduce((a, b) => a + b, 0) || 1;
    let acc = 0; secOffsets = wc.map((w) => { const o = (acc / tot) * target * 0.97; acc += w; return o; });
    void n;
    const label = MODE === "full" ? `${id} · ${title}` : `Beat ${id} · ${title}`;
    await p.evaluate(([l, i, t]) => window.__sec?.(l, i, t), [LETTERS, LETTERS.indexOf(letter), label]).catch(() => {});
    chapters.push({ t: vnow(), title: MODE === "full" ? `${id}. ${title}` : `Beat ${id}. ${title}` });
    log(`--- section ${id} at ${mmss(vnow())}, target ${target}s`);
    await guard(`section ${id}`, fn);
    const over = vnow() - (secStart + target);
    if (over > 1.5) log(`section ${id} ran ${over.toFixed(1)}s over its target`);
    await until(secStart + target);
    secLog.push({ id, start: secStart, target, actual: vnow() - secStart });
  };
  const chapters = [], secLog = [];

  // ---- recurring actions ----------------------------------------------------------------------------------------------
  const showText = async (t) => { await p.evaluate((x) => { const els = [...document.querySelectorAll("main *")].filter((e) => e.children.length === 0 && (e.textContent || "").includes(x)); els[0]?.scrollIntoView({ block: "center", behavior: "smooth" }); }, t); await sleep(900); };
  /** Click, and click again if the expected control has not appeared (a background refetch can swallow a click). */
  const clickUntil = async (loc, expect, tries = 3) => {
    for (let i = 0; i < tries; i++) { await click(loc); try { await expect.first().waitFor({ timeout: 2500 }); return; } catch { log("retry click"); } }
    throw new Error("control did not open after clicking");
  };
  const scanCode = async (raw) => {
    await typeInto(p.locator("#typed"), raw, 6);
    await click(p.getByRole("button", { name: "Check", exact: true }));
  };
  const openRx = (patient) => click(p.locator("section[aria-labelledby=queue] button").filter({ hasText: patient }).first());
  const terminal = async (title, body) => { termHtml = terminalHtml(title, body); await p.goto(`${BASE}/__demo/term?${Date.now()}`); await p.mouse.move(cx, cy); };
  let termHtml = "";
  await p.route("**/__demo/term*", (r) => r.fulfill({ contentType: "text/html", body: termHtml }));
  const standIn = async (on) => { await apiLogin(ctl); const r = await ctlApi("POST", "/api/agents/provider", on ? { provider: "openai-compatible", model: "stub-model", baseUrl: `http://127.0.0.1:${PORT + 1}/v1` } : { provider: "mock" }); if (r?.error) throw new Error(`stand-in provider switch failed ${r.error}`); };
  const errText = () => p.locator("[role=alert], .err, .error").first().innerText().catch(() => "");
  const readRepoFile = (f, n) => fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").slice(0, n).join("\n");

  // ---- the sections ---------------------------------------------------------------------------------------------------
  const S = {};

  S.A = async () => {
    await p.goto(BASE); await p.waitForSelector("#email"); await p.mouse.move(cx, cy);
    await beat("Sign in · the demo notice stays on every screen", 0);
    await tryHover(p.getByText(/Demo environment/), 2500);
    await beat("Sign in · pick the pharmacy", 1);
    await tryHover(p.locator("#store"), 1800); await moveTo(300, 520);
    await beat("Sign in · demo accounts", 2);
    await tryHover(p.locator("#email"), 1500); await tryHover(p.locator("#pw"), 1500);
    await beat("Sign in · badge tap or password", 3);
    await tryHover(p.getByRole("button", { name: /badge|SSO/i }), 1500);
    await beat("Sign in · one ledger for the pharmacy", 4);
    await moveTo(720, 600);
  };
  S.B1 = async () => {
    await beat("Sign in · pharmacist account", 0);
    await typeInto(p.locator("#email"), "j.rivera@elmstreetrx.example", 30); await typeInto(p.locator("#pw"), PW, 30);
    await click(p.getByRole("button", { name: "Sign in", exact: true }).first());
    await p.waitForSelector("nav[aria-label='Main']", { timeout: 15000 });
    await beat("Sidebar · Operations, Care, AI, Admin, Demo");
    for (const g of ["Operations", "Care", "AI", "Admin", "Demo"]) await tryHover(p.locator("nav[aria-label='Main'] .nav-label", { hasText: g }), 700);
  };
  S.B2 = async () => {
    await as("pharmacist", "/");
    await beat("Today · the recall banner", 0);
    await tryHover(p.getByText(/Recall fax received/), 1500);
    await beat("Today · Rx Guardian suggestions");
    await tryHover(p.getByText("Rx Guardian suggestions").first(), 1700);
    await beat("Today · tiles, queue, expiring lots");
    await scroll(300); await sleep(1500); await scroll(300); await sleep(1500);
    await beat("Today · search box scans a package");
    await scroll(-900); await tryHover(p.getByRole("searchbox").first().or(p.locator("input[type=search]").first()), 1200);
  };
  S.B3 = async () => {
    await as("technician", "/receiving");
    await beat("Receiving · technician · delivery ASH-1105-07", 0);
    await tryHover(p.getByText(/Invoice ASH-1105-07/), 1400);
    const amox = find("AMX0926B", "10443850");
    await beat("Receiving · scan a package · four checks run");
    await scanCode(gs1(amox));
    await p.waitForSelector("text=Transaction information verified", { timeout: 15000 });
    await sleep(1600); await scroll(250); await sleep(900);
    await beat("Receiving · put-away at the suggested spot");
    await click(p.getByRole("button", { name: "Confirm put-away" })); await sleep(1500);
    await beat("Receiving · failed check · serial not in the supplier record");
    const bad = { ...find("OX25L072"), serial: "99999999" };
    await scanCode(gs1(bad));
    await p.waitForSelector("text=not in the supplier", { timeout: 15000 });
    await sleep(1500);
    await beat("Receiving · report a problem · suspect product · quarantine");
    await click(p.getByRole("button", { name: "Report a problem" }));
    await click(p.getByRole("radio", { name: "Suspect product" }));
    await click(p.getByRole("button", { name: "Quarantine & log problem" }));
    await p.waitForSelector("text=Problem logged", { timeout: 8000 }); await sleep(1300);
  };
  S.B4 = async () => {
    await as("pharmacist", "/inventory");
    await beat("Inventory · filter chips by lot", 0);
    for (const n of [/Expiring/, /Refrigerated/, /Controlled/]) await click(p.getByRole("button", { name: n }).first());
    await click(p.getByRole("button", { name: /All lots/ }).first());
    await beat("Inventory · lot history, Move location, Adjust count");
    await click(p.locator("tbody tr button").first()); await sleep(900);
    await tryHover(p.getByRole("button", { name: "Move location" }), 700); await tryHover(p.getByRole("button", { name: "Adjust count" }), 900);
  };

  S.B5 = async () => {
    await as("pharmacist", "/fill");
    await beat("Fill & pickup · the queue and its status chips", 0);
    await tryHover(p.locator("section[aria-labelledby=queue] h2"), 900); await scroll(0);
    await beat("Fill & pickup · flagged order · Rx Watcher findings", 0);
    await openRx("Daniel Brooks");
    await p.waitForSelector("text=Rx Watcher", { timeout: 10000 });
    await tryHover(p.getByText(/Unusual frequency/).first(), 1700);
    await beat("Fill & pickup · flagged order · Reject with a reason");
    await click(p.getByRole("button", { name: "Reject…" }));
    await typeInto(p.locator("#dec-reason"), "Directions need the prescriber first", 18);
    await click(p.getByRole("button", { name: "Reject order" })); await sleep(1200);
    await tryHover(p.getByText("Rejected").first(), 1200);
    await skipWhile(async () => {
      await ctlApi("POST", "/api/demo/reset"); await apiLogin(ctl);
      // the Guardian runs within a minute on its own; run it now so the suggestions are there when the beat starts
      for (let i = 0; i < 20; i++) { await ctlApi("POST", "/api/agents/rx-guardian/run-now"); const q = await ctlApi("GET", "/api/rx"); if (Array.isArray(q) && q.find((x) => x.rx === "0072210")?.suggestions > 0) break; await sleep(1000); }
    });
    await as("pharmacist", "/fill?rx=0072210");
    await openRx("Daniel Brooks"); await p.waitForSelector("text=Rx Watcher");
    await beat("Fill & pickup · flagged order again (demo reset) · Approve as written with a reason");
    await click(p.getByRole("button", { name: /Approve as written/ }));
    await typeInto(p.locator("#dec-reason"), "Prescriber confirmed by phone, sandbox note", 18);
    await click(p.getByRole("button", { name: /^Approve as/ }).last()); await sleep(1400);

    await beat("Rx Guardian · evidence from the patient's history", 1);
    await tryHover(p.getByText("Evidence from the history").first(), 1500);
    const cards = p.locator("section[aria-label='Rx Guardian suggestions'] article");
    await beat("Rx Guardian · suggestion · Dismiss with a reason");
    await clickUntil(cards.nth(0).getByRole("button", { name: "Dismiss…" }), p.getByLabel("Reason for dismissing"));
    await typeInto(p.getByLabel("Reason for dismissing"), "Dose was changed on purpose", 18);
    await click(p.getByRole("button", { name: "Dismiss", exact: true }).first()); await sleep(1200);
    await beat("Rx Guardian · suggestion · Accept: hold the order");
    await clickUntil(p.getByRole("button", { name: "Accept: hold the order" }).first(), p.getByRole("button", { name: "Put order on hold" }));
    await click(p.getByRole("button", { name: "Put order on hold" })); await sleep(1500);
    await beat("Rx Guardian · suggestion · send a prescriber change request (sandbox)");
    await click(p.getByRole("button", { name: "Send prescriber change request" }).first()); await sleep(1500);
    await tryHover(p.getByText(/Waiting for Dr/).first(), 1200);
    await beat("Prescriber approves (sandbox) · a new version is created and checked again");
    await click(p.getByRole("button", { name: "Prescriber approved" }));
    await p.waitForSelector("text=Rx 0072210-R1", { timeout: 8000 }); await sleep(1200);

    await beat("Fill & pickup · wrong drug is refused", 2);
    await go("/fill?rx=0072214", "text=Linda Chen");
    await scanCode(gs1(find("GX4471C", "0000907")));
    await p.waitForSelector("text=Wrong drug", { timeout: 8000 }); await showText("Wrong drug"); await sleep(1500);
    await beat("Fill & pickup · scan without a serial · the serial is assumed, not read");
    await go("/fill?rx=0072210-R1", "text=Daniel Brooks");
    await scanCode(gs1(find("GX4471C", "0000907"), false));
    await p.waitForSelector("text=No serial was scanned", { timeout: 8000 }); await sleep(1700);
    await beat("Fill & pickup · send back · return to stock with a reason");
    await click(p.getByRole("button", { name: "Send back" }).first());
    await typeInto(p.getByLabel("Reason to send back"), "Rescan with the real serial", 18);
    await click(p.getByRole("button", { name: "Send back" }).last()); await sleep(1300);
    await beat("Fill & pickup · scan with a serial · the exact package is matched");
    await scanCode(gs1(find("GX4471C", "0000907")));
    await p.waitForSelector("text=Print label", { timeout: 8000 }); await sleep(1700);

    await beat("Fill & pickup · print label, send to the pharmacist", 3);
    await click(p.getByRole("button", { name: /Print label/ })); await sleep(1200);
    await beat("Fill & pickup · pharmacist verifies (four boxes)");
    await p.waitForSelector("text=Pharmacist check");
    for (const l of await p.locator("main li label").all()) await click(l);
    await click(p.getByRole("button", { name: /^Approve as/ })); await sleep(1200);
    await beat("Pickup · cashier · ID, counseling, signature, hand-over");
    await as("cashier", "/fill?rx=0072210-R1");
    await p.waitForSelector("text=Pickup at register 2");
    for (const l of await p.locator("main label:has(input[type=checkbox])").all()) await click(l);
    await click(p.getByRole("button", { name: "Complete sale" })); await p.waitForSelector("text=/Sold to/", { timeout: 8000 }); await sleep(1500);
    await beat("Cashier view · no birth date, no allergies, no review panels");
    await go("/fill?rx=0072187", "text=Grace Miller"); await sleep(1800);
  };

  S.B6 = async () => {
    await as("cashier", "/register");
    await beat("Register · one sale: an over-the-counter item and a prescription", 0);
    await click(p.getByRole("button", { name: /Acetaminophen/ }));
    await typeInto(p.locator("#pq"), "Miller", 30);
    await click(p.getByRole("button", { name: /Grace Miller/ })); await sleep(500);
    await click(p.locator("main label:has(input[type=checkbox])").first());
    await beat("Register · pickup checks · Mark paid is a label, no payment");
    for (const l of (await p.locator("main label:has(input[type=checkbox])").all()).slice(1)) await tryHover(l, 200);
    await click(p.getByRole("button", { name: "Mark paid and print receipt" })); await sleep(1500);
  };
  S.B7 = async () => {
    await as("pharmacist", "/patients");
    await beat("Patients · find a patient", 0);
    await typeInto(p.locator("#psearch"), "Brooks", 40);
    await click(p.getByRole("button", { name: "Search" })); await click(p.getByRole("button", { name: /Daniel Brooks/ }).first());
    await beat("Patients · open a profile · a reason is required and audited");
    await click(p.getByRole("button", { name: "Dispensing" })); await click(p.getByRole("button", { name: "Open profile" }));
    await p.waitForSelector("text=Medication history", { timeout: 8000 }).catch(() => {});
    await sleep(900); await scroll(350); await sleep(900);
  };
  S.B8 = async () => {
    await as("pharmacist", "/demo");
    await beat("Demo guide · scenario · Recall-aware refill", 0);
    await click(p.getByRole("button", { name: /Recall-aware refill/ })); await skipWhile(() => sleep(2000)); // the scenario resets the demo and signs everyone out: cut that out
    await as("pharmacist", "/refills");
    await p.waitForSelector("text=Refill worklist");
    await beat("Refills · worklist, adherence, medication sync");
    await tryHover(p.getByText("Refill worklist").first(), 1300); await scroll(350); await sleep(1500);
    await beat("Refills · Draft reminders · a pharmacist approves and sends");
    await click(p.getByRole("button", { name: "Draft reminders" })); await sleep(2000);
  };
  S.B9 = async () => {
    await as("pharmacist", "/recalls");
    await beat("Recalls · fax inbox · read the fax with OCR", 0);
    await p.waitForSelector("text=Fax inbox");
    await click(p.getByRole("button", { name: "Read this fax with OCR" }));
    await skipWhile(() => p.waitForSelector("text=Already with patients", { timeout: 120000 }));
    await tryHover(p.getByText("Lots read from the notice"), 1200);
    await beat("Coroner · stand-in model invents a lot · the gate drops it (verbatim check)");
    await standIn(true);
    await nav("AI agents"); await p.waitForSelector("article[aria-label='Coroner']");
    await click(p.locator("article[aria-label='Coroner']").getByRole("button", { name: "Run with sample input" }));
    await p.waitForSelector("text=What the gate dropped", { timeout: 20000 });
    await tryHover(p.getByText("What the gate dropped"), 600); await scroll(250); await sleep(1500);
    await standIn(false);
    await beat("Recalls · impact · exact units quarantined, patients by consent channel", 1);
    await nav("Recalls"); await p.waitForSelector("text=Already with patients", { timeout: 15000 });
    await tryHover(p.getByText("197 units").first(), 1200); await tryHover(p.getByText(/by text/).first(), 1200);
    await beat("Recalls · patient messages · use the AI draft · attest · send");
    await click(p.getByRole("button", { name: "Continue to patient messages" }));
    await p.waitForSelector("text=Text message", { timeout: 15000 });
    await click(p.getByRole("button", { name: "Use AI draft" })); await sleep(1500);
    await click(p.getByLabel(/I am the pharmacist/));
    await click(p.getByRole("button", { name: /^Start \d+ calls/ }));
    await skipWhile(() => p.waitForSelector("text=Patients contacted for recall", { timeout: 60000 }));
    await sleep(1200); await scroll(300); await sleep(900);
    await beat("Recalls · close this recall (the lots stay blocked at receiving and fill)");
    await click(p.getByRole("button", { name: "Close this recall" })); await sleep(1300);
    await beat("Sandbox outbox · every message the demo sends stays here");
    await as("pharmacist", "/outbox"); await sleep(1500); await scroll(250); await sleep(900);
    await beat("Class I insulin recall D-0611-2026 (looked up before this beat, off camera)", 2);
    await skipWhile(async () => { await apiLogin(ctl); const lk = await ctlApi("POST", "/api/recalls/lookup", { number: "D-0611-2026" }); log("lookup", JSON.stringify(lk).slice(0, 80)); });
    await as("pharmacist", "/refills");
    await beat("Refills · the recall-hold row is red, no reminder goes out");
    await p.waitForSelector("text=Recall hold", { timeout: 15000 }); await tryHover(p.getByText("Recall hold").first(), 1800);
    await beat("Fill & pickup · recalled lot refused at the counter");
    await go("/fill?rx=0072210", "text=Daniel Brooks");
    await click(p.getByRole("button", { name: /Approve as written/ }));
    await typeInto(p.locator("#dec-reason"), "Confirmed with prescriber, sandbox", 14);
    await click(p.getByRole("button", { name: /^Approve as/ }).last()); await sleep(1000);
    await scanCode(gs1(find("GX4471C", "0000907")));
    await p.waitForSelector("text=Recalled lot", { timeout: 8000 }); await showText("Recalled lot"); await sleep(2000);
  };
  S.B10 = async () => {
    await as("pharmacist", "/transfers");
    await beat("Transfers · move packages to Store 2, lot and serial stay", 0);
    await click(p.locator("#lot")); await p.locator("#lot").selectOption({ index: 5 }); await sleep(500);
    await typeInto(p.locator("#qty"), "1", 40);
    await click(p.getByRole("button", { name: "Move stock" })); await sleep(1200);
    await beat("Store 2 · the second pharmacy has its own login and its own audit log");
    await as("pharmacist", "/inventory", { storeId: "store-2", dom: "birchavenuerx.example", user: "s.okoro" });
    await sleep(1200);
  };

  S.C = async () => {
    await as("pharmacist", "/agents");
    await p.waitForSelector("section[aria-label='Provider']");
    await beat("AI agents · eight agents, one pattern", 0);
    await tryHover(p.locator("section[aria-label='Agents']"), 1500); await scroll(300); await sleep(1200); await scroll(-300);
    await beat("Rx Guardian · rules read the history, the model explains, a gate checks", 1);
    const g = p.getByRole("group", { name: "Rx Guardian background mode" });
    await g.scrollIntoViewIfNeeded(); await tryHover(g, 1200);
    await click(g.getByRole("button", { name: "Run now" })); await sleep(1500);
    await beat("Rx Guardian · suggestions tab · evidence for each one");
    await click(p.getByRole("tab", { name: /Suggestions/ })); await sleep(1800); await scroll(300); await sleep(1500);
    await click(p.getByRole("tab", { name: /Agents/ }));
    await beat("Background agents · switch on or off · last run, next run", 2);
    await g.scrollIntoViewIfNeeded(); await tryHover(g.getByRole("switch"), 2200);
    await beat("Provider · Bedrock by default, bring your own model, or rules only", 3);
    await p.locator("section[aria-label='Provider']").scrollIntoViewIfNeeded();
    await tryHover(p.locator("section[aria-label='Provider'] select"), 1800);
    await click(p.getByRole("button", { name: "Test connection" })); await sleep(1800);
    await beat("Coroner · stand-in model · the gate drops an invented lot", 4);
    await standIn(true);
    await click(p.locator("article[aria-label='Coroner']").getByRole("button", { name: "Run with sample input" }));
    await p.waitForSelector("text=What the gate dropped", { timeout: 20000 });
    await sleep(1800); await standIn(false);
    await beat("Recent runs · each run keeps its dropped list · guardrails");
    await tryHover(p.locator("section[aria-label='Recent runs']"), 1800);
    await tryHover(p.getByRole("button", { name: "Guardrails" }).first(), 1500);
  };
  S.D = async () => {
    await as("pharmacist", "/dscsa");
    await beat("DSCSA & trace · EPCIS 2.0 export from the ledger", 0);
    await click(p.getByRole("button", { name: "Preview" })); await sleep(1200); await scroll(200);
    await beat("DSCSA & trace · sandbox verifier · suspect product cases");
    await click(p.getByRole("button", { name: "Ask the sandbox verifier" })); await sleep(1800);
  };
  S.E = async () => {
    const keys = (() => { try { return execFileSync("pnpm", ["--filter", "@chimera-rx/api", "keys:status"], { cwd: ROOT, env, encoding: "utf8" }); } catch (e) { return String(e.stdout ?? e.message); } })();
    const verify = await (await ctl.request.get(`${BASE}/api/audit/verify`)).text();
    const sec = fs.readFileSync(path.join(ROOT, "docs/SECURITY.md"), "utf8").split("\n");
    const notCovered = sec.findIndex((l) => /not covered/i.test(l));
    await beat("Security · encrypted fields, key rotation, hash-chained audit log", 0);
    await terminal("Encryption and audit log", `<span class=c>$ pnpm --filter @chimera-rx/api keys:status</span>\n${esc(keys.split("\n").filter((l) => l.trim() && !/^>|^\s*$/.test(l)).join("\n"))}\n\n<span class=c>$ curl -s /api/audit/verify</span>\n${esc(verify)}\n\n<span class=c>$ grep -n "Audit log" docs/SECURITY.md</span>\n${esc(sec.filter((l) => /Audit log/.test(l)).join("\n").slice(0, 500))}`);
    await sleep(2000);
    await beat("Security · what is not covered, said plainly", 1);
    await terminal("What is not covered (docs/SECURITY.md)", `<span class=c>$ sed -n '${notCovered + 1},+16p' docs/SECURITY.md</span>\n${esc(sec.slice(Math.max(0, notCovered), notCovered + 18).join("\n"))}`);
    await sleep(2000);
  };
  S.F = async () => {
    const ls = fs.readdirSync(path.join(ROOT, ".kiro")).join("   ");
    const steer = fs.readdirSync(path.join(ROOT, ".kiro/steering")).filter((f) => !f.startsWith("aidlc")).join("   ");
    const specs = fs.readdirSync(path.join(ROOT, ".kiro/specs/coroner")).join("   ");
    const safety = readRepoFile(".kiro/steering/pharmacy-safety.md", 18);
    const req = fs.readFileSync(path.join(ROOT, ".kiro/specs/coroner/requirements.md"), "utf8").split("\n").filter((l) => /COR-3/.test(l)).slice(0, 3).join("\n");
    const hooks = fs.readdirSync(path.join(ROOT, ".kiro/hooks")).join("   ");
    await beat("Built with Kiro · steering: the safety rules that always load", 0);
    await terminal("Built with Kiro: steering", `<span class=c>$ ls .kiro</span>\n${esc(ls)}\n\n<span class=c>$ ls .kiro/steering</span>\n${esc(steer)}\n\n<span class=c>$ head -18 .kiro/steering/pharmacy-safety.md</span>\n${esc(safety)}`);
    await sleep(1500);
    await beat("Built with Kiro · specs and the requirement id that appears in a test");
    await terminal("Built with Kiro: specs", `<span class=c>$ ls .kiro/specs/coroner</span>\n${esc(specs)}\n\n<span class=c>$ grep -n "COR-3" .kiro/specs/coroner/requirements.md</span>\n${esc(req || "(see requirements.md)")}\n\n<span class=c>$ ls .kiro/hooks</span>\n${esc(hooks)}\n\n<span class=c>$ cat .kiro/hooks/phi-guard.json | head -12</span>\n${esc(readRepoFile(".kiro/hooks/phi-guard.json", 12))}`);
    await sleep(2000);
    await beat("Built with Kiro · AI-DLC record and an honest account of what was and was not used", 1);
    await terminal("docs/KIRO_USAGE.md", `<span class=c>$ head -30 docs/KIRO_USAGE.md</span>\n${esc(readRepoFile("docs/KIRO_USAGE.md", 30))}`);
    await sleep(1500);
  };
  S.G = async () => {
    await as("admin", "/integrations");
    await p.waitForSelector("text=Connected partners");
    await beat("Integrations · connected partners and scopes", 0);
    await tryHover(p.getByText("Connected partners").first(), 1300);
    await beat("Integrations · live MCP call");
    await click(p.getByRole("tab", { name: "MCP server" }));
    await click(p.getByRole("button", { name: /Rotate int-rx-concierge and fill in/ }));
    await click(p.getByRole("button", { name: "Send request" })); await sleep(1800);
  };
  S.H = async () => {
    await as("pharmacist", "/");
    await beat("Chimera Rx · one ledger, agents in the background, a pharmacist decides", 0);
    await tryHover(p.getByText(/Recall fax received/), 2500);
  };

  // ---- cut: the same actions, tighter, in the order of docs/DEMO_CUT3.md --------------------------------------------------
  const K = {};
  K["1"] = async () => {
    await p.goto(BASE); await p.waitForSelector("#email"); await p.mouse.move(cx, cy);
    await beat("Sign in · the demo notice is on every screen", 0);
    await tryHover(p.getByText(/Demo environment/), 1800);
    await beat("Sign in · pharmacist");
    await typeInto(p.locator("#email"), "j.rivera@elmstreetrx.example", 12); await typeInto(p.locator("#pw"), PW, 12);
    await click(p.getByRole("button", { name: "Sign in", exact: true }).first());
    await p.waitForSelector("text=Recall fax received", { timeout: 15000 });
    await beat("Today · the recall banner and the Guardian card", 4);
    await tryHover(p.getByText(/Recall fax received/), 1800);
  };
  K["2"] = async () => {
    await beat("Recalls · read the fax with OCR", 0);
    await nav("Recalls"); await p.waitForSelector("text=Fax inbox");
    await click(p.getByRole("button", { name: "Read this fax with OCR" }));
    await skipWhile(() => p.waitForSelector("text=Already with patients", { timeout: 120000 }));
    await beat("Recalls · lots read from the notice, verbatim", 2);
    await tryHover(p.getByText("Lots read from the notice"), 1800);
    await beat("Recalls · impact · units quarantined, patients by channel", 4);
    await tryHover(p.getByText("197 units").first(), 1500); await tryHover(p.getByText(/by text/).first(), 1500);
  };
  K["3"] = async () => {
    await beat("Messages · AI draft, pharmacist attests and sends", 0);
    await click(p.getByRole("button", { name: "Continue to patient messages" }));
    await p.waitForSelector("text=Text message", { timeout: 15000 });
    await click(p.getByRole("button", { name: "Use AI draft" })); await sleep(900);
    await click(p.getByLabel(/I am the pharmacist/));
    await click(p.getByRole("button", { name: /^Start \d+ calls/ }));
    await skipWhile(() => p.waitForSelector("text=Patients contacted for recall", { timeout: 60000 }));
    await beat("Sandbox outbox · nothing leaves this laptop", 5);
    await as("pharmacist", "/outbox"); await sleep(1500); await scroll(250); await sleep(1000);
  };
  K["4"] = async () => {
    await skipWhile(async () => { await apiLogin(ctl); await ctlApi("POST", "/api/recalls/lookup", { number: "D-0611-2026" }); }); // the Class I insulin recall is already open
    await as("pharmacist", "/fill?rx=0072210");
    await beat("Fill & pickup · Rx Watcher flags the insulin order", 1);
    await p.waitForSelector("text=Rx Watcher"); await tryHover(p.getByText(/Unusual frequency/).first(), 1300);
    await beat("Pharmacist approves with a reason · a recalled lot is refused at the counter (the lot is in an open recall)");
    await click(p.getByRole("button", { name: /Approve as written/ }));
    await typeInto(p.locator("#dec-reason"), "Confirmed with prescriber, sandbox", 8);
    await click(p.getByRole("button", { name: /^Approve as/ }).last()); await sleep(600);
    await scanCode(gs1(find("GX4471C", "0000907")));
    await p.waitForSelector("text=Recalled lot", { timeout: 8000 }); await showText("Recalled lot"); await sleep(1500);
    await beat("Rx Guardian · evidence from the history · Accept: hold the order", 2);
    await tryHover(p.getByText("Evidence from the history").first(), 1200);
    await clickUntil(p.getByRole("button", { name: "Accept: hold the order" }).first(), p.getByRole("button", { name: "Put order on hold" }));
    await click(p.getByRole("button", { name: "Put order on hold" })); await sleep(900);
    await beat("Fill & pickup · scan without a serial · the serial is assumed", 4);
    await go("/fill?rx=0072214", "text=Linda Chen");
    await scanCode(gs1(find("AT24K118", "24118006"), false));
    await p.waitForSelector("text=No serial was scanned", { timeout: 8000 }); await sleep(1200);
  };
  K["5"] = async () => {
    await as("pharmacist", "/agents");
    await beat("AI agents · provider card, Rx Guardian background mode", 0);
    await p.waitForSelector("section[aria-label='Provider']");
    await tryHover(p.locator("section[aria-label='Provider']"), 1200);
    const g = p.getByRole("group", { name: "Rx Guardian background mode" }); await g.scrollIntoViewIfNeeded(); await tryHover(g, 1500);
    await beat("Coroner · stand-in model · the gate drops an invented lot", "8");
    await standIn(true);
    await click(p.locator("article[aria-label='Coroner']").getByRole("button", { name: "Run with sample input" }));
    await p.waitForSelector("text=What the gate dropped", { timeout: 20000 });
    await tryHover(p.getByText("What the gate dropped"), 600); await scroll(200); await sleep(2200); await standIn(false);
  };
  K["6"] = async () => {
    const keys = (() => { try { return execFileSync("pnpm", ["--filter", "@chimera-rx/api", "keys:status"], { cwd: ROOT, env, encoding: "utf8" }); } catch (e) { return String(e.stdout ?? e.message); } })();
    const verify = await (await ctl.request.get(`${BASE}/api/audit/verify`)).text();
    const sec = fs.readFileSync(path.join(ROOT, "docs/SECURITY.md"), "utf8").split("\n");
    await beat("Security · encrypted fields, hash-chained audit log, what is not covered", 0);
    await terminal("Encryption, audit log and what is not covered", `<span class=c>$ pnpm --filter @chimera-rx/api keys:status</span>\n${esc(keys.split("\n").filter((l) => l.trim() && !/^>|^\s*$/.test(l)).join("\n"))}\n\n<span class=c>$ curl -s /api/audit/verify</span>\n${esc(verify)}\n\n<span class=c>$ grep -n "not covered" -i -A8 docs/SECURITY.md</span>\n${esc(sec.slice(Math.max(0, sec.findIndex((l) => /not covered/i.test(l))), sec.findIndex((l) => /not covered/i.test(l)) + 9).join("\n"))}`);
    await sleep(1500);
  };
  K["7"] = async () => {
    const steer = readRepoFile(".kiro/steering/pharmacy-safety.md", 12);
    const req = fs.readFileSync(path.join(ROOT, ".kiro/specs/coroner/requirements.md"), "utf8").split("\n").filter((l) => /COR-3/.test(l)).slice(0, 2).join("\n");
    await beat("Built with Kiro · steering, specs, hooks", 1);
    await terminal("Built with Kiro", `<span class=c>$ ls .kiro</span>\n${esc(fs.readdirSync(path.join(ROOT, ".kiro")).join("   "))}\n\n<span class=c>$ head -12 .kiro/steering/pharmacy-safety.md</span>\n${esc(steer)}\n\n<span class=c>$ grep -n COR-3 .kiro/specs/coroner/requirements.md</span>\n${esc(req)}\n\n<span class=c>$ ls .kiro/hooks</span>\n${esc(fs.readdirSync(path.join(ROOT, ".kiro/hooks")).join("   "))}`);
    await sleep(1500);
    await beat("Built with Kiro · docs/KIRO_USAGE.md, said plainly", 5);
    await terminal("docs/KIRO_USAGE.md", `<span class=c>$ head -26 docs/KIRO_USAGE.md</span>\n${esc(readRepoFile("docs/KIRO_USAGE.md", 26))}`);
    await sleep(1200);
  };
  K["8"] = async () => {
    await as("pharmacist", "/integrations");
    await p.waitForSelector("text=Connected partners");
    await beat("Integrations · REST, MCP, FHIR, webhooks, EPCIS", 0);
    await click(p.getByRole("tab", { name: "MCP server" }));
    await beat("Close · back to Today", "2");
    await nav("Today"); await tryHover(p.getByText(/Recall fax received/), 1000);
  };

  // ---- run ------------------------------------------------------------------------------------------------------------
  for (const row of PLAN) {
    const fn = (MODE === "full" ? S : K)[row[0]];
    if (!fn) { log("no actions for", row[0]); continue; }
    await section(row, fn);
  }
  await sleep(1500);
  await p.evaluate(() => window.__capOff?.()).catch(() => {});
  const wallTotal = wall();
  await cdp.send("Page.stopScreencast").catch(() => {});
  await ctx.close(); await ctl.close();
  await browser.close(); browser = null;
  const total = wallTotal - skipped;
  log(`recorded ${wallTotal.toFixed(1)}s wall, ${total.toFixed(1)}s picture, ${skips.length} cuts, ${shots.length} frames`);

  // ---- frames: constant 25 fps from the screencast timestamps, minus the cut windows ---------------------------------------
  const FPS = 25, t0 = v0 / 1000;
  const cutsV = []; { let acc = 0; for (const [a, b] of skips) { cutsV.push({ vs: a - acc, len: b - a }); acc += b - a; } }
  const lines = [];
  for (let k = 0, j = 0; k < Math.floor(total * FPS); k++) {
    const tv = k / FPS; let w = tv; for (const c of cutsV) if (c.vs <= tv) w += c.len;
    while (j + 1 < shots.length && shots[j + 1].t - t0 <= w) j++;
    lines.push(shots[j].file);
  }
  const manifest = path.join(vdir, "frames.txt");
  fs.writeFileSync(manifest, lines.join("\n"));
  const writeCues = () => {
    if (!ONLY) {
      // ---- cues, chapters, json -------------------------------------------------------------------------------------------
      const tc = (s) => mmss(s);
      const md = [`# ${NAME}: cues for your voiceover`, "", `Silent video, ${tc(total)} long. Read the script section named on each line when its time code arrives. Time codes are picture time (slow waits are cut out of the picture).`,
        MODE === "full" ? "Script: docs/DEMO_FULL.md. Spoken paragraphs are the quoted blocks under each heading." : "Script: docs/DEMO_CUT3.md. Each beat has one spoken block.", "",
        "| Time | Section | On screen | Read now |", "| --- | --- | --- | --- |",
        ...cues.map((c) => `| ${tc(c.t)} | ${c.id} | ${c.caption} | ${c.read} |`), ""].join("\n");
      fs.writeFileSync(path.join(OUT, `${NAME}.cues.md`), md);
      fs.writeFileSync(path.join(OUT, `${NAME}.chapters.txt`), chapters.map((c) => `${tc(c.t)} ${c.title}`).join("\n") + "\n");
      fs.writeFileSync(path.join(OUT, `${NAME}.json`), JSON.stringify({ mode: MODE, pictureSeconds: total, wallSeconds: wallTotal, cuts: skips.length, cutSeconds: skipped, sections: secLog, cues, failed }, null, 1));
    }
  };
  if (process.env.NOMUX === "1") { log("NOMUX: frames kept in", vdir); writeCues(); }
  else {
    const mp4 = path.join(OUT, `${NAME}.mp4`);
    const bin = path.join(os.tmpdir(), "crx-mux");
    execFileSync("swiftc", ["-O", "-suppress-warnings", path.join(ROOT, "scripts/demo/mux.swift"), "-o", bin], { stdio: "ignore" });
    log("muxing H.264, no audio track");
    log(execFileSync(bin, [manifest, String(FPS), "none", mp4], { encoding: "utf8" }).trim());
    writeCues();
    log("done", mp4, `${mmss(total)}`);
  }
  if (!process.env.KEEP_FRAMES && process.env.NOMUX !== "1") fs.rmSync(vdir, { recursive: true, force: true });
  log("failed beats:", failed.length ? JSON.stringify(failed) : "none");
} finally {
  if (browser) await browser.close().catch(() => {});
  cleanup();
}
