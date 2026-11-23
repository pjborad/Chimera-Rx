---
inclusion: always
---
# Tech

## Stack
TypeScript 5, Node 22.5+ (developed on 26), pnpm 12 workspaces. Packages are consumed as TypeScript source (tsx, Vitest, Vite). No build step for packages.

| Layer | Choice |
| --- | --- |
| API | Fastify 5 + zod, session cookie for staff, OAuth 2.0 client credentials for partners |
| State | SQLite through built-in `node:sqlite` (loaded with `createRequire`), file `data/chimera-rx.sqlite` |
| Jobs | `node-cron` in `apps/api/src/server.ts` (Rx Watcher, outreach agent, Night Watch) |
| AI | Amazon Bedrock Converse or Anthropic behind one `LlmClient`; `LLM_PROVIDER=none` = regex/rules only |
| Voice | ElevenLabs, OpenAI, local Kokoro-82M (loopback `KOKORO_URL` only), macOS `say` or browser speech behind one `VoiceProvider` |
| Documents | `pdfkit` (audit report), `bwip-js` (DataMatrix) |
| Web | React 18, Vite 7, React Router (hash), TanStack Query, `@zxing/browser`, `tesseract.js` (local assets in `apps/web/public/ocr`) |
| Tests | Vitest 3 + fast-check; Playwright for `pnpm e2e` |

## Layout
- `apps/api` composes everything. `apps/web` is the only UI.
- `packages/gs1`, `packages/summoner`, `packages/coroner` are pure and must not import from apps.
- Workspace package names are `@chimera-rx/<name>`; each package exports from `src/index.ts`.

## Rules
- Pin exact dependency versions. No ranges.
- Requirement IDs (`COR-3`, `SUM-3` …) appear in tests and commit messages.
- Every state change a person makes goes through `audit()`; every lot movement through `lotEvent()`.
- Role checks happen on the server, never only in the UI.
- Inline styles in the web app follow the mockups; shared tokens live in `apps/web/src/components/kit.tsx`.

## Commands
- `pnpm install`, `pnpm setup` (OCR model + demo fax, once), `pnpm dev` (API :4000, web :5173)
- `pnpm test`, `pnpm typecheck`, `pnpm build:web`, `pnpm e2e` (needs the stack running)

## Environment
See `.env.example`. Secrets never go in the repo.
