/**
 * E2E harness: boots the real API (two stores, synthetic seed) on a fresh temporary data dir and serves the built web app
 * from the same port, plus a loopback-only control port that the e2e uses to reseed, load a scenario fixture and read
 * the printable labels. The control port is test tooling: it is not part of the product and is never started by server.ts.
 *
 *   E2E_PORT=4650 E2E_CONTROL_PORT=4651 tsx scripts/e2e/harness.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AgentRuntime, backgroundTick } from "../../apps/api/src/agents";
import { buildApp } from "../../apps/api/src/app";
import { loadConfig } from "../../apps/api/src/config";
import type { Actor, Ctx } from "../../apps/api/src/core";
import { SandboxNotifier } from "../../apps/api/src/notify";
import { reviewPending } from "../../apps/api/src/rxwatcher";
import { seedDatabase } from "../../apps/api/src/seed";
import { seedStore2 } from "../../apps/api/src/seed-store2";
import { createStores, STORE_1, STORE_2 } from "../../apps/api/src/stores";
import { ingestFaxInbox } from "../../apps/api/src/today";
import { createVoice } from "../../apps/api/src/voice";
import { printableLabels, resetDemo, SCENARIOS } from "../../apps/api/test/scenario-fixtures";

const port = Number(process.env.E2E_PORT ?? 4650);
const controlPort = Number(process.env.E2E_CONTROL_PORT ?? 4651);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chimera-e2e-"));
process.env.OFFLINE ??= "1";

const cfg = loadConfig({ ...process.env, DATA_DIR: dataDir, LG_API_PORT: String(port), NIGHT_WATCH: "0", SANDBOX_DELAY_MS: "300", LLM_PROVIDER: process.env.LLM_PROVIDER ?? "none" });
const multi = createStores(cfg);
const agents = new AgentRuntime({ ...process.env, LLM_PROVIDER: process.env.LLM_PROVIDER ?? "none" });
const ctx: Ctx = { cfg, db: multi.db, stores: multi.reg, notify: new SandboxNotifier(multi.db, cfg), now: () => Date.now(), agents, get llm() { return agents.asLlm(); }, voice: await createVoice() };
seedDatabase(multi.reg.db(STORE_1), cfg);
seedStore2(multi.reg.db(STORE_2));
const everyStore = (fn: () => Promise<unknown>) => multi.reg.each(fn);
await everyStore(() => ingestFaxInbox(ctx));
await everyStore(() => reviewPending(ctx));

const app = await buildApp(ctx);
await app.listen({ port, host: "127.0.0.1" });
const tick = setInterval(() => { void everyStore(() => backgroundTick(ctx)).catch(() => undefined); void everyStore(() => reviewPending(ctx)).catch(() => undefined); }, 15_000);

const pharmacist: Actor = { id: "e2e-harness", name: "E2E harness", role: "pharmacist", storeId: STORE_1, workstation: "e2e harness" };
const control = http.createServer((req, res) => {
  const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const url = req.url ?? "/";
  void multi.reg.run(STORE_1, async () => {
    try {
      if (req.method === "POST" && url === "/reset") { await resetDemo(ctx, null); return send(200, { ok: true }); }
      const m = /^\/scenario\/([a-z0-9-]+)$/.exec(url);
      if (req.method === "POST" && m) {
        if (!SCENARIOS.some((s) => s.id === m[1])) return send(404, { error: "unknown scenario" });
        await resetDemo(ctx, pharmacist, m[1]!);
        return send(200, { ok: true, scenario: m[1] });
      }
      if (req.method === "GET" && url === "/labels") return send(200, printableLabels(ctx));
      return send(404, { error: "not found" });
    } catch (e) { return send(500, { error: String(e) }); }
  });
});
control.listen(controlPort, "127.0.0.1");
console.log(`e2e harness: app http://localhost:${port}  control http://127.0.0.1:${controlPort}  data ${dataDir}`);

const stop = async () => { clearInterval(tick); control.close(); await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0); };
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
