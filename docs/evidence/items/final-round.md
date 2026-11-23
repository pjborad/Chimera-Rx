# Final round: demo scaffolding out of the product, docs refreshed

Date: 2026-11-23. Branch: `fix/review-2026-11-22`. Nothing was pushed.

## What changed in the product

Removed from the UI:

- The Demo guide page (`apps/web/src/screens/DemoGuide.tsx`), its `/demo` route and its "Demo" nav group.
- The Test labels page (`apps/web/src/screens/Labels.tsx`) and its `/labels` route. It only printed labels for the synthetic stock.
- The scenario launcher (`apps/web/src/components/Scenarios.tsx`).
- Sign-in pre-fill: no email or password is filled in, there are no "other demo staff" links, and the badge/SSO button is gone. The MFA "show the code from the sandbox outbox" link stays, because MFA codes only ever go to the sandbox outbox.

Removed from the API:

- `GET /api/demo/labels`, `GET /api/demo/scenarios`, `POST /api/demo/scenarios/:id`, `POST /api/demo/reset`, and their rows in `apps/api/src/access.ts` and `NO_BODY` in `security.ts`.
- `POST /api/auth/sso` (the badge stand-in) and its access row.
- The `demo` block (email, password, note) and the `storeDemos` map in `GET /api/auth/config`.

Renamed: `LG_DEMO` became `SEED_SYNTHETIC` (default `1`, the same behaviour: seed a fresh database, re-seed on a seed-version change, switch the Rx Guardian on in the seed). Updated in `apps/api/src/config.ts`, `seed.ts`, `server.ts`, `app.ts`, `.env.example`, `Dockerfile`, `docker-compose.yml`, `.devcontainer/devcontainer.json`.

Added: a **Sandbox outbox** item in the sidebar for the pharmacist and technician. The outbox was only reachable from the Demo guide and one Refills link before.

Kept on purpose: the persistent notice on every staff page, the sandbox outbox, the synthetic seed and role logins, MFA, every F01 to F08 fix, the default-deny route test.

Moved: `apps/api/src/scenarios.ts` became the test fixture `apps/api/test/scenario-fixtures.ts`, plus `printableLabels()`. Tests that started scenarios over HTTP now call the fixture in process.

## e2e

`pnpm e2e` now runs `scripts/e2e/run.mjs`. It starts `scripts/e2e/harness.ts` (the real API with two stores on a fresh temporary data directory, serving `apps/web/dist`, on port 4650) and a loopback-only control port on 4651 (reseed, load a scenario fixture, list printable labels). It then runs `scripts/e2e/demo-e2e.mjs` and stops the harness. Ports are set with `E2E_PORT` and `E2E_CONTROL_PORT`. Ports 4000, 5173 and 5174 are not touched. `scripts/e2e/crawl.mjs` no longer visits `/demo` or `/labels`.

## Not changed

Demo recording material stays outside the product, on the owner's instruction: `docs/DEMO.md`, `docs/DEMO_SCRIPT.md` and the untracked `scripts/voiceover/`. `DEMO.md` still describes the removed Demo guide and needs updating when the recording pipeline is extended. There is no `demo:record*` script on this branch.

## Verification (2026-11-23)

| Check | Result |
| --- | --- |
| `pnpm typecheck` | clean in all 6 workspaces |
| `pnpm test` | 24 files, 469 tests passed |
| `pnpm build:web` | built |
| `bash scripts/phi-guard.sh --all` | exit 0 |
| `pnpm e2e` | 49 of 49 passed (MFA checks skipped, MFA off) |
| `MFA=1 pnpm e2e` | 51 of 51 passed |
| Case-insensitive `git grep` for the forbidden company name | only `aidlc/spaces/default/memory/project.md` |
| Relative links in `README.md`, `docs/*.md`, `docs/index.html`, `docs/reviews/` | none dead |

On a fresh seed, recall `D-0611-2026` holds 17 units and names 5 patients, and Rx Guardian Run now raises 5 suggestions on the seeded orders. Those numbers back the "three things to try" in `README.md`.

`docs/img/sign-in.jpg` was re-taken from the e2e harness (empty form, no badge button). The live Kiroween rules page answered HTTP 403 again, so the video length limit and upload site are still for the owner to confirm.

## Follow-up items (same day)

- **Kokoro voice** (commit after `94eab3a`): `KokoroVoice` in `apps/api/src/voice.ts` (`VOICE_PROVIDER=kokoro`, `KOKORO_URL` loopback only, `KOKORO_VOICE` default `am_michael`), tests in `apps/api/test/voice-kokoro.test.ts` with a stubbed fetch. `scripts/voiceover` defaults to `am_michael`, takes `--kokoro-url`, and `--segments` writes one WAV per beat with no edge silence (checked against a local stub server: 0.0 s lead and tail on every segment).
- **Integration placeholders**: `docs/INTEGRATION_PLACEHOLDERS.md`, commented `PLACEHOLDER_...` entries in `.env.example`, the unwired seam `apps/api/src/channels.ts`, and `apps/api/test/channels.test.ts`, which checks that the code, doc and `.env.example` agree and that the app reads none of these names.
- After both: `pnpm typecheck` clean, `pnpm test` 26 files and 476 tests passed, `pnpm build:web` built, PHI guard exit 0.
