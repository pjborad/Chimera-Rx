# Submission pack

Ready-to-paste Devpost text, a shot list for the video, and what the owner still has to do. Category: **Frankenstein**. Synthetic data only. Built with HIPAA-style safeguards, not certified; no claim of compliance, certification or clinical validity.

## Devpost write-up

### Project name

Chimera Rx

### Tagline

A modern, agent-assisted pharmacy system, stitched together from parts that were never meant to fit: one ledger that knows the lot, the patient and the history, with agents that watch it and a pharmacist who decides. A recall is the proof.

### Inspiration

A pharmacy runs on yesterday's software. Wholesalers track drugs by lot, dispensing systems track them by patient, and the two never meet. Recalls and prescriber changes travel by fax and phone, cold-chain and count checks sit on paper, and alerts get overridden (published studies put override rates at [more than half](https://pubmed.ncbi.nlm.nih.gov/24166725/)). The lot is printed in the 2D barcode on every package and nobody records it at the counter, so a recall means warning everyone or no one. Package-level traceability is also becoming the rule under the DSCSA (the FDA gave small dispensers [an exemption to November 27, 2027](https://www.fda.gov/drugs/drug-supply-chain-security-act-dscsa/exemptions-under-drug-supply-chain-security-act)). We wanted to modernize the whole counter with parts that already exist, a Frankenstein of scanners, OCR, openFDA, EPCIS, FHIR, MCP and language models stitched into one ledger. The recall is the sharpest proof, not the whole product. The long case is in [MODERNIZATION.md](MODERNIZATION.md).

### What it does

Chimera Rx is a pharmacy system built on one lot ledger. It captures lot and serial when a package arrives and again when it is handed to a patient, by GS1 DataMatrix scan (camera or USB scanner) or by OCR for labels with no barcode. When a recall arrives (a typed FDA number, a faxed notice read by OCR in the browser, or a nightly openFDA poll), it finds the units on the shelf, quarantines them, finds the patients who took one home, and drafts the messages. A pharmacist approves every step, and every message goes to a sandbox outbox.

Around that core, the pilot covers the rest of a pharmacy's day:

- Receiving with four checks (invoice, supplier transaction information, expiry, recall) and Schedule II witnessing.
- Rx Watcher: deterministic prescription rules, with a prescriber change-request loop.
- DSCSA-style traceability: EPCIS 2.0 export and dry-run import, a sandbox verifier, suspect-product cases and a recall trace export.
- Recall-aware refills with adherence (PDC), medication sync and a recall hold.
- A front-store register that also sells one patient's verified prescriptions, and blocks recalled lots.
- Two stores with separate databases, transfers that keep lot and serial, and recalls mirrored across stores.
- Eight AI agents, four of which can run in the background once a pharmacist switches them on. The Rx Guardian checks each new order against the patient's history and raises suggestions with evidence that a pharmacist accepts or dismisses. Amazon Bedrock is the default provider and swappable Anthropic, OpenAI-compatible (OpenAI, Azure, Ollama), mock and rules-only modes. A judge can switch provider and paste a key on the AI agents screen.
- Partner surfaces: REST, MCP and FHIR R4 behind OAuth 2.0 scopes, plus HMAC-signed webhooks.
- Patient fields encrypted at rest with AES-256-GCM, a key ring with rotation, hardened API headers, rate limits, roles, optional MFA and a hash-chained audit log.

### How we built it with Kiro

- **Steering.** `.kiro/steering/pharmacy-safety.md` holds eleven safety rules that load on every request. Each rule is mapped to code and to a test in `docs/SAFETY.md`.
- **Specs.** The Coroner (lot extraction) and Summoner (openFDA client) were built from EARS requirements, and requirement ids such as COR-3 ("never invent a lot") travel into tests.
- **Hooks.** A PHI guard blocks commits that look like patient data (also a git hook and a CI step). A hook runs the property tests when the Coroner or GS1 code is saved.
- **Property-based tests.** fast-check checks that on-hand stock equals received minus dispensed, returned and adjusted, that no serial is dispensed twice, and that the Coroner never emits a lot that is not in the source, even when a stub model lies.
- **Agents and subagents.** A custom agent scoped to the Coroner and GS1 packages. The pilot rounds were run as parallel workers with an independent review pass of the API and the web app; the reviews found and fixed real bugs (double-submitted fills, plaintext agent records, a loose lot-matching gate).
- **MCP.** Chimera Rx exposes an MCP endpoint so partner AI agents can query the ledger with scoped keys. We did not use an MCP server to build it.

