import cron from "node-cron";
import { AgentRuntime, backgroundTick, runAgent } from "./agents";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import type { Ctx } from "./core";
import { Db } from "./db";
import { createStores, STORE_1, STORE_2 } from "./stores";
import { seedStore2 } from "./seed-store2";
import { SandboxNotifier } from "./notify";
import { reviewPending } from "./rxwatcher";
import { seedDatabase } from "./seed";
import { ingestFaxInbox, pollOpenFda } from "./today";
import { createVoice } from "./voice";
import { startWebhookDispatcher } from "./webhooks";
import { runOutreachAgent } from "./outreach";
import { reconcileTransfers, retryPropagations } from "./crossstore";
import { quarantineRecalled } from "./recall";

const cfg = loadConfig();
// Two stores (FR4): one database each, one routed `ctx.db`. TWO_STORES=0 runs the original single store.
const two = process.env.TWO_STORES !== "0";
const multi = two ? createStores(cfg) : null;
const db = multi ? multi.db : new Db(cfg.sqlitePath);
// One live AI provider choice (Bedrock by default; a judge can switch it in the UI). `ctx.llm` follows it, so the Coroner at
// receiving and the stock explanations use the same provider as the agents. "none" means rules only.
const agents = new AgentRuntime(process.env);
const ctx: Ctx = { cfg, db, stores: multi?.reg, notify: new SandboxNotifier(db, cfg), now: () => Date.now(), agents, get llm() { return agents.asLlm(); }, voice: await createVoice() };
if (multi) {
  if (seedDatabase(multi.reg.db(STORE_1), cfg)) console.log("Seeded Elm Street Pharmacy · Store 7 (synthetic data)");
  if (seedStore2(multi.reg.db(STORE_2))) console.log("Seeded Birch Avenue Pharmacy · Store 2 (synthetic data)");
} else if (seedDatabase(db, cfg)) console.log("Seeded Elm Street Pharmacy · Store 7 (synthetic data)");
const everyStore = async (fn: () => Promise<unknown>) => { if (ctx.stores) await ctx.stores.each(fn); else await fn(); };
await everyStore(() => ingestFaxInbox(ctx));
// Cross-store work that a crash can leave half done (REV-F02, REV-F05): finish it now, then every minute.
const crossStoreRecovery = () => everyStore(async () => { reconcileTransfers(ctx); retryPropagations(ctx, quarantineRecalled); });
await crossStoreRecovery();
startWebhookDispatcher(ctx);

const app = await buildApp(ctx);
await app.listen({ port: cfg.port, host: "0.0.0.0" });
console.log(`Chimera Rx API on http://localhost:${cfg.port}  (notifier=${ctx.notify.name}, llm=${agents.provider}:${agents.model || "-"}, voice=${ctx.voice!.name}:${ctx.voice!.voice}, seed=${cfg.seedSynthetic})`);

// Rx Watcher: review every new order at start-up, then every minute.
void everyStore(() => reviewPending(ctx).then((n) => { if (n) console.log(`Rx Watcher reviewed ${n} new order(s)`); }));
cron.schedule("* * * * *", () => { void everyStore(() => reviewPending(ctx)).catch(() => undefined); });
cron.schedule("* * * * *", () => { void crossStoreRecovery().catch(() => undefined); });
// Background agents (agents/background.ts): every enabled agent runs on its trigger. The tick is never awaited by a request and never throws.
// AGENTS_BACKGROUND=0 turns it off. The Rx Guardian looks at new or changed orders on every tick.
const backgroundRound = () => everyStore(() => backgroundTick(ctx)).catch(() => undefined);
setTimeout(() => { void backgroundRound(); }, 8000).unref();
cron.schedule("* * * * *", () => { void backgroundRound(); });
// Outreach agent: retries due voicemail attempts inside the calling window, every 5 minutes.
cron.schedule("*/5 * * * *", () => { void everyStore(() => runOutreachAgent(ctx)).catch(() => undefined); });

// Night Watch: openFDA poll at start-up and every 2 hours (plan 6.3).
if (cfg.nightWatch) {
  setTimeout(() => { void everyStore(() => pollOpenFda(ctx).then((r) => { console.log("Night Watch:", r); })).catch(() => undefined); }, 3000).unref();
  cron.schedule("0 */2 * * *", () => { void everyStore(() => pollOpenFda(ctx)).catch(() => undefined); }, { timezone: "UTC" });
  // The Night Watch agent writes the overnight digest (advisory; it confirms and sends nothing). 06:00 UTC daily and once at start-up.
  const digest = () => everyStore(() => runAgent(ctx, null, "night-watch", {}).then((r) => { console.log(`Night Watch digest (${r.mode}, ${r.provider}): ${(r.gatedOutput as { summary?: string }).summary ?? ""}`); })).catch(() => undefined);
  setTimeout(() => { void digest(); }, 6000).unref();
  cron.schedule("0 6 * * *", () => { void digest(); }, { timezone: "UTC" });
}
