/**
 * `pnpm e2e`: starts the e2e harness (scripts/e2e/harness.ts) on its own ports with a fresh synthetic database, runs the
 * browser rehearsal (scripts/e2e/demo-e2e.mjs) against it, then stops the harness. It never touches ports 4000/5173.
 * Needs the built web app (`pnpm build:web`). Ports: E2E_PORT (default 4650), E2E_CONTROL_PORT (default 4651).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
if (!fs.existsSync(path.join(root, "apps/web/dist/index.html"))) {
  console.error("apps/web/dist is missing. Run `pnpm build:web` first.");
  process.exit(1);
}
const port = process.env.E2E_PORT ?? "4650";
const controlPort = process.env.E2E_CONTROL_PORT ?? "4651";
const env = { ...process.env, E2E_PORT: port, E2E_CONTROL_PORT: controlPort };
const tsx = path.join(root, "node_modules/.bin/tsx");
const harness = spawn(tsx, [path.join(root, "scripts/e2e/harness.ts")], { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] });

const up = async () => {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
};
let code = 1;
try {
  if (!(await up())) throw new Error(`harness did not answer on port ${port}`);
  code = await new Promise((resolve) => {
    const t = spawn(process.execPath, [path.join(root, "scripts/e2e/demo-e2e.mjs")], {
      cwd: root, stdio: "inherit",
      env: { ...env, BASE: `http://localhost:${port}`, CONTROL: `http://127.0.0.1:${controlPort}` }
    });
    t.on("exit", (c) => resolve(c ?? 1));
  });
} catch (e) {
  console.error(String(e));
} finally {
  harness.kill("SIGTERM"); // the child this script started, nothing else
}
process.exit(code);
