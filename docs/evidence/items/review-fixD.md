# REV item D: F08 key-file permissions, honest docs, review intake

## Changed
- `apps/api/src/crypto.ts`: `FileKeyProvider` takes `{platform, exec, username}` (defaults: process.platform, `execFileSync`, `os.userInfo()`). New private `secure()` per path: POSIX chmod 0700 (dir) / 0600 (file), then reads the mode back and throws `CryptoError` if wider. Windows runs `icacls <path> /inheritance:r /grant:r "<user>:F"` (`(OI)(CI)F` for the directory), reads the ACL back and accepts only the current user, SYSTEM and Administrators; any failure throws with a message telling the operator to set `DATA_KEY`. `writeSecret()` opens the temp file with `wx` and 0600, secures it before writing key material, fsyncs, then renames (first key creation uses link to stay exclusive). `load()` secures the directory and every key file on each load. `createKeyProvider` passes options through.
- Tests: `apps/api/test/review-f08.test.ts` (8 tests: POSIX modes after create and rotation, tightening a 0666 file, Windows set/verify with fake icacls, refusal on set failure, extra principal, unreadable or unparsable ACL, rotation re-check, DATA_KEY on win32 never calls icacls). `apps/api/test/security.test.ts` and `review-keys.test.ts`: POSIX mode assertions skipped on win32. `packages/summoner/test/summoner.test.ts`: two fixture paths now use `fileURLToPath` (the reviewer's other fixture case; no `URL.pathname` remains in tests or sources).
- Docs: `docs/SECURITY.md` (key table, per-platform key boundary, role wording, "Independent review" table F01-F08 with empty commit column, not-covered list, penetration-test line), `README.md` (two role lines, key ring line), `docs/SAFETY.md` (secrets, roles, review bullets). The "Read authorization matrix" section was not touched.
- Intake: `docs/reviews/2026-11-22/README.md`, `docs/reviews/2026-11-22/acceptance/independent-review-2026-11-22.test.ts` (unchanged copy; checked for company names: none).

## Commands
- `pnpm exec vitest run apps/api/test/review-f08.test.ts apps/api/test/security.test.ts apps/api/test/review-keys.test.ts packages/summoner`: 48 passed.
- `pnpm typecheck`: all packages pass. `pnpm test`: 24 files, 470 tests passed (includes other workers' tests at that moment).
- `pnpm build:web` not run (apps/web untouched).

## Proof per finding
F08 POSIX: review-f08 tests 1 and 2 (the 0666 case fails on the old code, which never re-tightened). F08 Windows: tests 3 to 8 (old code ignores the options and never calls icacls or refuses).

## Not verified
- `icacls` was never run; the Windows path is tested only against a fake that mimics its documented output. Real output with localized principal names (non-English Windows) could be rejected, which fails closed to the DATA_KEY route.
- The reviewer's Windows test run was not repeated.
