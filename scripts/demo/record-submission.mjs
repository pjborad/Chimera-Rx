/**
 * Submission video (under 3:00): audio first, then the screen follows the audio.
 *   1. .venv-voice/bin/python scripts/demo/make-voice.py full   (two voices, VOICE_A / VOICE_B; docs/DEMO_VIDEO_SCRIPT.md -> timeline.json, voice.wav)
 *   2. this script starts its own stack on ports 4690-4693, records one step per narration unit, composes the picture onto the
 *      audio time axis and writes demo-video/chimera-rx-submission.mp4 (1920x1080, H.264 + AAC) and .srt.
 * Run: pnpm demo:record:submission   (about 6 minutes). Synthetic data only. Never touches ports 4000, 5173, 5174.
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

const pharm = (r) => r.asUser("j.rivera");
const STEPS = {
  hook: [
    [0, "signin page", async (r) => { await r.lt(ROLE("Chimera Rx", "Synthetic data only")); await A.idea(r); }],
    [1, "sign in", async (r) => { await A.signinType(r); await A.showCode(r); await A.codeRefuseThenOk(r); }],
    [2, "today", async (r) => { await A.todayPharm(r); await A.todayCards(r); }],
  ],
  tour: [
    [0, "technician receives", async (r) => { await A.recvOpen(r); await A.recvScan(r); await A.recvPutAway(r); }],
    [1, "pharmacist inventory and fill", async (r) => {
      await A.invOpen(r); await A.invFilters(r);
      await r.lt(ROLE("Fill & pickup", "Pharmacist")); await r.go("/fill?rx=0072210", "text=Rx Watcher"); await r.point("text=Rx Watcher"); await r.hold(900);
    }],
    [2, "cashier", async (r) => { await A.regSale(r); await A.regMenu(r); }],
    [3, "refills and patients", async (r) => {
      await pharm(r); await r.lt(ROLE("Refills", "Pharmacist")); await r.go("/refills", "text=Refill worklist"); await r.hold(700);
      await r.lt(ROLE("Patients", "Pharmacist")); await r.go("/patients"); await r.hold(900);
    }],
  ],
  recall: [
    [0, "fax and lots", async (r) => { await A.recFax(r); await A.recLots(r); }],
    [1, "confirm quarantine messages", async (r) => { await A.recConfirm(r); await A.recQuarantine(r); await A.recMessages(r); }],
  ],
  open: [
    [0, "dscsa export", async (r) => { await pharm(r); await A.dscsaExport(r); }],
    [1, "sandbox verifier", async (r) => { await r.scrollTo("text=Verification requests"); await A.dscsaVerify(r); }],
    [2, "partners and mcp", async (r) => { await A.intPartners(r); await A.intMcp(r); }],
    [3, "two stores", async (r) => { await pharm(r); await A.transfer(r); await A.store2(r); }],
    [4, "placeholders", async (r) => {
      await r.asUser("s.grant"); await r.lt(ROLE("Integrations", "Admin")); await r.go("/integrations", "text=Outbound connections");
      await A.intPlaceholders(r);
      await r.lt("Designed seams, sandboxed today: SMS · email · phone calls · wholesaler EDI/EPCIS · DSCSA verification · e-prescribing · dispensing system · EHR (FHIR) · payer · secrets manager and KMS · SSO");
      await r.hold(600);
    }],
  ],
  agents: [
    [0, "agents page", async (r) => { await A.agentsOpen(r); await A.agentsList(r); }],
    [1, "run now", async (r) => { await A.agentsBackground(r); }],
    [2, "suggestions and accept", async (r) => { await A.agentsToday(r); await A.agentsAccept(r); }],
    [3, "coroner gate", async (r) => { await r.go("/agents", "text=Rules decide."); await A.agentsGate(r); }],
    [4, "providers", async (r) => { await A.agentsProvider(r); await A.agentsRuns(r); }],
  ],
  security: [[0, "audit chain", async (r) => { await r.asUser("s.grant"); await A.secAudit(r); await r.scrollTo("text=Audit chain"); await r.hold(900); }]],
  kiro: [
    [0, "kiro card", async (r) => { await r.lt(""); await card(r, "Built with Kiro", ["Specs with requirement IDs", "Steering for the safety rules", "Hooks: PHI guard and property tests on save", "A custom agent and a Kiro Crew team, a human at every gate"], "", 1.5); await r.hold(1500); }],
    [1, "end card", async (r) => { await card(r, "Chimera Rx", ["github.com/pjborad/Chimera-Rx", "pjborad.github.io/Chimera-Rx"], "Synthetic data only. HIPAA-style safeguards, not certified.", 1.2); await r.hold(1500); }],
  ],
};

fs.mkdirSync(work, { recursive: true });
stopStack();
await startStack();
const stub = startStub();
const r = new Recorder("submission");
const paceFile = path.join(work, "submission-pace5.json");
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
