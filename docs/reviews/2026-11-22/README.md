# Independent review, 2026-11-22

Our summary of an independent review. Reviewer: `ict-intelligence`. Reviewed commit: `30408a6`. Where it was reported: issue #5 and PR #4 of this repository. The reviewer's ZIP, HTML report and screenshots are not copied here; the acceptance test file is (see below).

On the unfixed commit the lead reproduced the reviewer's result: of 21 acceptance tests, 7 pass and 14 fail.

| Id | Priority | Finding | Our verification |
|---|---|---|---|
| F01 | P1 | An automatic review that finishes late overwrites a pharmacist hold, and the order can then be filled | Reproduced by the acceptance test "a slow automatic review cannot overwrite a pharmacist hold" |
| F02 | P1 | A destination store with a pending recall row never receives the confirmation | Reproduced by the recall propagation test with an existing pending row |
| F03 | P1 | Cashier and admin can read clinical agent runs and recall patient details through read endpoints | Reproduced by the role read tests (agent runs, recalls, results) |
| F04 | P1 | Medicines with the history status "Sold here" or "Active" are left out of some interaction rules | Reproduced by the history continuity tests |
| F05 | P1 | An interrupted cross-store transfer can leave one serial on both shelves | Reproduced by the transfer failure test |
| F06 | P2 | Store 2 outputs keep Store 7 identity and contact details | Reproduced by the store boundary tests |
| F07 | P2 | The provider destination policy accepts IPv4-mapped link-local addresses | Reproduced by the reviewer's destination checks |
| F08 | P2 | The owner-only key file claim does not hold on Windows (chmod has no effect there; 3 POSIX permission assertions and 2 fixture paths built with `URL.pathname` failed) | Confirmed from the reviewer's permission listing; not part of the 21 acceptance tests |

Status of each fix and what the review did not cover: docs/SECURITY.md, section "Independent review".

## Acceptance tests

`acceptance/independent-review-2026-11-22.test.ts` is the reviewer's file, unchanged. Its imports are relative to `apps/api/test/`, so it does not run from this folder. To run it, copy it there and run vitest from the repository root:

```
cp docs/reviews/2026-11-22/acceptance/independent-review-2026-11-22.test.ts apps/api/test/
pnpm exec vitest run apps/api/test/independent-review-2026-11-22.test.ts
```

Delete the copy afterwards if you do not want it in the regular suite. The regression tests we wrote for each finding are the `apps/api/test/review-f*.test.ts` files.
