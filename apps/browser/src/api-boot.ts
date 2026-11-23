// The same start-up as apps/api/src/server.ts, minus the network listener and node-cron: the API runs inside this page.
import { AgentRuntime, backgroundTick } from "../../api/src/agents";
import { buildApp } from "../../api/src/app";
import { loadConfig } from "../../api/src/config";
import type { Ctx } from "../../api/src/core";
import { createStores, STORE_1, STORE_2 } from "../../api/src/stores";
import { seedStore2 } from "../../api/src/seed-store2";
import { SandboxNotifier } from "../../api/src/notify";
import { reviewPending } from "../../api/src/rxwatcher";
import { seedDatabase } from "../../api/src/seed";
import { ingestFaxInbox } from "../../api/src/today";
import { createVoice } from "../../api/src/voice";
import { runOutreachAgent } from "../../api/src/outreach";
import { reconcileTransfers, retryPropagations } from "../../api/src/crossstore";
import { quarantineRecalled } from "../../api/src/recall";
import { setRequestLogSink } from "../../api/src/security";

export async function bootApi() {
  setRequestLogSink(() => undefined); // the server prints one JSON line per request; a page has no use for them
  const cfg = loadConfig(process.env as Record<string, string>, { sqlitePath: ":memory:", sandboxDelayMs: 1500 });
  const multi = createStores(cfg);
  const agents = new AgentRuntime(process.env as Record<string, string>);
  const ctx: Ctx = { cfg, db: multi.db, stores: multi.reg, notify: new SandboxNotifier(multi.db, cfg), now: () => Date.now(), agents, get llm() { return agents.asLlm(); }, voice: await createVoice(process.env as Record<string, string>) };
  seedDatabase(multi.reg.db(STORE_1), cfg);
  seedStore2(multi.reg.db(STORE_2), );
  const everyStore = async (fn: () => Promise<unknown>) => { await ctx.stores!.each(fn); };
  await everyStore(() => ingestFaxInbox(ctx));
  const recover = () => everyStore(async () => { reconcileTransfers(ctx); retryPropagations(ctx, quarantineRecalled); });
  await recover();
  const app = await buildApp(ctx);
  await app.ready();
  /** The jobs server.ts schedules with node-cron, run on timers here. The transport calls them one at a time with API calls. */
  const jobs = {
    everyMinute: () => everyStore(() => reviewPending(ctx)).then(recover).then(() => everyStore(() => backgroundTick(ctx))),
    everyFiveMinutes: () => everyStore(() => runOutreachAgent(ctx))
  };
  return { app, ctx, jobs };
}
