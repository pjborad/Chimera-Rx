// Runs first. Installs the Node globals the API and its dependencies expect, then fixes the settings the API reads from process.env:
// no network calls, no keys, a throwaway encryption key per session.
import { Buffer } from "buffer";
import process from "process/browser";

const g = globalThis as any;
g.global = g;
g.Buffer = Buffer;
g.process = process;
g.setImmediate ??= (fn: (...a: unknown[]) => void, ...a: unknown[]) => setTimeout(fn, 0, ...a);
g.clearImmediate ??= (id: number) => clearTimeout(id);
// Fastify reads require.cache to name plugins; there is no module cache in a page.
g.require ??= Object.assign((id: string) => { throw new Error(`require("${id}") is not available in the browser build`); }, { cache: {} });
const env = process.env as Record<string, string>;
Object.assign(env, {
  OFFLINE: "1",            // never call openFDA from a page
  LLM_PROVIDER: "mock",    // no model keys in a browser; the deterministic mock stands in
  VOICE_PROVIDER: "browser", // the web app reads scripts with speechSynthesis
  NIGHT_WATCH: "0",
  SANDBOX_DELAY_MS: "1500",
  TWO_STORES: "1",
  NODE_ENV: "production"
});