The honest account, including gaps, is in `docs/KIRO_USAGE.md`.

### Challenges

- **Not inventing a lot.** A model reading a recall notice can return a plausible lot that is not on the page. The Coroner keeps a lot only if it appears as a whole token in the source, and an independent review found the first version of that gate accepted slices of a real lot. It was rewritten and tested with hostile inputs.
- **Encryption without breaking search.** Patient fields are sealed inside SQLite, and search decrypts in memory because a blind index only supports exact match.
- **Keeping AI advisory.** Each agent has a rules core, an optional model, and a gate after the model. Prompts never carry names, phones, emails or dates of birth.
- **Demonstrating a camera flow without a camera.** The end-to-end run swaps the webcam for a canvas that holds up generated labels.

### Accomplishments

- A recall goes from a faxed notice to a patient list and approved messages, end to end, in one flow.
- 476 unit, API and property tests pass in 26 files, and the end-to-end browser run passes against the real UI (49 of 49; 51 of 51 with `MFA=1`; see `docs/evidence/items/final-round.md`).
- Every safety rule has an enforcing file and a proving test.
- An agent platform where a lying model cannot remove a rule hit, add a lot, or put a name into a voicemail.

### What we learned

- Writing safety rules as steering and mapping each one to a test kept later features honest.
- Independent review is worth its own round: it found bugs the builders' tests did not.
- Honest limits belong in the README. A sandbox labelled as a sandbox is more useful to a judge than a claim.

### What is next

- A latency and cost check on live Bedrock (one live run has been done).
- A real KMS key provider and TLS in front of the API.
- A licensed drug-interaction source instead of the curated rule table.
- A hosted sandbox and a physical-webcam test with printed cartons.
- Per-module Kiro specs for the receiving, fill and recall modules.

### Built with

TypeScript, Node 22+, Fastify, node:sqlite, React, Vite, zod, tesseract.js, bwip-js, fast-check, Vitest, Playwright, Amazon Bedrock (default agent provider), Anthropic and OpenAI-compatible APIs, openFDA, GS1, EPCIS 2.0, FHIR R4, MCP, Kiro.

### Try it

`docker compose up` and open http://localhost:4000, or `pnpm install --frozen-lockfile && pnpm setup && pnpm dev` and open http://localhost:5173. Type `j.rivera@elmstreetrx.example` / `moonlight-rx-2026` on the sign-in page (synthetic pharmacist; the form is not pre-filled). The Docker image build was not run on the machine that wrote this repo.

## 3-minute demo video shot list

The submission video is `demo-video/chimera-rx-submission.mp4` (gitignored; 1920x1080, H.264 and AAC, 2:54, one male Kokoro voice `am_onyx`, no music) with `chimera-rx-submission.srt`. Story: about 45 percent modernization of pharmacy systems (the recall is one example of the gap legacy systems leave), about 35 percent AI agents with a pharmacist in the loop, the rest a tab tour by role. Rebuild with `pnpm demo:record:submission`. The spoken script is [DEMO_VIDEO_SCRIPT.md](DEMO_VIDEO_SCRIPT.md). Confirm the length of the uploaded file is under 3:00.

