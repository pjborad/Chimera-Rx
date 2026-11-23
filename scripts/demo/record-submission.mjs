/**
 * Submission video (under 3:00): audio first, then the screen follows the audio.
 *   1. .venv-voice/bin/python scripts/demo/make-voice.py full --speed 1.18   (docs/DEMO_VIDEO_SCRIPT.md -> timeline.json, voice.wav)
 *   2. this script starts its own stack on ports 4660-4663, records one step per narration unit, composes the picture onto the
 *      audio time axis and writes demo-video/chimera-rx-submission.mp4 (1920x1080, H.264 + AAC) and .srt.
 * Run: pnpm demo:record:submission   (about 6 minutes). Synthetic data only. Never touches ports 4000, 5173, 5174.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Recorder, ROOT, sleep } from "./video-core.mjs";
import { A } from "./video-steps.mjs";
import { startStack, stopStack } from "./stack.mjs";

const work = path.join(ROOT, "demo-video/work");
const timeline = JSON.parse(fs.readFileSync(path.join(work, "full/timeline.json"), "utf8"));
const ffmpeg = execFileSync(path.join(ROOT, ".venv-voice/bin/python"), ["-c", "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"]).toString().trim();
const OUT = path.join(ROOT, "demo-video/chimera-rx-submission.mp4");
const ROLE = (s, role) => `${s} <span style="font-weight:500;opacity:.8">· ${role}</span>`;

const card = (r, title, lines, foot = "") => r.page.evaluate(([t, ls, f]) => {
  document.body.innerHTML = `<div style="position:fixed;inset:0;background:#14121f;color:#fff;font:600 54px/1.3 system-ui,sans-serif;display:flex;flex-direction:column;justify-content:center;padding:0 160px;gap:22px">
    <div style="font-size:78px;color:#b9a8ff">${t}</div>${ls.map((l) => `<div style="font-weight:500;font-size:44px">${l}</div>`).join("")}<div style="font-size:40px;color:#ffb020;margin-top:30px">${f}</div></div>`;
}, [title, lines, foot]);

const STEPS = {
  hook: [
    [0, "signin page", async (r) => { await r.lt(ROLE("Chimera Rx", "Synthetic data only")); await A.idea(r); }],
    [1, "sign in", async (r) => { await A.signinType(r); await A.showCode(r); await A.codeRefuseThenOk(r); }],
    [2, "today", async (r) => { await A.todayPharm(r); await A.todayCards(r); }],
  ],
  roles: [
    [0, "technician receives", async (r) => { await A.recvOpen(r); await A.recvScan(r); await A.recvPutAway(r); }],
    [1, "pharmacist", async (r) => {
      await r.asUser("j.rivera"); await r.lt(ROLE("Rx Watcher and Rx Guardian", "Pharmacist"));
      await r.go("/fill?rx=0072210", "text=Rx Watcher"); await r.point("text=Rx Watcher"); await r.hold(700);
      await r.scrollTo("text=/Rx Guardian/"); await r.hold(900);
      await r.click(r.page.getByRole("button", { name: "Accept: hold the order" }).first()); await r.click(r.page.getByRole("button", { name: "Put order on hold" })); await r.hold(900);
    }],
    [2, "cashier", async (r) => { await A.regSale(r); await A.regMenu(r); }],
    [3, "admin", async (r) => { await A.intPartners(r); }],
  ],
  recall: [
    [0, "fax and lots", async (r) => { await A.recFax(r); await A.recLots(r); }],
    [1, "confirm and patients", async (r) => { await A.recConfirm(r); await A.recQuarantine(r); await A.recWhy(r); }],
    [2, "messages and outbox", async (r) => { await A.recMessages(r); await A.recSend(r); await A.recLog(r); }],
  ],
  agents: [
    [0, "agents page", async (r) => { await r.lt(ROLE("AI agents", "Pharmacist")); await r.go("/agents", "text=Rules decide."); await r.hold(500); await A.agentsList(r); }],
    [1, "provider and run now", async (r) => {
      await A.agentsProvider(r); await A.agentsBackground(r);
      await r.lt(ROLE("Today: suggestions", "Pharmacist")); await r.go("/", "section[aria-labelledby=sugg]"); await r.point("section[aria-labelledby=sugg]"); await r.hold(900);
      await r.go("/fill?rx=0072214", "text=/Rx Guardian/"); await r.scrollTo("text=/Rx Guardian/"); await r.point("text=/Rx Guardian/"); await r.hold(900);
    }],
  ],
  integrations: [
    [0, "partners and mcp", async (r) => { await A.intPartners(r); await A.intMcp(r); }],
    [1, "placeholders", async (r) => {
      await A.intPlaceholders(r);
      await r.lt("Designed seams, sandboxed today: SMS · email · phone calls · wholesaler EDI/EPCIS · DSCSA verification · e-prescribing (NCPDP SCRIPT) · dispensing system · EHR (FHIR) · payer · secrets manager and KMS · SSO");
      await r.hold(600);
    }],
  ],
  security: [[0, "audit chain", async (r) => { await A.secAudit(r); }]],
  kiro: [
    [0, "kiro card", async (r) => { await r.lt(""); await card(r, "Built with Kiro", ["Specs with requirement IDs", "Steering for the safety rules", "Hooks: PHI guard, property tests on save", "A custom agent and a Kiro Crew team of agents"]); await r.hold(800); }],
    [1, "end card", async (r) => { await card(r, "Chimera Rx", ["github.com/pjborad/Chimera-Rx"], "Synthetic data only. HIPAA-style safeguards, not certified."); await r.hold(800); }],
  ],
};

fs.mkdirSync(work, { recursive: true });
stopStack();
await startStack();
const r = new Recorder("submission");
const paceFile = path.join(work, "submission-pace.json");
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
} finally { await r.browser?.close().catch(() => {}); stopStack(); }
await sleep(100);
