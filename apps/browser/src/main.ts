import "./env";
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { useSqlJs } from "./shims/sqlite";

useSqlJs(await initSqlJs({ locateFile: () => wasmUrl } as never));
const { bootApi } = await import("./api-boot");
const { installTransport, serial } = await import("./transport");
const { app, jobs } = await bootApi();
installTransport(app);
// The jobs node-cron runs on the server: every minute (Rx Watcher, recovery, background agents) and every five (outreach).
// They queue behind API calls so they never overlap one.
const tick = (fn: () => Promise<unknown>) => () => { void serial(() => fn().catch(() => undefined)); };
setInterval(tick(jobs.everyMinute), 60_000);
setInterval(tick(jobs.everyFiveMinutes), 300_000);
document.getElementById("boot")?.remove();
await import("../../web/src/main");
