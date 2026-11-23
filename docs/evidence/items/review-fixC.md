# Item C evidence: REV-F02, REV-F05, REV-F06

Branch `fix/review-2026-11-22`. Synthetic data only. Test file: `apps/api/test/review-f02-f05-f06.test.ts` (19 tests).

## What changed

### F02 recall propagation (`apps/api/src/crossstore.ts`)
- `propagateRecall` records one row per destination in a new `recall_propagation` table (source store; state pending, failed or done; attempts; last error) and then calls `applyPropagation`.
- `applyPropagation` runs in the destination in one transaction: inserts the recall if missing; inserts missing lots as confirmed; **upgrades** an existing unconfirmed lot (sets `confirmed_by` = "Confirmed at <store> on <date>", `confirmed_at`, fills empty ndc11/expiry); never touches a confirmed row. Audits `recall.mirrored` only when something changed. Then runs `quarantineRecalled` (idempotent).
- A destination failure is caught, stored (`failed`, error text, `recall.propagation_failed` audit in the source) and does not undo the source's own block.
- `retryPropagations(ctx, quarantine)` repeats every non-done row. `server.ts` runs it at start-up and from a new every-minute job, once per store.
- A lot that arrived by mirroring (marker "Confirmed at") is never sent back, so the two stores cannot ping-pong.
- The destination blocks through the existing `lots.status = 'recalled'` and `activeRecallFor`, neither of which looks at the recall's status, so closing the recall changes nothing (rule 8).

### F05 durable transfers (`apps/api/src/crossstore.ts`, `domain.ts`, `inventory.ts`, `app.ts`, `server.ts`, `access.ts`, `apps/web/src/screens/Transfers.tsx`)
- New tables in each store: `transfers` (source: id uuid, state reserved/received/completed/cancelled, lot, package ids and serials, actor, error, times) and `transfer_receipts` (destination, keyed by transfer id).
- `transferPackages`: (1) one source transaction sets the packages `in_transit` and writes the `transfers` row; (2) destination `receiveTransfer`, one transaction, idempotent on the transfer id (packages arrive `on_shelf` with the same lot and serial, lot event, audit); (3) source `completeTransfer`, one transaction. A repeat call with the same `transferId` finishes what is left and never moves twice; a cancelled id is refused.
- A destination refusal (recall, product not stocked) cancels the transfer and releases the packages; any other failure leaves it visible as `reserved` or `received`.
- `reconcileTransfers(ctx)`: if the destination has the receipt, complete; otherwise release the source packages (to `quarantined` if the lot was recalled in the meantime). Audits each action. Runs at start-up, every minute, and from `POST /api/transfers/recover` (pharmacist). `GET /api/transfers` lists the store's transfers. Both routes are in the access matrix (`access.ts`, pharmacist only).
- Ledger: `in_transit` added to `PackageStatus`, to `ledgerViolations` (on hand = received - dispensed - returned - adjusted - destroyed - in_transit) and to the lot detail "adjusted" count.
- Transfers screen: "Recent transfers" table with a status column and a **Recover** button for pharmacists when something is not finished; the screen sends one transfer id per move so a double click or retry repeats the same transfer.

### F06 store identity in outputs
- New `pharmacyProfile(ctx, actor)` in `apps/api/src/stores.ts`: name, phone and signing pharmacist read from the current store's `stores` and `users` rows.
- `recall.ts`: default SMS, email body, drafts (`messageDraft`), previews, send (`sendNotifications`) and the PDF header use `{pharmacy_name}`, `{pharmacy_phone}`, `{pharmacist}` filled per store. Send requires `{pharmacy_phone}` or this store's own phone, and refuses text that names the other store's name or phone (`foreignIdentity`). The `PHARMACY_PHONE` constant is gone.
- `outreach.ts` (voicemail script, preview, start), `agents/outreach.ts`, `agents/refills.ts`, `refills-routes.ts`, the mock provider templates in `agents/providers.ts`: same placeholders; the "pharmacy phone present" gates compare with the current store's phone. `findPhi` in `agents/agent.ts` allows the current store's phone only; `scrubContact` takes the store's digits.
- Spoken pharmacist comes from the user's `first_name` + surname ("Sam Okoro", "Jordan Rivera"), replacing the hard-coded "J. " to "Jordan " replacement.
- Left as is: Store 7 seed data (`seed.ts`, `dataset.ts`), the server start-up log line, and the web fallback `"(555) 010-2200"` in `Recalls.tsx` (only used when the API sends no `fields`).

## Commands and results
- `pnpm typecheck`: all packages pass.
- `pnpm test`: 24 files, 483 tests pass (includes the 19 new ones, the ledger property test and the access-matrix test).
- `pnpm build:web`: passes.
- Reviewer's `independent-review-2026-11-22.test.ts` copied temporarily into `apps/api/test/` and run with the whole suite: 21 of 21 pass (the copy was removed afterwards; the reviewer's original is untouched). That includes the two "mirrors a confirmed recall when destination pending row exists" cases and the transfer test.
- Old-code check: the new test file run against `git archive HEAD` (pre-fix): 18 of 19 fail; the one that passes (blocks after close) asserts behaviour that already held.

## Which test proves which finding
- F02: `REV-F02 recall propagation` (fresh destination, pending row, already confirmed, repeat, failure + restart with reopened files, blocks at the destination before and after close incl. transfer refusal).
- F05: `REV-F05 durable transfers` (happy path, failure before reserve, before destination write, after destination commit, rollback by reconcile, restart with reopened files, recall during transit, reused id). Every case asserts at most one store has the serial `on_shelf`, `ledgerViolations` empty in both stores and both audit chains valid. Faults are SQLite triggers.
- F06: `REV-F06 per-store identity in outputs` (Store 2 draft, preview, sent bodies, voicemail script and preview, PDF text, AI drafters and their phone gate, refusal of Store 7 text in Store 2; Store 7 still shows Elm Street, its phone and J. Rivera; STOP on texts, no medicine or recall reason in the voicemail).

## Decisions and not done
- **Terminal source status stays `adjusted`, not `transferred_out`.** The brief names `transferred_out`, but the reviewer's own test puts its failing trigger on `status = 'adjusted'` and expects the source write to throw. With `transferred_out` that test would not throw and would fail. `adjusted` is already counted by the ledger, the note and lot event say "Transferred to <store> (transfer <id>)", and the `transfers` row is the authoritative record. If the lead prefers `transferred_out`, that is a one-word change plus the reviewer's trigger.
- The fill, register-sale and refill paths were not each driven in Store 2 for the mirrored lot; they all read `lots.status`/`activeRecallFor`, which the tests assert directly, plus the receiving check and the transfer refusal.
- `Recalls.tsx` fallback phone not changed (see above); not exercised by the API.
- No port was used by a server; all tests use `app.inject` or direct calls.
