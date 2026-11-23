/**
 * Own stack for the demo video, on ports 4690-4699 only (never 4000, 5173, 5174):
 *   4690 app + API (the e2e harness: fresh synthetic database, two stores, MFA on, mock AI provider)
 *   4691 harness control port (reseed, scenario fixtures, printable labels)   test tooling, loopback only
 *   4692 local Kokoro speech server (voicemail audio, same voice as the narrator)
 *   4693 stand-in model (OpenAI-compatible, invents one lot so the Coroner gate visibly drops it)
 * Library: startStack() / stopStack(). CLI: `node scripts/demo/stack.mjs up|down` (pids in demo-video/work/stack.json).
 * Stops only the processes it started, by pid.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
export const PORTS = { app: 4690, control: 4691, kokoro: 4692, stub: 4693 };
const STATE = path.join(ROOT, "demo-video/work/stack.json");
const venvPy = path.join(ROOT, ".venv-voice/bin/python");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wait = async (url, tries = 120) => {
  for (let i = 0; i < tries; i++) { try { if ((await fetch(url)).ok) return true; } catch { /* not yet */ } await sleep(1000); }
  return false;
};

/** The stand-in model: answers every chat call as a model that invents a third lot. Only the Coroner moment switches to it. */
export function startStub() {
  return http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const content = JSON.stringify({ ndcs: [], lots: [{ value: "PRORX050925-1", expiry: "2027-09-30", confidence: 0.97 }, { value: "PRORX050925-3", expiry: "2027-09-30", confidence: 0.96 }, { value: "PRORX050925-7", expiry: "2027-09-30", confidence: 0.9 }], notes: "Three lots." });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "stub", object: "chat.completion", model: "stand-in-model", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }));
    });
  }).listen(PORTS.stub, "127.0.0.1");
}

export async function startStack({ kokoro = true } = {}) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const pids = {};
  const logs = path.join(ROOT, "demo-video/work");
  if (kokoro && fs.existsSync(venvPy)) {
    const k = spawn(venvPy, [path.join(ROOT, "scripts/voiceover/kokoro_server.py"), "--port", String(PORTS.kokoro)], { cwd: ROOT, detached: true, stdio: ["ignore", fs.openSync(path.join(logs, "kokoro.log"), "w"), "ignore"] });
    k.unref(); pids.kokoro = k.pid;
  }
  const env = {
    ...process.env, E2E_PORT: String(PORTS.app), E2E_CONTROL_PORT: String(PORTS.control), MFA: "1",
    LLM_PROVIDER: "mock", VOICE_PROVIDER: kokoro ? "kokoro" : "auto", KOKORO_URL: `http://127.0.0.1:${PORTS.kokoro}`, KOKORO_VOICE: "am_michael", KOKORO_SPEED: "1.05"
  };
  const h = spawn(path.join(ROOT, "node_modules/.bin/tsx"), [path.join(ROOT, "scripts/e2e/harness.ts")], { cwd: ROOT, env, detached: true, stdio: ["ignore", fs.openSync(path.join(logs, "harness.log"), "w"), "ignore"] });
  h.unref(); pids.harness = h.pid;
  fs.writeFileSync(STATE, JSON.stringify(pids));
  if (!(await wait(`http://127.0.0.1:${PORTS.app}/api/health`))) throw new Error("app did not start; see demo-video/work/harness.log");
  if (kokoro && pids.kokoro) await wait(`http://127.0.0.1:${PORTS.kokoro}/health`, 90);
  return pids;
}

export function stopStack() {
  if (!fs.existsSync(STATE)) return;
  const pids = JSON.parse(fs.readFileSync(STATE, "utf8"));
  for (const pid of Object.values(pids)) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  fs.rmSync(STATE, { force: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === "up") console.log(await startStack());
  else if (cmd === "down") stopStack();
  else console.log("usage: node scripts/demo/stack.mjs up|down");
}
