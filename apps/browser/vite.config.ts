import { fileURLToPath } from "node:url";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const here = path.dirname(fileURLToPath(import.meta.url));
const polyfillDir = path.join(here, "node_modules/vite-plugin-node-polyfills");
const shim = (f: string) => path.join(here, "src/shims", f);
const mod = (...names: string[]) => new RegExp(`^(node:)?(${names.join("|")})$`);

// The browser build: the web app plus the real API (apps/api/src) bundled into one page. Server-only Node modules are swapped
// for small stand-ins in src/shims. The normal build (apps/web) is untouched.
export default defineConfig({
  base: process.env.BROWSER_BASE ?? "/Chimera-Rx/app/",
  root: here,
  publicDir: path.join(here, "../web/public"),
  plugins: [
    react(),
    nodePolyfills({
      include: ["events", "path", "process", "stream", "util", "assert", "url", "querystring", "string_decoder", "timers", "zlib", "tty", "constants", "vm"],
      globals: { Buffer: false, global: false, process: false },
      protocolImports: true
    })
  ],
  define: {
    // Vite folds process.env into {} for client builds; the API reads its settings from it at run time (see src/env.ts)
    "process.env": "globalThis.process.env",
    "import.meta.dirname": JSON.stringify("/app/apps/api/src"),
    "import.meta.env.VITE_BROWSER_API": JSON.stringify("1")
  },
  resolve: {
    alias: [
      // the globals the polyfill plugin injects are imported by bare name, which only resolves from this package
      { find: /^vite-plugin-node-polyfills\/shims\/(buffer|global|process)$/, replacement: path.join(polyfillDir, "shims/$1/dist/index.js") },
      // one Buffer implementation for every package, so the base64url patch in src/env.ts reaches all of them
      { find: /^(node:)?buffer\/?$/, replacement: shim("buffer.ts") },
      { find: mod("crypto"), replacement: shim("crypto.ts") },
      { find: mod("fs"), replacement: shim("fs.ts") },
      { find: mod("http", "https", "http2"), replacement: shim("http.ts") },
      { find: mod("module"), replacement: shim("module.ts") },
      { find: mod("sqlite"), replacement: shim("sqlite.ts") },
      { find: mod("async_hooks"), replacement: shim("async_hooks.ts") },
      { find: mod("child_process", "dns", "net", "os"), replacement: shim("misc.ts") },
      { find: mod("diagnostics_channel"), replacement: shim("diagnostics.ts") },
      { find: mod("perf_hooks"), replacement: shim("perf_hooks.ts") },
      // pdfkit's browser bundle (fonts inlined); the Node build reads font files from disk
      { find: /^pdfkit$/, replacement: path.join(here, "../api/node_modules/pdfkit/js/pdfkit.standalone.js") },
      { find: "@fastify/static", replacement: shim("empty.ts") },
      { find: "@aws-sdk/client-bedrock-runtime", replacement: shim("empty.ts") }
    ]
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 4000, target: "es2022" },
  server: { fs: { allow: [path.join(here, "../..")] } }
});
