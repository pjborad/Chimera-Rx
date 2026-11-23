/**
 * Submission video (under 3:00): audio first, then the screen follows the audio.
 *   1. .venv-voice/bin/python scripts/demo/make-voice.py full   (two voices, VOICE_A / VOICE_B; docs/DEMO_VIDEO_SCRIPT.md -> timeline.json, voice.wav)
 *   2. this script starts its own stack on ports 4690-4693, records one step per narration unit, composes the picture onto the
 *      audio time axis and writes demo-video/chimera-rx-submission.mp4 (1920x1080, H.264 + AAC) and .srt.
 * Run: pnpm demo:record:submission   (about 6 minutes). Never touches ports 4000, 5173, 5174.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Recorder, ROOT, sleep } from "./video-core.mjs";
import { A } from "./video-steps.mjs";
import { startStack, stopStack, startStub } from "./stack.mjs";

const work = path.join(ROOT, "demo-video/work");
const timeline = JSON.parse(fs.readFileSync(path.join(work, "full/timeline.json"), "utf8"));
const ffmpeg = execFileSync(path.join(ROOT, ".venv-voice/bin/python"), ["-c", "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"]).toString().trim();
const OUT = path.join(ROOT, "demo-video/chimera-rx-submission.mp4");
const ROLE = (s, role) => `${s} <span style="font-weight:500;opacity:.8">· ${role}</span>`;

const CSS = `<style>
@keyframes rise{from{opacity:0;transform:translateY(34px)}to{opacity:1;transform:none}}
@keyframes drift{0%{background-position:0% 50%}100%{background-position:100% 50%}}
@keyframes type{from{width:0}to{width:100%}}
@keyframes bar{from{width:0}to{width:100%}}
</style>`;
const card = (r, title, lines, foot = "", step = 1.3) => r.page.evaluate(([t, ls, f, st, css]) => {
  window.__clearRings?.(); document.body.innerHTML = css + `<div style="position:fixed;inset:0;background:linear-gradient(120deg,#14121f,#2a1f5c,#14121f,#1d2a5c);background-size:300% 300%;animation:drift 8s linear infinite alternate;color:#fff;font:600 54px/1.3 system-ui,sans-serif;display:flex;flex-direction:column;justify-content:center;padding:0 160px;gap:22px">
    <div style="font-size:78px;color:#b9a8ff;animation:rise .7s both">${t}</div>
    <div style="height:6px;border-radius:3px;background:#8f7bff;animation:bar ${ls.length * st + 1}s linear both"></div>
    ${ls.map((l, i) => `<div style="font-weight:500;font-size:46px;animation:rise .7s ${(i + 1) * st}s both">${l}</div>`).join("")}
    <div style="font-size:40px;color:#d9d0ff;margin-top:30px;animation:rise .7s ${(ls.length + 1) * st}s both">${f}</div></div>`;
}, [title, lines, foot, step, CSS]);

const PLACEHOLDERS = "Designed seams, sandboxed today: SMS · email · phone calls · wholesaler EDI/EPCIS · DSCSA verification · e-prescribing · dispensing system · EHR (FHIR) · payer · secrets manager and KMS · SSO";
const P = "Pharmacist"; // the whole video is the pharmacist's view; other roles are narration only (round 6 and 7)
const T = (r, name) => r.lt(ROLE(name, P));
const STEPS = {
  hook: [
    // Signed in as j.rivera once, off camera. The agent scenario loads first (off camera) so Today and AI agents have live suggestions.
    [0, "today", async (r) => {
      await r.cutWait(async () => { await r.control("POST", "/scenario/agent-catches-it"); });
      await r.asUser("j.rivera"); await T(r, "Today"); await r.go("/", "text=Good "); await r.hold(1200); await r.point("text=Start recall"); await r.hold(1500);
    }],
    [1, "cards", async (r) => { await r.point("section[aria-labelledby=sugg]"); await r.hold(1500); await r.scrollTo("text=Deliveries to check in"); await r.point("text=Deliveries to check in"); await r.hold(1500); await r.point("text=Fridge F1"); await r.hold(1000); }],
  ],
  receiving: [
    [0, "scan", async (r) => {
      await T(r, "Receiving"); await r.go("/receiving", "text=Check in delivery from");
      await r.click(r.page.getByRole("button", { name: "Scan with camera" })); await r.page.getByRole("button", { name: "Stop camera" }).waitFor();
      await r.hold(900); await A.recvScan(r);
    }],
    [1, "putaway", async (r) => { await A.recvPutAway(r); await r.hold(1000); }],
  ],
  inventory: [
    [0, "filters", async (r) => {
      await T(r, "Inventory"); await r.go("/inventory", "text=Inventory by lot"); await r.hold(900);
      for (const re of [/^Expiring/, /^Refrigerated/, /^Controlled/]) { await r.click(r.page.getByRole("button", { name: re }).or(r.page.getByRole("tab", { name: re }))); await r.hold(400); }
    }],
  ],
  register: [
    [0, "sale", async (r) => {
      await T(r, "Register"); await r.go("/register", "text=Mark paid and print receipt");
      await r.click("section[aria-labelledby='otc'] li button, section[aria-labelledby='otc'] ul button");
      await r.click(r.page.getByRole("button", { name: "Mark paid and print receipt" })); await r.page.waitForSelector("section[aria-label='Receipt']", { timeout: 8000 }); await r.hold(900);
    }],
  ],
  stock: [
    [0, "stock help", async (r) => { await T(r, "Stock help"); await r.go("/stock", "text=Stock help"); await r.hold(600); await r.point("text=Reorder (1)"); await r.hold(800); await r.scrollTo("text=Expiry risk"); await r.point("text=Expiry risk"); await r.hold(800); }],
  ],
  transfers: [
    [0, "transfer", async (r) => {
      await T(r, "Transfers"); await r.go("/transfers", "#lot");
      const opt = await r.page.locator("#lot option").nth(1).getAttribute("value"); await r.page.selectOption("#lot", opt); await r.hold(400);
      await r.click(r.page.getByRole("button", { name: "Move stock" })); await r.page.waitForSelector("text=Recorded in both audit logs", { timeout: 8000 }); await r.hold(900);
    }],
  ],
  fill: [
    [0, "guardian", async (r) => {
      await T(r, "Fill & pickup"); await r.go("/fill?rx=0072210", "text=Rx Watcher"); await r.hold(1000);
      await T(r, "Rx Guardian"); await r.scrollTo("text=/Rx Guardian found/"); await r.point("text=/Rx Guardian found/"); await r.hold(1500);
      await r.scrollTo("text=Evidence from the history"); await r.point("text=Evidence from the history"); await r.hold(1500);
    }],
    [1, "accept", async (r) => { await A.agentsAccept(r); await r.hold(1200); }],
    [2, "handover", async (r) => { await r.hold(1500); }],
  ],
  patients: [
    [0, "profile", async (r) => {
      await T(r, "Patients"); await r.go("/patients", "#psearch"); await r.hold(400);
      await r.page.locator("#psearch").fill("Brooks"); await r.click(r.page.getByRole("button", { name: "Search", exact: true }));
      await r.click(r.page.locator("[aria-label=Matches] button").first());
      await r.click(r.page.locator("form.enter .pill").first());
      await r.click(r.page.getByRole("button", { name: "Open profile" })); await r.hold(1200);
    }],
  ],
  recalls: [
    [0, "fax", async (r) => { await T(r, "Recalls"); await r.go("/recalls", "text=Fax inbox"); await r.hold(700); await A.recFax(r); await A.recLots(r); }],
    [1, "impact", async (r) => { await A.recConfirm(r); await A.recQuarantine(r); }],
    [2, "attest and send", async (r) => {
      await T(r, "Recalls: patient messages"); await r.click(r.page.getByRole("button", { name: "Continue to patient messages" })); await r.page.waitForSelector("text=Text message");
      await r.click(r.page.getByLabel(/I am the pharmacist/));
      await r.click(r.page.getByRole("button", { name: /^Start \d+ calls/ }));
      await r.cutWait(() => r.page.waitForSelector("text=Patients contacted for recall", { timeout: 60000 })); await r.hold(900);
    }],
  ],
  refills: [
    [0, "worklist", async (r) => {
      await T(r, "Refills"); await r.go("/refills", "text=Refill worklist"); await r.hold(600);
      await r.click(r.page.getByRole("button", { name: "Draft reminders" })); await r.hold(900);
      await r.scrollTo("text=Need a new prescription"); await r.point("text=Need a new prescription"); await r.hold(700);
    }],
  ],
  dscsa: [
    [0, "trace", async (r) => {
      await T(r, "DSCSA & trace"); await r.go("/dscsa", "text=Verification requests");
      await r.click(r.page.getByRole("button", { name: "Preview" })); await r.hold(800);
      await r.scrollTo("text=Verification requests"); await r.hold(600);
    }],
  ],
  outbox: [
    [0, "outbox", async (r) => { await T(r, "Sandbox outbox"); await r.go("/outbox", "text=Sandbox outbox"); await r.hold(1500); await r.point(r.page.locator("main").first()); await r.hold(800); }],
  ],
  agents: [
    [0, "agents page", async (r) => { await T(r, "AI agents"); await r.go("/agents", "text=Rules decide. The model explains."); await r.hold(700); await A.agentsList(r); }],
    [1, "run now", async (r) => { await A.agentsBackground(r); await r.hold(900); }],
    [2, "providers", async (r) => { await A.agentsProvider(r); await A.agentsRuns(r); }],
  ],
  integrations: [
    [0, "standards", async (r) => {
      await T(r, "Integrations"); await r.go("/integrations", "text=Connected partners"); await r.point("text=Connected partners"); await r.hold(1000);
      for (const n of ["MCP server", "FHIR R4"]) { await r.click(r.page.getByRole("tab", { name: n })); await r.hold(400); }
    }],
    [1, "placeholders", async (r) => { await r.scrollTo("text=Outbound connections"); await r.point("text=Outbound connections"); await r.hold(1500); await r.lt(PLACEHOLDERS); await r.hold(1500); }],
  ],
  security: [
    [0, "roles", async (r) => { await r.lt("Roles, enforced on the server: <b>Pharmacist</b> · Technician · Cashier · Admin"); await r.go("/", "text=Good "); await r.hold(2000); }],
    [1, "audit chain", async (r) => { await T(r, "Audit chain"); await r.go("/integrations", "text=Audit chain"); await r.point("text=Audit chain"); await r.hold(1500); }],
  ],
  kiro: [
    [0, "kiro card", async (r) => { await r.lt(""); await card(r, "Built with Kiro", ["Specs with requirement IDs", "Steering for the safety rules", "Hooks: PHI guard and property tests on save", "A custom agent and a Kiro Crew team, a human at every gate"], "", 1.2); await r.hold(1500); }],
    [1, "end card", async (r) => { await card(r, "Chimera Rx", ["github.com/pjborad/Chimera-Rx", "pjborad.github.io/Chimera-Rx"], "", 1.0); await r.hold(1500); }],
  ],
};

fs.mkdirSync(work, { recursive: true });
stopStack();
await startStack();
const stub = startStub();
const r = new Recorder("submission");
const paceFile = path.join(work, "submission-pace7.json");
const pace = fs.existsSync(paceFile) ? JSON.parse(fs.readFileSync(paceFile, "utf8")) : {};
const win = {};
for (const sg of timeline.segments) for (const un of sg.units) win[`${sg.id}#${un.i}`] = un.end - un.start;
let holdSum = 0, factor = 1;
const rawHold = r.hold.bind(r);
r.hold = (ms) => { holdSum += ms; return rawHold(ms * factor); };
const newPace = {};
const only = process.argv[2]; // optional segment id for a quick trial
try {
  await r.start();
  for (const seg of timeline.segments) {
    if (only && seg.id !== only) continue;
    for (const [u, name, fn] of STEPS[seg.id]) {
      const k = `${seg.id}#${u}`; factor = pace[k]?.factor ?? 1; holdSum = 0;
      const t0 = Date.now();
      await r.step(seg.id, u, name, () => fn(r));
      const nat = Recorder.natural(r.steps[r.steps.length - 1]);
      // learn: hold time that would make the step as long as its audio window (with a small margin)
      const base = holdSum / 1000, other = nat - base * factor;
      newPace[k] = { factor: base > 0 ? Math.max(1, Math.min(6, (win[k] * 0.95 - other) / base)) : 1 };
    }
  }
  await r.stop();
  fs.writeFileSync(paceFile, JSON.stringify(newPace, null, 1));
  fs.copyFileSync(path.join(work, "full/voice.wav"), path.join(r.work, "voice.wav"));
  if (only) { console.log("trial run: no encode"); }
  else {
    const speeds = r.encode(timeline, { ffmpeg }, OUT);
    fs.copyFileSync(path.join(work, "full/narration.srt"), path.join(ROOT, "demo-video/chimera-rx-submission.srt"));
    fs.writeFileSync(path.join(work, "submission-speeds.json"), JSON.stringify({ speeds, failed: r.failed }, null, 1));
    console.log("speeds", speeds.map((s) => `${s.seg}#${s.u}:${s.speed}`).join(" "));
    console.log("failed steps:", r.failed.length ? r.failed : "none");
    console.log("wrote", OUT);
  }
} finally { await r.browser?.close().catch(() => {}); stub.close(); stopStack(); }
await sleep(100);