| Time | Shot | Voice-over |
| --- | --- | --- |
| 0:00 | Sign-in, typed login, six-digit code, Today | Fax, phone and paper vs one connected ledger linking lot, patient and prescription. |
| 0:19 | Technician receiving, pharmacist inventory and fill, cashier register, refills and patients | A quick tour by role. |
| 0:43 | Recall D-0611-2026: fax OCR, lots, confirm, quarantine, patients, messages | The gap old systems leave (the lot was never captured) and how a connected system closes it. |
| 0:57 | DSCSA and EPCIS export and verifier, partners and MCP, two-store transfer, outbound placeholder list | Open standards, signed webhooks, designed seams sandboxed today. |
| 1:31 | AI agents page, Rx Guardian Run now, suggestions with evidence and accept, Coroner gate, provider selector | Rules decide, the model explains, a gate checks the model, a pharmacist decides. |
| 2:28 | Audit chain | Encrypted PHI, server-side roles, hash-chained audit. HIPAA-style safeguards, not certified. |
| 2:38 | Animated Kiro card, animated end card | Specs, steering, hooks, custom agent, Kiro Crew. Repo URLs, synthetic data only. |

## Rules check (2026 submission requirements)

From the requirements the owner pasted on 2026-11-23. Status as of that day.

| Requirement | Status |
|---|---|
| Project built with Kiro | Yes. `.kiro/` (specs, steering, hooks, agents) and `docs/KIRO_USAGE.md` |
| URL to a functional application, login details in the form | **https://pjborad.github.io/Chimera-Rx/app/** (browser preview: the real app and API code run inside the page, no server, no login to GitHub; built by `.github/workflows/pages.yml`). Full server version: `docker compose up` or Codespaces. Logins: the seeded staff accounts, shared password `moonlight-rx-2026` (synthetic) |
| Text description of features | Devpost write-up above |
| Video under 3 minutes, on YouTube, public, link in the form | **Video ready, not uploaded.** `chimera-rx-submission.mp4` is 2:50. Only the owner can upload it to YouTube as public |
| Video shows the project running on its device | The video is a browser screen recording of the running app |
| No third-party trademarks or copyrighted music | No music; the voice is a locally generated open model. Frames checked, no logos |
| Public GitHub repo with source, assets and instructions | Public: `pjborad/Chimera-Rx`. README has setup |
| Open source licence visible in the About section | `LICENSE` is MIT and GitHub detects it |
| `/.kiro` at the root, not in `.gitignore` | `.kiro/` is committed. `.gitignore` still lists two generated `.kiro` files (`steering/aidlc-active-memory.md`, `agents/aidlc-scoped-review-*.md`), added by AI-DLC. Remove those lines if you want zero risk |
| Category | Frankenstein. Bonus categories: owner to choose |
| How Kiro was used | `docs/KIRO_USAGE.md`, "Answers to the judging questions" |

## Owner checklist

These need a person. Nothing in this repo can do them.

- [ ] **Record the video** (under 3:00) and upload it to YouTube as public; paste the link into Devpost and into `docs/index.html` (replace the "Not recorded yet" line).
- [ ] **Make the repository public** and check that `.kiro/` is visible and not ignored.
- [ ] **Choose the licence holder name.** `LICENSE` is MIT and names the current copyright holder; change it if the entry belongs to someone else or to a team.
- [ ] **Check the Kiroween rules page** (2026). The criteria in `docs/KIROWEEN.md` came from the 2025 launch post and community summaries because the official pages could not be fetched. Fix anything that differs, including the deadline.
- [ ] **Rename the git remote and repository.** The `origin` URL still carries a legacy project name. Rename the repository to match, or point `origin` at a new one. Nothing has been pushed from this work.
- [ ] **Set the git author.** Existing commits carry a work email as the author. Decide whether to rewrite author identity before the repository is public, and set `git config user.name` and `user.email` to the identity that should own the entry.
- [ ] **Run `docker compose up` once** on a machine with a working Docker daemon and confirm the sign-in page loads at http://localhost:4000.
- [ ] **Do one live model check** if you want to claim it: set `LLM_PROVIDER=bedrock` with AWS credentials, press **Test connection** on AI agents, and run one agent.
- [x] **Hosted URL:** https://pjborad.github.io/Chimera-Rx/app/ (GitHub Pages, browser preview). Switch Pages source to "GitHub Actions" once so the workflow can deploy.
- [ ] **Choose the category** on the entry form: Frankenstein.
- [ ] **Remove screenshots or text you do not want public** (the `docs/img/` pictures are of synthetic data only).
