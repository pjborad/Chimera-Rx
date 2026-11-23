# The 3-minute competition cut

About 440 spoken words, which is about 2 minutes 57 seconds at 150 words a minute. That leaves almost no room for screen changes, so trim a sentence or two in rehearsal (the first candidates are in beats 3 and 6). It touches every judging criterion we could find. The long version is [DEMO_FULL.md](DEMO_FULL.md); the Fill & pickup paths are in [FILL_PATHS.md](FILL_PATHS.md).

Synthetic data and sandbox messaging throughout. Say "sandbox" whenever something is simulated. Never say "compliant", "certified" or "clinically validated", and do not mention a prize.

## 1. Where the criteria come from, and what could not be read

| What | Source | Status |
| --- | --- | --- |
| Three judging criteria: **Potential Value** (useful, accessible, impactful), **Implementation** (how effectively Kiro's capabilities were used), **Quality and Design** (creative, original, polished) | The official 2025 launch post, read in full on 2026-11-20: [kiro.dev/blog/kiroween-2025](https://kiro.dev/blog/kiroween-2025/) | Read. These are the 2025 criteria. |
| 2025 submission requirements: public code repository with the `.kiro` directory, a functional application URL, a 3-minute demonstration video, and documentation of how Kiro was used (vibe coding, agent hooks, spec-driven development, steering, MCP) | Same post | Read. 2025 rules. |
| Equal weighting of the three criteria; an OSI-approved licence visible in the repo; `.kiro` at the root and not in `.gitignore`; the video must run under three minutes and judges need not watch beyond it | A community summary of the 2025 rules: [dev.to, "Decoding Kiroween"](https://dev.to/brian_mk/decoding-kiroween-4nm) | Read, but secondary. Check the rules page. |
| **2026 rules and judging criteria** | `https://kiroween.devpost.com/`, `/rules`, `/details/criteria`, and the 2025 mirror `https://kiroween-2025.devpost.com/` | **Not readable.** Every fetch returned HTTP 403, as in [KIROWEEN.md](KIROWEEN.md). The criteria page was not retrieved. |
| 2026 eligibility: only new projects, built during the submission period of October 30 to December 4, 2026, are eligible | A search-engine snippet of the 2026 Devpost page (the page itself returned 403) | Snippet only. This repository's first commit is dated 2026-11-06 (project name then "Lotergeist", renamed Chimera Rx on 2026-11-16), which is inside that period. Check the rules page. |
| 2025 Devpost page summary: judged on potential value, implementation of Kiro, and creativity | Search-engine snippet of `kiroween-2025.devpost.com` (403 on fetch) | Snippet only. |
| Frankenstein category: stitch together a chimera of technologies into one app, bringing together seemingly incompatible elements into something unexpectedly powerful | The 2025 launch post | Read. Consistent with 2026 write-ups cited in [KIROWEEN.md](KIROWEEN.md). |
| Which site the video must be uploaded to, whether a hosted URL is mandatory in 2026, whether the video needs captions or a spoken narration, and the 2026 length limit | Not found for Kiroween. Other Devpost events in the search results use three minutes. | **Check the rules page.** Do not assume. |
| Winners' write-ups | The searches returned 2026 entrants' drafts and posts about building, not a winners' list. I found nothing that states what judges favoured. | Nothing to cite. |

Treat the three criteria and the 3-minute video as the working assumption, and re-read the live rules page before submitting.

**Known gaps to fix before submitting** (from [KIROWEEN.md](KIROWEEN.md) section 4): no hosted application URL exists, so judges would run Docker or pnpm; the video is not yet recorded or uploaded; confirm the repository is public under the right name.

## 2. Coverage table

| Criterion | Beat that covers it | What is on screen |
| --- | --- | --- |
| Potential Value: a real problem, market need | 1 (problem), 3 (a modern system, not a recall tool) | Sign-in page with the demo notice, then Today with the recall banner and the guardian card |
| Potential Value: usable, intuitive | 2 to 4 | One flow from fax to patients to messages; the Fill queue with plain chips |
| Implementation: Kiro steering | 7 | `.kiro/steering/pharmacy-safety.md`, eleven rules, always loaded |
| Implementation: specs | 7 | `.kiro/specs/coroner/requirements.md` with `COR-3`, and the same id in a test |
| Implementation: hooks | 7 | `.kiro/hooks/phi-guard.json`, `pbt-on-save.json` |
| Implementation: MCP | 7 (honest) and 5 | Said plainly: Kiro did not use MCP to build; the app is an MCP server |
| Implementation: AI-DLC and agent-assisted build | 7 | `aidlc/` record and the review evidence in `docs/evidence/items/` |
| Quality and Design | 2 to 4 | Polished screens from the prototype, keyboard and scanner paths, dark and light |
| Frankenstein | 2, 8 | Fax OCR, openFDA, GS1 DataMatrix, rules, an LLM behind a gate, EPCIS, FHIR, MCP, synthetic voice, hash-chained audit, in one flow |
| Security and trust | 6 | SECURITY.md and the "not covered" list; audit verify |
| Demo-video rules (3 minutes, show it working) | Whole cut | Under three minutes, starts on the problem, shows the app running |

## 3. The script

Clicks assume a fresh **Reset demo**, the pharmacist signed in, and `LLM_PROVIDER=mock` (or Bedrock after `aws sso login`).

### Beat 1. The problem (0:00 to 0:20, about 55 words)
**Screen:** sign-in page, demo notice visible, then Today with the red recall banner.

> The pharmacy runs on yesterday's software. Lot data lives with the wholesaler. Patient data lives in the dispensing system. Nobody records which lot a patient took home. [pause] So when a lot is recalled, a pharmacy warns everyone, or no one. Chimera Rx is a modern pharmacy system built on one ledger, and the recall is the proof.

### Beat 2. The recall (0:20 to 0:50, about 70 words)
**Screen:** Recalls, **Read this fax with OCR**, the lots, **Review impact**.

> This fax arrived overnight. The browser reads it, openFDA confirms it, and the Coroner extracts the lots. A lot is kept only if it is printed in the notice, word for word. If a model invents one, it is dropped, and you can see it. [pause] One click quarantines the exact units on the shelf and lists the patients who took one home, with the channel each agreed to.

### Beat 3. Messages (0:50 to 1:12, about 55 words)
**Screen:** **Continue to patient messages**, **Use AI draft**, attestation, send, **Sandbox outbox**.

> An agent drafts the messages and cannot send them. The pharmacist reads, attests and sends. Consent is checked at send time. Each text names only that patient and carries a STOP option. A voicemail never names the medicine. Nothing leaves this laptop. It goes to a sandbox outbox.

### Beat 4. The counter (1:10 to 1:37, about 75 words)
**Screen:** Fill & pickup, Rx 0072210: Rx Watcher findings, the Rx Guardian suggestions, **Accept: hold the order**.

> The same ledger runs the counter. Plain rules flag this insulin order. The Rx Guardian reads the patient's history and shows its evidence: gaps in insulin fills and a late refill. A pharmacist accepts, and the order holds. If a scan has no serial, we say the serial is assumed, never scanned. And scanning a recalled lot at the counter is refused, even after the recall closes.

### Beat 5. The agents (1:37 to 2:02, about 60 words)
**Screen:** AI agents: provider card, the Rx Guardian card with **Switch on**, a run with its dropped list.

> Eight agents follow one pattern. Rules decide. The model explains. A gate checks the model. A pharmacist decides. They can run in the background. Amazon Bedrock is the default, and you can bring your own model or run rules only. Prompts never carry names. Tests use lying models, and the gates catch them.

### Beat 6. Security (2:02 to 2:18, about 50 words)
**Screen:** SECURITY.md, then `GET /api/audit/verify`.

> Patient fields are encrypted at rest, roles are enforced on the server, and the audit log is hash-chained. Messages go only to a sandbox. We list what is not covered: no TLS in the app, no managed keys, no independent review. It is a sandbox.

### Beat 7. Built with Kiro (2:18 to 2:45, about 65 words)
**Screen:** the `.kiro` folder: `steering/pharmacy-safety.md`, `specs/coroner`, `hooks/phi-guard.json`, then `docs/KIRO_USAGE.md`.

> Built with Kiro. Steering holds eleven safety rules that always load. Specs cover the Coroner and openFDA client, and requirement numbers appear in the tests. A hook blocks commits that look like patient data. We planned with AI-DLC and used independent agent reviews. To be straight: we did not use MCP to build, and only two modules have specs.

### Beat 8. Close (2:45 to 2:58, about 50 words)
**Screen:** Integrations, then back to Today.

> What exists today: REST, MCP, FHIR, signed webhooks and EPCIS. Wholesaler exchange, real e-prescribing and payer links are future work, not built. [pause] Barcodes, fax OCR, openFDA, an LLM behind a gate, one ledger. Chimera Rx: a modern pharmacy system, and the recall is the proof.

## 4. Delivery notes

- The first ten seconds decide the rest. Open on the problem, not the logo.
- Show the dropped lot in beat 2. It is the most memorable moment.
- If a step stalls, cut to the next beat. Do not apologise on camera.
- If Bedrock is down, press **Test connection**, switch to `mock`, and say "offline mock".
- Do not claim HIPAA compliance, clinical validity, certification or a result in the competition.
