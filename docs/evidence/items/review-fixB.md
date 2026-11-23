# Item B evidence: F01 hold overwrite, F04 locally sold medicines, two Rx review wording defects

Branch `fix/review-2026-11-22`. Synthetic data only. Nothing pushed.

## What changed

F01 (a human review decision beats an automatic one)
- `apps/api/src/rxwatcher.ts` `reviewRx`: the review write is now `UPDATE ... WHERE id = ? AND version = ? AND review IN ('none','clear','pending')` and the row count is checked. A miss keeps the human decision and writes the audit entry `rxwatcher.kept_human_decision`. The old code decided from `rx.review`, read before the model await, then wrote unconditionally.
- `apps/api/src/fill.ts` `scanFill`: inside the fill transaction the order is re-read. The fill is refused with 409 `review_changed` unless the order is still `to_fill`, is the same version with the same directions, quantity, days supply, NDC and drug, and its review is `clear` or `approved`. No dispense row is created. The refusal is audited as `fill.refused` (outside the rolled-back transaction). The earlier refusal for a non-fillable review state is audited too.
- `apps/api/src/prescriber.ts` `decide`: approve, reject and change request use one compare-and-set (`setReview`, `WHERE status='to_fill' AND review = <state read>`), 409 `review_changed` on a miss.
- `apps/api/src/agents/guardian.ts` `acceptSuggestion`: the hold is compare-and-set too, so a rejection or a fill that landed since the card was read is not overwritten.
- Not changed: `respond` (prescriber response) and the background loop. The first has no await before its writes, the second only calls `reviewRx`.

F04 (locally sold medicines in the safety rules)
- `apps/api/src/refills.ts`: one shared definition. `isOnProfile` (Active and Sold here are the same; Completed, Replaced, Discontinued, Stopped never count), `isCurrentMedicine` / `currentMedicines` (supply = filled_on + days_supply + `SUPPLY_GRACE_DAYS` = 30; unknown days supply assumed `DEFAULT_SUPPLY_DAYS` = 30), `dedupeFills` (same known drug and same date is one fill, the imported row wins over the local sale), and `loadPatientHistory` (imported history plus sold dispenses).
- `rxwatcher.ts` `runRules`: interactions and duplicate therapy use `currentMedicines`; the late-refill note uses it with `ignoreSupply` because a lapsed supply is exactly what that note reports. History is deduplicated first. `reviewRx` and `agents/rx.ts` now read `loadPatientHistory`, so Rx Watcher sees local sales at all (it only read `med_history` before).
- `agents/guardian.ts` `guardianHits`: same function for active medicines; the same-medicine-from-another-prescriber check uses `isOnProfile` instead of `status === "Active"`. `loadHistory` now delegates to `loadPatientHistory`.
- `refills.ts` `refillReport`: refill candidates use `isOnProfile`, and a fill present in both the history and the sale record is counted once.
- The two other `UNDO` copies are gone: `rxwatcher.ts` exports one `UNDO`, used by `agents/rx.ts` and `guardian.ts`. The pattern now also catches "nothing that needs review".

Wording defect 1 (Rx Watcher summary)
- `rxwatcher.ts` `modelSummaryAcceptable`: when a needs_review or block hit exists, a model summary is kept only if it does not match `UNDO` and names the hit count (digit or word). Otherwise the deterministic summary is used and `rxwatcher.summary_dropped` is audited. Cause: the mock provider cannot parse the prompt and always answers "The rules found nothing that needs review."

Wording defect 2 (Guardian cards)
- `guardian.ts`: facts that restate the order (`order: true`) are part of the written explanation and are no longer listed as evidence. Evidence is dated history facts only (`evidenceOf`). `ruleExplanation` no longer repeats history facts. `gateGuardian` strips a leading raw rule id ("non adherence: ...") from a model explanation.
- `apps/web/src/components/Suggestions.tsx`: the rule id is shown as a small separate mono field next to the title; the evidence block is hidden when empty. Field names are unchanged.

## Commands and results
- `pnpm typecheck`: all workspaces pass.
- `pnpm build:web`: built.
- `npx vitest run` (whole repo): 22 files, 443 tests pass. One earlier run showed a failure in `packages/coroner` property test COR-2 (random input, files not touched by this item); the next two full runs passed.
- Reviewer's file, my two tests only (copy run in a temp file, deleted afterwards, original untouched): "interaction rule includes current Active medicines", "... Sold here medicines" and "a slow automatic review cannot overwrite a pharmacist hold" pass.

## Which test proves which finding (`apps/api/test/review-f01-f04.test.ts`, 28 tests)
- F01: change request, reject, approve, two overlapping reviews (with and without a human decision), order edited, order replaced, hold landing after the review during scan parsing (caught inside the fill transaction), and the unchanged happy path. Each refusal case also checks no dispense row and the audit entries.
- F04: Guardian and Watcher pure rules for Active and Sold here; expired and grace boundary; discontinued, completed, replaced, stopped; duplicate history; unknown days supply; end to end receive-free sale of an unseeded insulin, then a ciprofloxacin order (Guardian demo-table interaction) and a semaglutide order (Watcher GLP-1 with insulin needs_review); expired-after-sale case; corrected order (change request, response, fill and sell of the new version, replaced original not counted); refill report counts a fill seen in both sources once.
- Wording 1: mock provider, four lying summaries, an honest summary naming the count (kept), no-hit case (summary kept), the shared check.
- Wording 2: mock provider through the Guardian run: no rule-id prefix, every evidence item has a date, evidence never appears inside the explanation, first evidence is a history fact.

## Not verified or not done
- I did not run my new tests against the unfixed code. The reviewer's F01 test fails on 30408a6 per the findings file, and the passing result above is on the fixed code.
- "Receives" in the end-to-end case is not exercised: the test uses the seeded shelf stock of the insulin lot (a fill and sell of an unseeded patient and order), not a new delivery scan.
- `patients.ts` (patient profile screen) still uses `status === "Active"`; it is outside my file list and is not a safety rule.
- The 30-day grace and 30-day default supply are my choices, documented in `refills.ts`. They keep the seeded demo insulin (52 days old, 30-day supply) current.
- Evidence for rules without a history fact (age band, allergy) is now empty, so the evidence block is hidden for them.
