/**
 * FR2.2 / FR2.3 / US0.5: time the recall flow on the larger synthetic dataset and publish the median and worst run,
 * plus the lot-capture rate.
 *
 *   pnpm evidence:timing
 *
 * Each run reseeds the synthetic data with the large dataset, then times, through the real HTTP routes (Fastify inject, no browser):
 * submit recall D-0650-2026 -> confirm every lot that waits for the pharmacist -> load the affected-patient list.
 * Writes docs/evidence/timing.json and docs/evidence/timing.md.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLlmFromEnv } from "@chimera-rx/coroner";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Ctx } from "../src/core";
import { lotCaptureRate, TIMING_RECALL } from "../src/dataset";
import { Db } from "../src/db";
import { SandboxNotifier } from "../src/notify";
import { seedDatabase } from "../src/seed";
import { createVoice } from "../src/voice";
import { resetDemo } from "../test/scenario-fixtures";

const RUNS = 5;
const root = path.resolve(import.meta.dirname, "../../..");
const outDir = path.join(root, "docs/evidence");
const dataDir = fs.mkdtempSync(path.join(root, "data", "timing-"));
process.env.OFFLINE = "1";

const cfg = loadConfig({ ...process.env, DATA_DIR: dataDir, DATASET: "large", NIGHT_WATCH: "0", SANDBOX_DELAY_MS: "0" });
const db = new Db(cfg.sqlitePath);
const ctx: Ctx = { cfg, db, notify: new SandboxNotifier(db, cfg), now: () => Date.now(), llm: createLlmFromEnv(), voice: await createVoice() };
seedDatabase(db, cfg);
const app = await buildApp(ctx);

let cookie = "";
const signIn = async () => {
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { storeId: "store-7", email: "j.rivera@elmstreetrx.example", password: "moonlight-rx-2026" } });
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
};
await signIn();
const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { cookie } });
  if (r.statusCode >= 400) throw new Error(`${method} ${url} -> ${r.statusCode} ${r.body}`);
  return r.json();
};

const runs: { ms: number; patients: number; units: number; confirmClicks: number }[] = [];
for (let i = 0; i < RUNS; i++) {
  await resetDemo(ctx, null);
  await signIn(); // a reset clears sessions, as it does for a person
  const t0 = performance.now();
  let v = await call("POST", "/api/recalls/lookup", { number: TIMING_RECALL.number });
  let clicks = 0;
  for (const l of v.recall.lots.filter((x: any) => x.needsConfirm && x.received > 0)) {
    v = await call("POST", `/api/recalls/${v.recall.id}/confirm-lot`, { lot: l.lot });
    clicks++;
  }
  const shown = await call("GET", `/api/recalls/${v.recall.id}`);
  const ms = performance.now() - t0;
  runs.push({ ms, patients: shown.impact.patientCount ?? 0, units: shown.impact.unitsHeld ?? 0, confirmClicks: clicks });
}
const capture = lotCaptureRate(db);
const dataset = JSON.parse(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'dataset'")?.value ?? "{}");
await app.close();
fs.rmSync(dataDir, { recursive: true, force: true });

const sorted = runs.map((r) => r.ms).sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)]!;
const worst = sorted[sorted.length - 1]!;
const machine = { cpu: os.cpus()[0]?.model ?? "unknown", cores: os.cpus().length, memoryGb: +(os.totalmem() / 2 ** 30).toFixed(1), os: `${os.type()} ${os.release()} ${os.arch()}`, node: process.version };
const report = { generated: new Date().toISOString(), recall: TIMING_RECALL.number, runs, medianMs: +median.toFixed(1), worstMs: +worst.toFixed(1), underSixtySeconds: median < 60_000, lotCapture: capture, dataset, machine };
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "timing.json"), JSON.stringify(report, null, 2) + "\n");

const s = (ms: number) => (ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`);
const md = `# Recall timing and lot capture

Generated ${report.generated.slice(0, 10)} by \`pnpm evidence:timing\`.

**Recall ${TIMING_RECALL.number} → affected-patient list: median ${s(median)}, worst ${s(worst)} over ${RUNS} runs.** Target: median under 60 s (${report.underSixtySeconds ? "met" : "not met"}).

| Run | Time | Confirm clicks | Units held | Patients listed |
| --- | --- | --- | --- | --- |
${runs.map((r, i) => `| ${i + 1} | ${s(r.ms)} | ${r.confirmClicks} | ${r.units} | ${r.patients} |`).join("\n")}

What is timed: the server work from submitting the recall number, through the pharmacist's confirm clicks (performed by the script), to the affected-patient list, over the app's real HTTP routes (Fastify inject). Not timed: a person reading the screen, browser rendering and the network. openFDA is skipped (\`OFFLINE=1\`); the recall comes from the synthetic fixture.

## Lot capture

**${capture.captured} of ${capture.total} sold fills (${(100 * capture.rate).toFixed(1)}%) have lot and serial recorded.** On this synthetic dataset the missing fills are, by construction, fills from the first month before the counter scanner was used; the number shows what the ledger reports, not a field measurement.

## Dataset

Seed ${dataset.seed}: ${dataset.products} generated products, ${dataset.patients} patients, ${dataset.fills} fills over 6 months (on top of the demo seed). Synthetic data only.

## Machine

${machine.cpu} (${machine.cores} cores), ${machine.memoryGb} GB, ${machine.os}, Node ${machine.node}.
`;
fs.writeFileSync(path.join(outDir, "timing.md"), md);
console.log(md);
