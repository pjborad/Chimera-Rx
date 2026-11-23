# How Kiro was used

An honest account. Kiro (the agent, in Kiro IDE) wrote most of this repo from a written spec and uploaded HTML mockups, with a person directing each step. Anything that was not measured or not run is marked.

## The arc

1. **First idea: Body Snatcher Rx.** A recall hunter that read a 1998 pharmacy terminal with a Playwright bot. Kiro built it from six specs. It worked, but the pharmacist had to trust lot numbers inferred after the fact.
2. **Pivot: Chimera Rx.** The better fix is to capture the lot when it is in your hand: at receiving and at fill. A new product spec and six mockups arrived; Kiro built the API and web app beside the old code, then rebuilt the screens from the mockup markup when the first pass only matched the colours.
3. **Platform.** Rx Watcher, the prescriber change loop, Patients, voicemail outreach and the partner API (REST, MCP, FHIR) were added against `docs/plan.md`.
4. **Cleanup.** The Body Snatcher apps and packages were removed. Three of its packages survive because Chimera Rx uses them: `gs1`, `summoner`, `coroner`.

## Specs

`.kiro/specs/coroner` and `.kiro/specs/summoner` hold `requirements.md` (EARS), `design.md` and `tasks.md`. Requirement IDs travel into tests (`COR-3`, `SUM-3`). The specs for the earlier Body Snatcher modules were deleted with that code.

**Gap, stated plainly:** the Chimera Rx modules (receiving, inventory, fill, recall impact, outreach, partner API, Rx Watcher) were built from `docs/plan.md` and the mockups, not from per-module Kiro specs. `docs/plan.md` §15 lists the specs that should exist; they have not been written.

## Steering

`.kiro/steering/`: `product.md`, `tech.md` and `pharmacy-safety.md` load on every request; `gs1-standards.md` loads for `packages/gs1`; `coroner-prompt.md` is manual and the API reads its fenced prompt at runtime. The safety rules were followed during the build: for example, the first test run caught seed emails on `mail.example`, and they were moved to `example.com`; the SignIn mockup's "Access is logged for HIPAA audit" line was changed because rule 11 forbids compliance claims. **No before/after comparison of output quality was run.**

## Hooks

`.kiro/hooks/`:
- `pbt-on-save`: runs the Coroner and GS1 property tests when their files are saved.
- `phi-guard`: PreToolUse on shell commands; blocks `git commit` when staged files look like PHI. Also a git pre-commit hook and a CI step.
- `usage-log`: PostTaskExec; appends finished spec tasks to the log below.

No time-saved numbers exist.

## Agents

`.kiro/agents/coroner.json` scopes a custom agent to `packages/coroner` and `packages/gs1`, loads the GS1 and safety steering, and requires property tests before it finishes.

## MCP

No MCP server was used to build this repo. Chimera Rx *exposes* an MCP endpoint (`POST /mcp`, JSON-RPC, tools filtered by OAuth scope) for partner AI agents; it is tested in `apps/api/test/platform.test.ts`.

## Property-based tests (fast-check)

- GS1 check digits, NDC ↔ GTIN round trips, element strings with FNC1.
- Coroner: lots are never invented, even when a fake LLM lies (COR-3).
- Ledger: under random sequences of receive, fill, send back, adjust and recall, on hand always equals received − dispensed − returned − adjusted, no serial is dispensed twice, and every dispensed serial was received.
- Rx Watcher rules.

## Bugs the tests found

- **Ledger property, first run:** about 1 in 97 seeded historical fills had no package, which broke the reconciliation invariant. The seed quirk was removed.
- **OCR NDC parsing:** `70OO4-226-O1` (O for 0) was not repaired because the hyphens were mangled before the letter fix. Now each segment is fixed separately.
- **Put-away locations:** `Bin -9` appeared because a signed bit shift went negative on large hashes. Fixed with unsigned shifts.
- **Real openFDA records** (50 from 2025) found three Coroner defects that hand-written generators missed: `Mar-25` expiries read as lots, plural `Lots:` not recognised, and lot lists cut off after `;`.

## Rehearsal without a camera

`pnpm e2e` (`scripts/e2e/run.mjs`) starts its own stack on ports 4650/4651 (`scripts/e2e/harness.ts`: the real API on a fresh synthetic database, serving the built web app, plus a loopback-only control port for reseeding and scenario fixtures). `scripts/e2e/demo-e2e.mjs` swaps `getUserMedia` for a canvas that holds up generated DataMatrix labels and a printed text label, then drives the real UI: scan, put-away, a bad serial reported as a problem, label OCR, a fill, and the fax-OCR recall through to messages sent, then the pilot screens. On 2026-11-23, 49 of 49 checks passed, and 51 of 51 with `MFA=1` (the two MFA checks run only then). The run covers AI agents, refills, DSCSA, register, transfers and cashier restrictions. **This is not a test of a physical webcam, lighting or print quality.**

## AI-DLC record

The judge-ready pilot was planned with AI-DLC (the `aidlc/` folder and `.kiro/aidlc-common`, `.kiro/skills/aidlc`). Its record for this intent, `aidlc/spaces/default/intents/261116-judge-ready-pilot/`, holds the intent statement, feasibility, scope, rough mockups, the reverse-engineering code knowledge base (`aidlc/spaces/default/codekb/Kiroween/`), practices, requirements and user stories.

**Gap, stated plainly:** the run reached User Stories. The stories, the traceability file and the Must-priority build (scenarios, now test fixtures in `apps/api/test/scenario-fixtures.ts`; the generated dataset, the evidence scripts, Docker, Codespaces config) were written in one session from those requirements, outside the AI-DLC approval gates, because this tool could not record gate approvals. No gate approval was recorded or faked: approvals need the owner, typed in Kiro. The later AI-DLC stages (domain design, units, contracts, delivery planning, functional and NFR design, code generation records, build and test, CI) were not run. The register, second sign-in factor and stock help were added afterwards (`register.ts`, `mfa.ts`, `stockhelp.ts`, tests in `apps/api/test/pilot-platform.test.ts`), also outside the gates. Two stores (FR4) followed (`stores.ts`, `crossstore.ts`, `seed-store2.ts`, `apps/api/test/two-stores.test.ts`).

## Not done


- Per-module Kiro specs for the Chimera Rx modules.
- More than one live LLM run (one Bedrock check on 2026-11-20; otherwise test doubles and the mock).
- A physical webcam test.
- Hosting (judges run it locally with Docker), the submission video, and a run of the Docker build on a machine with a working Docker daemon.

## Usage log

Appended by the `usage-log` hook after each completed spec task.

| Time (UTC) | Task | Files changed |
| --- | --- | --- |
