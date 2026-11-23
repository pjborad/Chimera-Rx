# Kiroween criteria map

How Chimera Rx lines up with the Kiroween rules, with a pointer to proof in this repo for every claim. It does not predict or claim a prize result. Synthetic data only; a sandbox, not a clinical system. Built with HIPAA-style safeguards, not certified.

## 1. What the rules say, and how sure we are

**The live rules page could not be fetched.** `https://kiroween.devpost.com/` and `/rules` answered HTTP 403 to every fetch (rechecked 2026-11-23), and so did the 2025 mirror `https://kiroween-2025.devpost.com/` and the Devpost forum thread on evaluation criteria. A search engine returned snippets of the rules page, but those snippets are the 2025 event (judging period December 2025 to January 2026). I found no 2026 rules text I could read.

So everything below is the **2025 Kiroween ruleset**, plus what 2026 participants wrote in public posts. **The owner must open the live rules page and confirm the video length limit, the upload site for the video, the deadline and the submission fields** before submitting.

| Item | What was found | Source | Confidence for 2026 |
| --- | --- | --- | --- |
| Judging criteria (2025) | Three: Potential Value (useful, accessible, impactful), Implementation (how well Kiro's capabilities are used), Quality and Design (creative, original, polished). Judges are named industry experts. | [Kiro launch post, 2025](https://kiro.dev/blog/kiroween-2025/) | Likely the same; unconfirmed |
| Criteria weighting (2025) | Three equally weighted criteria; Implementation is about depth and variety of Kiro use; Potential Value includes a clear market need and an intuitive UI. | [Decoding Kiroween (dev.to, 2025)](https://dev.to/brian_mk/decoding-kiroween-4nm), a community summary of the rules | Unconfirmed |
| Frankenstein category | Stitch a chimera of technologies into one app; bring together seemingly incompatible elements into something unexpectedly powerful. | Kiro launch post (above); the 2026 write-ups below use the same wording | Consistent in 2025 and 2026 posts |
| Other categories | Resurrection, Skeleton Crew, Costume Contest. | Kiro launch post | 2025 |
| Submission contents (2025) | Public repository that includes the `.kiro` directory, a working app URL, a demo video of about three minutes, and a write-up of how Kiro was used. | Kiro launch post | Unconfirmed |
| Kiro usage write-up prompts (2025) | Vibe coding, agent hooks, spec-driven development vs vibe coding, steering docs, MCP. | Kiro launch post | Unconfirmed |
| Repo rules (2025) | OSI-approved licence visible; `.kiro` at the root and not in `.gitignore`; install and run instructions for judges; video under three minutes, judges need not watch beyond it. | Community summary (dev.to, above) | Unconfirmed |
| 2026 deadline | One 2026 entrant says the deadline is December 4 (the 2025 deadline was December 5). | [dev.to post by a 2026 entrant](https://dev.to/mateo_cocco_6905648eea0d2/my-first-kiro-app-was-a-winner-heres-how-im-building-a-monster-3ap9) | Single secondary source |
| 2026 Kiro features mentioned by entrants | Specs with EARS requirements, steering, hooks (command and agent), property-based tests, MCP and Powers, subagents, custom agents in `.kiro/agents`, workflows, a Memory feature, `/goal`, a local sandbox. | Same dev.to post; [Patchwork write-up](https://dev.to/ayanmohamedali7blip/building-patchwork-with-kiro-making-a-codebase-remember-why-4f5f) | Describes the tool, not the rules |

Content from these sources is paraphrased.

## 2. Criteria mapped to this repo

The 2025 criteria were Potential Value, Implementation (use of Kiro) and Quality and Design of the idea. Each row points at a file or a feature a judge can open.

| Criterion or expectation | Evidence in this repo |
| --- | --- |
| **Potential Value: a real problem** | Lot data and patient data live apart, so a recall means warning everyone or no one. Sourced case: `README.md` ("The pharmacy runs on yesterday's software"), `docs/MODERNIZATION.md` (by role, with a 90-day pilot plan), `docs/plan.md` section 1. |
| **Potential Value: measured, not asserted** | Server time from recall number to affected-patient list: `docs/evidence/timing.md`. Lot extraction on 50 real 2025 openFDA recall records: `docs/evidence/accuracy.md`. |
| **Potential Value: a whole workflow** | Screens in `apps/web/src/screens/`: Today, Receiving, Inventory, Register, Stock help, Transfers, Fill & pickup, Patients, Recalls, Refills, DSCSA & trace, Sandbox outbox, AI agents, Integrations. No demo pages or scenario launcher: the screens are the product. |
| **Potential Value: a judge can run it** | `docker compose up` or `pnpm install && pnpm setup && pnpm dev`; synthetic staff accounts and three things to try in `README.md`; `pnpm e2e` drives the real UI with a fake camera on its own ports (`scripts/e2e/run.mjs`, `harness.ts`, `demo-e2e.mjs`). |
| **Implementation: specs** | `.kiro/specs/coroner/` and `.kiro/specs/summoner/` (EARS requirements, design, tasks). Requirement ids travel into tests (`COR-3` in `packages/coroner/test/`, `SUM-3` in `packages/summoner/test/`). |
| **Implementation: steering** | `.kiro/steering/pharmacy-safety.md` (eleven safety rules, always loaded, each mapped to code and a test in `docs/SAFETY.md`), `product.md`, `tech.md`, `gs1-standards.md` (file match), `coroner-prompt.md` (the API reads its fenced prompt at runtime). |
| **Implementation: hooks** | `.kiro/hooks/phi-guard.json` (blocks PHI-shaped commits; `scripts/phi-guard.sh`, `.githooks/pre-commit`, CI), `pbt-on-save.json` (property tests on save), `usage-log.json` (appends finished tasks to `docs/KIRO_USAGE.md`). |
| **Implementation: MCP** | The app is an MCP server for partner AI agents (`POST /mcp`, `apps/api/src/partner-api.ts`, tests in `apps/api/test/platform.test.ts`). `.kiro/settings/mcp.json` lists two optional servers, both disabled; Kiro did not use MCP to build the repo. |
| **Implementation: agents** | Kiro custom agent `.kiro/agents/coroner.json` (scoped to `packages/coroner` and `packages/gs1`). In the product: eight advisory agents with a rules core, a gate after the model and pharmacist approval (`apps/api/src/agents/`, `docs/AGENTS.md`, `apps/api/test/agents.test.ts`, `guardian.test.ts`). |
| **Quality and Design: the idea** | Frankenstein: GS1 DataMatrix scanning, browser fax OCR, openFDA, regex-plus-LLM extraction, deterministic Rx rules, an NCPDP SCRIPT-shaped prescriber loop, FHIR R4, REST and MCP, signed webhooks, synthetic voice, hash-chained audit and EPCIS 2.0 (`packages/epcis`, `docs/DSCSA.md`) stitched into one ledger. One path from a faxed recall to sent messages is tested in `apps/api/test/store-flow.test.ts` and in `pnpm e2e`. |
| **Quality and Design: the build** | Screens built from the mockups in `prototype/` with shared tokens (`apps/web/src/components/kit.tsx`, `apps/web/src/styles/app.css`); persistent demo notice on every staff page; keyboard and scanner paths. 476 tests in 26 files (`apps/api/test`, `packages/*/test`), property tests with fast-check, CI in `.github/workflows/ci.yml`. No accessibility audit has been run. |
| **Quality and Design: safety and honesty** | `docs/SAFETY.md`, `docs/SECURITY.md` (threat model, patient fields encrypted at rest, key ring and rotation, role matrix, independent review findings F01 to F08 fixed). Built with HIPAA-style safeguards, not certified. |
| **Demo video** | Recording script: `docs/DEMO.md` (kept outside the app). The video is not uploaded (section 4); the length limit must be confirmed on the live rules page. |
| **Working app** | Run locally or with Docker. There is no hosted URL. |
| **Potential Value: path to a real pharmacy** | `docs/INTEGRATION_PLACEHOLDERS.md` lists every outside connection a deployment needs (messaging, voice, wholesaler, verification, e-prescribing, PMS, EHR, payer, secrets, KMS, SSO) with allowed data, consent and sandbox stand-in; `apps/api/src/channels.ts` makes the unwired seam visible and tested. |
| **Open source licence** | `LICENSE` (MIT). `package.json` also says MIT. |
| **`.kiro` directory present and not ignored** | `.gitignore` ignores only two generated files inside it (`.kiro/steering/aidlc-active-memory.md`, `.kiro/agents/aidlc-scoped-review-*.md`); everything else under `.kiro/` is tracked. |

## 3. Kiro features used, and where

Only what exists in the repo.

| Kiro feature | Where | What it did |
| --- | --- | --- |
| **Steering** | `.kiro/steering/product.md`, `tech.md`, `pharmacy-safety.md` (always); `gs1-standards.md` (file match, for `packages/gs1`); `coroner-prompt.md` (manual; the API reads its fenced prompt at runtime); `aidlc-onboarding.md` (always) | Kept synthetic-data and no-compliance-claim rules in force. `docs/KIRO_USAGE.md` records two catches: seed emails moved to a safe domain, and a sign-in line that implied compliance was removed. No before and after quality comparison was run. |
| **Specs (EARS)** | `.kiro/specs/coroner/` and `.kiro/specs/summoner/` (requirements, design, tasks). Requirement IDs appear in tests (`COR-3`, `SUM-3`). | Spec-driven build of the two extraction and openFDA packages. |
| **Hooks** | `.kiro/hooks/phi-guard.json` (PreToolUse: blocks a commit that looks like it holds PHI, backed by `scripts/phi-guard.sh`, `.githooks/pre-commit` and a CI step); `pbt-on-save.json` (runs the Coroner and GS1 property tests on save); `usage-log.json` (PostTaskExec: appends finished tasks to `docs/KIRO_USAGE.md`). The `aidlc-*` hooks belong to the AI-DLC workflow. | Automated safety and test checks. No time-saved figure exists. |
| **Custom agent** | `.kiro/agents/coroner.json` (scoped to `packages/coroner` and `packages/gs1`, property test first); the `aidlc-*` agents for AI-DLC. | Keeps extraction work inside its boundary. |
| **Property-based tests** | `fast-check` in GS1, Coroner, ledger and Rx Watcher tests. | `docs/KIRO_USAGE.md` lists four real bugs they or the real openFDA fixtures found. |
| **AI-DLC workflow** | `.kiro/skills/aidlc*`, `.kiro/aidlc-common`, and the record in `aidlc/spaces/default/intents/261116-judge-ready-pilot/` (intent, feasibility, scope, mockups, reverse-engineering knowledge base, practices, requirements, user stories). | Planned the judge-ready pilot. The run stopped at User Stories; later stages were not run (see section 5). |
| **MCP** | `.kiro/settings/mcp.json` lists two optional servers, both `disabled` (Playwright, AWS docs). **None was used to build this repo.** Chimera Rx itself exposes an MCP endpoint for partner AI agents (`POST /mcp`, `apps/api/src/partner-api.ts`, tests in `apps/api/test/platform.test.ts`). | The app is an MCP server; Kiro did not use MCP. |

Not used: Powers, Kiro's Memory feature, workflows, per-module specs for the Chimera Rx modules beyond Coroner and Summoner.

## 4. Submission checklist

Based on the 2025 rules. Re-check against the 2026 page.

- [x] Open source licence in the repo root (`LICENSE`, MIT).
- [x] `.kiro/` committed and not ignored.
- [x] Install and run instructions (`README.md`).
- [x] Kiro usage write-up (`docs/KIRO_USAGE.md`).
- [x] Demo recording script (`docs/DEMO.md`).
- [x] Public-data and safety statements (`docs/SAFETY.md`).
- [ ] **Demo video uploaded.** Confirm the length limit and the upload site on the live rules page first.
- [ ] **Public repository.** The local `origin` points at a repository whose name is a legacy project name (`Lotergeist`). Rename it to match, and confirm it is public, before submitting. Nothing was pushed from this work.
- [ ] **Working app URL.** None exists. Judges would run Docker or pnpm locally. A hosted sandbox needs a host and a decision about demo data.
- [ ] Category selected on the entry: Frankenstein.
- [ ] Re-read the live 2026 rules and fix anything that differs from section 1.
- [ ] Git author identity on the commits belongs to an employer account. Decide whether to rewrite it before making the repo public.

## 5. Honest gaps

- The 2026 rules and judging criteria were not read (section 1).
- No uploaded demo video, no hosted URL.
- One live Bedrock check (2026-11-20, Converse API, see `README.md`); otherwise the AI paths run with test doubles and the mock provider. Anthropic and OpenAI-compatible clients are tested only with stubs.
- The Docker build has not been verified on a machine with a working Docker daemon.
- The camera path was rehearsed with a fake camera, not a physical webcam.
- The AI-DLC run stopped at User Stories; later work was built outside its approval gates (`docs/KIRO_USAGE.md`).
- Specs exist only for Coroner and Summoner. The other modules were built from `docs/plan.md` and the mockups.
- MCP was not used as a Kiro build tool.
- Recall fixtures exist in two folders (`fixtures/recalls` for the package tests, `apps/api/fixtures/recalls` for the app). Two of the three files are identical, but `demo-synthetic.json` differs and each folder is loaded whole by its own consumers, so they were left alone.
- Staff sign-in emails use the `.example` top-level domain (for example `elmstreetrx.example`), not `example.com`.
- No claim of regulatory compliance, certification or clinical validity is made, and none should be added.
