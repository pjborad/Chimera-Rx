# Browser-only build of the real app (GitHub Pages)

Target: https://pjborad.github.io/Chimera-Rx/app/ . Same React app, same Fastify API code (`apps/api/src`, no routes rewritten), running inside the page.

## How it works
- `apps/browser` is an extra Vite build (`pnpm build:browser`, base `/Chimera-Rx/app/`). The server build, Docker and Codespaces are unchanged.
- Fastify runs in the page; a `fetch` wrapper (`src/transport.ts`) sends same-origin `/api`, `/oauth`, `/v1`, `/mcp`, `/fhir`, `/hooks` calls to `app.inject()`, one at a time, and keeps the session cookie itself.
- `node:sqlite` is shimmed over sql.js (SQLite as WASM, bundled, in memory, seeded with the existing synthetic seed for both stores).
- Shims (`apps/browser/src/shims`): crypto (browserify AES-GCM so encryption at rest still runs, scrypt from @noble/hashes, per-session random key), fs (fixtures bundled as text), http (ServerResponse for inject), AsyncLocalStorage (store routing), module, child_process/dns/net/os stubs, Buffer base64url patch.
- pdfkit uses its standalone browser build; the audit PDF is built in the page.
- The jobs node-cron runs on the server run on `setInterval` in the page, queued behind API calls. Webhook dispatcher not started.
- `OFFLINE=1`, `LLM_PROVIDER=mock`, `VOICE_PROVIDER=browser`. No keys, no network calls.
- Product code touched: `apps/web/src/components/Shell.tsx` (preview banner under the notice, only when `VITE_BROWSER_API=1`) and `apps/web/src/lib/ocr.ts` (OCR asset paths use `BASE_URL`, `/` in the normal build).

## Verification (2026-11-23)
- `pnpm typecheck` clean; `pnpm test` 476/476; `pnpm build:web` ok; `pnpm build:browser` ok; PHI guard clean.
- `node scripts/e2e/browser-app.mjs` (Chromium, served on 4680 under /Chimera-Rx/app/): 57/57. Four roles sign in through the form, every nav screen opens, D-0611-2026 and D-0417-2026 lookups, audit PDF, agent run, cashier register sale, cashier/technician/admin 403s, audit export download, zero console errors and zero failed requests.
- Screenshots: `docs/evidence/screens/browser-*.png`.
- Size: dist 21 MB (15 MB is the existing OCR model and wasm); JS 2.1 MB api chunk (about 680 KB gzip) + 0.44 MB app + 0.97 MB barcode lib; sql.js wasm 0.69 MB.

## Not available in the browser preview
Nothing persists across reload; webhook delivery to outside URLs; live AI providers (mock only); server-side voice audio (browser speech reads scripts); live openFDA (bundled copies used); it is not a security boundary (see docs/SECURITY.md). Untested: real webcam hardware.

## For the lead
Set repo Settings > Pages > Source to "GitHub Actions" once. The workflow (`.github/workflows/pages.yml`) runs `ocr:assets` (downloads the OCR model) then builds and deploys on push to main.
