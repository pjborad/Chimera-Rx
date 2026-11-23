# Chimera Rx

**A modern, agent-assisted pharmacy system. One ledger holds the lot, the patient and the prescription history, agents watch it in the background, and a pharmacist decides. A recall is the sharpest proof.**

**Kiroween 2026, Frankenstein category. Built with Kiro.** Demo environment: synthetic data only, not for clinical use, not HIPAA-compliant, no compliance or certification claim of any kind. See [docs/SAFETY.md](docs/SAFETY.md).

![Sign-in page with the demo accounts and the demo notice](docs/img/sign-in.jpg)

## The pharmacy runs on yesterday's software

A dispensing system answers one question well: what did this patient get? Most of what a pharmacy has to do around that question still runs on older tools.

- **Old core, thin integration.** Pharmacy management systems have been evolving for [about four decades](https://intuitionlabs.ai/articles/pharmacy-management-systems-guide), and buyer guides for independent pharmacies still list [integration between dispensing, point of sale and mobile communications](https://datascanpharmacy.com/what-is-the-best-retail-pharmacy-software-for-independent-pharmacies-in-2026/) as what separates modern software from outdated tools. Several long-running products have also been [consolidated under one corporate owner](https://datascanpharmacy.com/is-your-pharmacy-software-shutting-down-or-being-sunset/). We found no sourced figure for the average age of an installed system, so we give none.
- **Lot data and patient data live in different places.** Wholesalers and manufacturers track a package by lot and serial. The dispensing record tracks the patient and the drug, and usually not which lot went home. That is the premise of this project, not a measured statistic; the design is in [docs/DSCSA.md](docs/DSCSA.md).
- **Recalls reach patients by hand.** An FDA and UCSF research team calls individual patient notification of drug recalls [a problem with complex challenges](https://www.medrxiv.org/content/10.1101/2024.09.18.24312141v1.full.pdf) (preprint, not peer reviewed): consumer-level recalls usually depend on each patient acting. Prescriber changes still travel by fax and phone in pharmacy programs; one published pharmacy-benefit program [sent 8,075 fax alerts](https://pubmed.ncbi.nlm.nih.gov/24761821) to prescribers (an older study, cited for the channel, not for today's volume).
- **Cold chain and counts are paper or a spreadsheet.** A CDC simulation of vaccine storage found that reading a thermometer twice a day, without min/max, [caught only 4.8 to 6.4 percent of temperature excursions](https://stacks.cdc.gov/view/cdc/119983/cdc_119983_DS1.pdf). Vaccine units are not pharmacy shelves, but the point carries: a spot reading misses what happened between readings.
- **Alerts that get overridden.** In a study of community pharmacies, [289 of 510 relevant interaction alerts](https://pubmed.ncbi.nlm.nih.gov/17381663/) were overridden with no action. In a large outpatient study, [52.6 percent of 157,483 medication alerts](https://pubmed.ncbi.nlm.nih.gov/24166725/) were overridden, and a 2023 allergy-alert study reported a [98.9 percent override rate](https://pubmed.ncbi.nlm.nih.gov/41613422/). When most alerts say nothing new, the one that matters gets the same click.
- **Tired staff, thin margins.** A survey of 412 community pharmacists reported that [74.9 percent had burnout in at least one domain](https://www.pharmacytimes.com/view/pharmacist-burnout-poses-challenges-to-patient-access). The 2024 NCPA Digest describes independent pharmacies [closing at more than one a day](https://www.drugtopics.com/view/2024-ncpa-digest-highlights-challenges-in-independent-pharmacy-ncpa-2024).
- **Package-level traceability is now the rule.** The FDA says the DSCSA enhanced distribution security requirements are meant to enable [interoperable, electronic tracing at the package level](https://www.fda.gov/media/194424/download). The one-year stabilization period ran from November 27, 2023 to [November 27, 2024](https://www.fda.gov/media/179256/download). For small dispensers (25 or fewer full-time pharmacists and technicians counted on November 27, 2026) the FDA [extended an exemption to November 27, 2027](https://www.fda.gov/drugs/drug-supply-chain-security-act-dscsa/exemptions-under-drug-supply-chain-security-act), and other dispensers who cannot comply may request a waiver. Check your own status with the FDA; this README is not advice.

Sources were checked on 2026-11-20. The full list, and what we left out for lack of a source, is in [docs/evidence/items/market.md](docs/evidence/items/market.md).

## One ledger, agents on top

```mermaid
flowchart LR
  subgraph Before["Before: separate silos"]
    direction TB
    W["Wholesaler records<br/>lot and serial"]
    D["Dispensing system<br/>patient and drug"]
    P["Paper or spreadsheet<br/>cold chain and counts"]
    F["Fax and phone<br/>recalls, prescriber changes"]
    A["Alert popups<br/>override and move on"]
  end
  subgraph After["After: Chimera Rx"]
    direction TB
    L[("One lot ledger<br/>lot, serial, patient, history")]
    G["Agents in the background<br/>Rx Guardian and others"]
    H["Pharmacist decides<br/>accept, dismiss, send"]
    X["Sandbox outbox, EPCIS,<br/>REST, MCP and FHIR"]
    L --> G --> H
    L --> X
  end
  Before --> After
```

The recall is the sharpest proof because it needs every silo at once: the lot (receiving), the patient (fill), the history (refills), the contact (consent) and a decision (pharmacist).

## Gaps we close

| Old way | Chimera Rx way | Where in the app |
| --- | --- | --- |
| A recall means warning everyone or no one | A recall resolves to the units on the shelf (quarantined) and the patients who took one home; messages are drafted, a pharmacist attests and sends | Recalls; `apps/api/src/recall.ts` |
| The lot is never captured at the counter | Lot and serial captured at receiving and at fill by GS1 DataMatrix scan, or OCR for labels without a barcode; four receiving checks (invoice, transaction information, expiry, recall) | Receiving, Fill & pickup; `packages/gs1`, `apps/web/src/lib/scanner.ts` |
| Alerts come one at a time and get overridden | Rx Watcher rules plus the Rx Guardian: a patient-history check that raises suggestions with the evidence beside the order | Fill & pickup, Today, AI agents; `apps/api/src/rxwatcher.ts`, `agents/guardian.ts` |
| Refills ignore recalls and adherence | Refill worklist with PDC adherence, medication sync, recall hold for patients whose last fill came from a recalled lot | Refills; [docs/REFILLS.md](docs/REFILLS.md) |
| Traceability data is hard to exchange | EPCIS 2.0 export and dry-run import, sandbox verification requests, suspect-product cases, recall trace export. A sandbox, not a filing | DSCSA & trace; [docs/DSCSA.md](docs/DSCSA.md), `packages/epcis` |
| Cold chain and counts on paper | Temperature check at receiving against the shipper's log (simulated data) and witnessed Schedule II receiving and count changes. No in-store sensor feed | Receiving, Inventory; [docs/SAFETY.md](docs/SAFETY.md) |
| Front store and pharmacy are separate | One register for over-the-counter items and one patient's verified prescriptions; recalled lots are blocked. "Paid" is a label, no payment is processed | Register; `apps/api/src/register.ts` |
| Each store is an island | Two stores with separate databases, transfers that keep lot and serial, recalls mirrored to the other store | Transfers; `apps/api/src/crossstore.ts` |
| Outreach is a list and a phone | Consent-checked outreach, minimum-necessary text with the pharmacy phone and STOP, sandbox outbox only | Recalls, Refills; `apps/api/src/outreach.ts`, `notify.ts` |
| Other systems cannot ask the ledger | REST, MCP (JSON-RPC) and FHIR R4 behind OAuth 2.0 client credentials and per-partner scopes; HMAC-signed webhooks | Integrations; `apps/api/src/partner-api.ts`, `webhooks.ts` |
| Logs can be edited | Append-only, hash-chained audit log with a verify route | `GET /api/audit/verify`; `apps/api/src/core.ts` |
| Stock decisions are guesswork | Reorder, expiry-risk and shortage suggestions from rules, with the numbers shown | Stock help; `apps/api/src/stockhelp.ts` |

Long version, by role, with a 90-day pilot plan: [docs/MODERNIZATION.md](docs/MODERNIZATION.md).

## Try it in 60 seconds

Docker (one command):

```bash
docker compose up        # then open http://localhost:4000
```

No Docker (Node 22.5 or newer, pnpm 12):

```bash
pnpm install --frozen-lockfile
pnpm setup               # once: downloads the OCR model, renders the demo fax image
pnpm dev                 # API on :4000, web app on :5173 -> open http://localhost:5173
```

`pnpm setup` needs network access once (OCR model download). Nothing else needs a key. The AI agents run offline with `LLM_PROVIDER=mock` or `none`; the default provider is Bedrock, which needs AWS credentials (see [AI agents](#ai-agents)). The Docker image sets `LLM_PROVIDER=none` so a judge sees rules-only output with no credentials, and can switch provider on the AI agents screen.

`docker compose up` was **not run on the machine that wrote this repo** (no reachable Docker daemon). `docker-compose config` validated the file, and the same app was installed, built and served from source (`pnpm install --frozen-lockfile`, `pnpm setup`, `pnpm build:web`, API from source).

### Demo accounts

All accounts share the password `moonlight-rx-2026`. Pick the pharmacy on the sign-in page.

| Store | Email | Role | Sees |
| --- | --- | --- | --- |
| Elm Street, Store 7 | `j.rivera@elmstreetrx.example` | Pharmacist | Everything, and the only role that confirms, verifies and sends |
| Elm Street, Store 7 | `k.patel@elmstreetrx.example` | Technician | Receiving, inventory, fill, patients, stock help, refills, DSCSA, agents; cannot send messages or confirm lots |
| Elm Street, Store 7 | `m.diaz@elmstreetrx.example` | Cashier | Register and pickup only, no allergies or dates of birth, no outbox |
| Elm Street, Store 7 | `s.grant@elmstreetrx.example` | Admin | Integrations, agent provider settings |
| Birch Avenue, Store 2 | `s.okoro@birchavenuerx.example` | Pharmacist | Everything in Store 2 only |
| Birch Avenue, Store 2 | `t.lund@birchavenuerx.example` | Technician | Store 2 receiving, inventory, fill |
| Birch Avenue, Store 2 | `c.reyes@birchavenuerx.example` | Cashier | Store 2 register and pickup |

The "Badge tap / SSO" button is a demo stand-in that signs in the Store 7 pharmacist. `MFA=1` turns on a second sign-in factor (a 6-digit code delivered to the sandbox outbox) and disables that button.

### Three scenarios to click first

Sign in as the pharmacist and open **Demo guide** in the sidebar for the scenarios (each one resets the data and shows a short brief).

1. **Agent catches it.** Start the scenario and stay on Today. A new insulin order arrives for a patient with late fills, an active semaglutide pen and a last fill from a recalled lot. Within about a minute the Rx Guardian raises suggestions with the evidence. Accept one and the order goes on hold.
2. **Class I recall with patients to reach.** Recalls, look up `D-0611-2026`: the lot is confirmed, every on-shelf pen moves to quarantine, the impact list names the patients. Draft messages (try **Use AI draft**), tick the attestation, send. They land in the sandbox outbox.
3. **Recall-aware refill.** Open Refills, then look up `D-0611-2026` in Recalls. The patient's refill row turns red and links to the recall.

![Today screen after a Class I recall: refills tile](docs/img/today.jpg)

## Agents that work while you work

Eight agents share one rule: **rules decide, the model explains, a gate checks the model, a pharmacist decides.** With no model, or when a call fails, every agent still returns its rules-only result.

Four of them can run on their own once a pharmacist or admin switches them on (AI agents screen): the Rx Guardian (checks every new or changed order within a minute), Night Watch, the Stock and Shortage Advisor and Refill Outreach (daily). They never change an order, send a message or confirm a lot. Each shows when it last ran and when it runs next. `AGENTS_BACKGROUND=0` turns the scheduler off.

The Rx Guardian reads an order against the patient's whole history: fills, lots, allergy class codes, active medicines, adherence, age band and earlier suggestions. Its interaction and age-band tables are small synthetic demo tables, not clinical content.

**Before and after, one alert.** The data below is synthetic, and the layout is illustrative.

| Old way | With the Rx Guardian |
| --- | --- |
| A popup at the screen: "Possible interaction. Override?" | A suggestion on the order with the evidence next to it: "A fill came from recalled lot GX4471C" (last insulin fill, with its date and lot), "Gaps in insulin fills", and a demo-table pair with the active semaglutide fill. |
| Override or cancel. No record of why. | Accept (the order goes on hold with the reason), dismiss (a reason is required), or send a prescriber change request. Every decision is in the audit log. |
| The history lives in other windows. | The history facts are cited in the suggestion, and a note that cites a fact that does not exist is dropped by the gate. |

The model is Amazon Bedrock by default, and you can bring your own: Anthropic, an OpenAI-compatible endpoint (OpenAI, Azure, Ollama, LM Studio, vLLM), an offline mock, or rules only. Details and the provider table are in [AI agents](#ai-agents) below and in [docs/AGENTS.md](docs/AGENTS.md).

![AI agents screen after running an agent](docs/img/agents.jpg)

## Safe by design

A pilot threat model, not a compliance claim. Full text: [docs/SECURITY.md](docs/SECURITY.md), rules mapped to tests: [docs/SAFETY.md](docs/SAFETY.md).

- **Synthetic data only.** A hook and a CI step block PHI-shaped content. No real patient data, ever.
- **Encrypted at rest.** Patient names, dates of birth, phones, emails, allergies, conditions, directions, message bodies, agent runs and suggestions are sealed with AES-256-GCM; the list is in `apps/api/src/protect.ts`.
- **Roles on the server.** Every state-changing route and every route in the read authorization matrix is role-checked on the server (pharmacist, technician, cashier, admin); see [docs/SECURITY.md](docs/SECURITY.md). Partners get scoped tokens.
- **Audit.** A hash-chained log of every decision, with a verify route.
- **Sandbox messaging.** SMS, email and voice go to an outbox; nothing is dialled or sent. The prescriber loop and the DSCSA verifier are stand-ins.
- **No compliance claims.** No HIPAA, DSCSA, certification or clinical-validity claim. This is not a medical device.

## Architecture

```mermaid
flowchart LR
  subgraph Inputs
    CAM[Webcam or USB scanner<br/>GS1 DataMatrix]
    FAX[Recall fax image]
    FDA[openFDA]
    LLM[Bedrock, Anthropic,<br/>OpenAI-compatible, mock]
    PRT[Partners: EHR, PMS, AI agents]
  end
  subgraph Web[apps/web - React and Vite]
    SCAN[Scanner]
    OCR[Browser OCR<br/>tesseract.js]
    UI[Screens]
  end
  subgraph API[apps/api - Fastify]
    GUARD[Auth, roles, rate limits,<br/>security headers]
    DB[(SQLite per store<br/>AES-256-GCM fields)]
    LED[Receiving, fill, inventory]
    REC[Recalls and notify]
    RXW[Rx Watcher]
    REF[Refills and PDC]
    DSC[EPCIS and verifier]
    AGT[Agent runtime<br/>rules, model, gate]
    AUD[Hash-chained audit]
    PAPI[REST, MCP, FHIR, webhooks]
    OUT[Sandbox outbox]
  end
  CAM --> SCAN --> UI
  FAX --> OCR --> UI
  UI -- REST and cookie --> GUARD
  GUARD --> LED & REC & RXW & REF & DSC & AGT
  LED & REC & REF & DSC --> DB
  FDA --> REC
  LLM -.advisory.-> AGT
  AGT --> RXW & REC & REF
  REC & REF --> OUT
  PRT <--> PAPI --> DB
  GUARD --> AUD --> DB
  subgraph Packages
    GS1[packages/gs1]
    COR[packages/coroner]
    SUM[packages/summoner]
    EPC[packages/epcis]
  end
  LED --> GS1
  REC --> COR & SUM
  DSC --> EPC
```

Other parts stitched in: openFDA (live, with fixtures as fallback), the Coroner lot extractor (regex plus optional LLM, keeps a lot only if it is printed in the source), recall voicemail with ElevenLabs, OpenAI, macOS or browser voice (nothing is dialled), and a sandbox NCPDP SCRIPT-shaped `RxChangeRequest` to the prescriber. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## AI agents

Rule: rules decide, the model explains, a gate checks the model, a pharmacist decides. With no model, or when a call fails, every agent still returns its rules-only result. Background mode and the Rx Guardian are described [above](#agents-that-work-while-you-work).

| Agent | What it does |
| --- | --- |
| Coroner | Reads a recall notice; a lot must appear verbatim in the notice |
| Rx Watcher Explainer | Explains rule findings; cannot remove or soften one |
| Recall Outreach Drafter | Rewrites approved message templates; no send path |
| Refill Outreach | Rewrites refill reminders; skips recalled and Schedule II |
| Night Watch | Daily digest of recalls, shortages, expiring lots |
| Stock and Shortage Advisor | One sentence per suggestion, numbers checked |
| Pharmacist Copilot | Answers a question with up to three read-only tools |
| Rx Guardian | Checks a new or changed order against the patient's history and raises suggestions a pharmacist accepts or dismisses; can run in the background |

Provider is chosen with `LLM_PROVIDER` at start-up (empty means `bedrock`). A pharmacist or admin can also switch provider, model and key on the AI agents screen and press **Test connection**; a pasted key stays in server memory and is never stored, logged or returned.

| Provider | `LLM_PROVIDER` | Environment variables |
| --- | --- | --- |
| Amazon Bedrock (default), Converse API | `bedrock` | `AWS_REGION`, `BEDROCK_MODEL_ID`, and credentials from the default AWS chain (`AWS_PROFILE`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, SSO or an instance role) |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |
| OpenAI, Azure OpenAI, Ollama, LM Studio, vLLM | `openai-compatible` | `OPENAI_BASE_URL`, `OPENAI_API_KEY` (not needed for local servers), `OPENAI_MODEL` |
| Deterministic and offline | `mock` | none |
| Rules only | `none` | none |

Examples: Ollama is `OPENAI_BASE_URL=http://localhost:11434/v1`, `OPENAI_MODEL=<a model you pulled>`. Adding a provider is about 20 lines ([docs/AGENTS.md](docs/AGENTS.md)).

**Live Bedrock was checked once** on 2026-11-20 with the Converse API (`us.anthropic.claude-sonnet-5`, `us-east-1`): Test connection answered in about 3 seconds, and the Coroner read two lots from a notice with its LLM pass on. The Anthropic and OpenAI-compatible clients are tested only with stubs and the mock. Model IDs are retired over time, so if Test connection fails, run `aws bedrock list-inference-profiles` and set `BEDROCK_MODEL_ID`.

## Security and privacy

A pilot threat model, not a compliance claim. Full text: [docs/SECURITY.md](docs/SECURITY.md).

- **Encryption at rest.** Patient names, dates of birth, phones, emails, allergies, conditions, prescription directions, message bodies, agent runs and audit reasons are sealed with AES-256-GCM, a fresh 12-byte IV per value, in a versioned envelope with a key id. The list is in `apps/api/src/protect.ts`; a test reads the raw SQLite and WAL bytes and finds no synthetic patient string.
- **Key ring and rotation.** Keys come from `env`, a `file` (owner-only: 0600/0700 on macOS and Linux, an `icacls` step or `DATA_KEY` on Windows; see docs/SECURITY.md) or a `kms` placeholder. `pnpm --filter @chimera-rx/api keys:rotate` re-encrypts every protected value under a new key in one transaction per store. A wrong or missing key stops start-up instead of writing under another key.
- **Headers and API.** CSP, nosniff, no-referrer, frame denial, `no-store` on API responses, HSTS when `COOKIE_SECURE=1`; zod validation on every body; errors that never echo input; request logs with no body, URL query or names.
- **Rate limits.** Five wrong passwords lock an account for 15 minutes; failures are also counted per IP and per account name. Counters are per process.
- **Roles.** Every state-changing route and every route in the read authorization matrix is role-checked on the server (pharmacist, technician, cashier, admin); see docs/SECURITY.md. Partners get scoped OAuth tokens; patient data also needs an admin-approved flag.
- **Audit and MFA.** Hash-chained audit, patient views logged with a reason, optional second factor with `MFA=1`.

Not covered: no TLS in the app (put a proxy in front), no KMS or HSM (the default key sits next to the data), columns outside the list are plaintext (message subjects, ids, lot and Rx numbers), no SQLCipher, per-process rate limits, no retention or deletion workflow, no breach process, no independent review or penetration test.

## Safety rules

Eleven rules in [`.kiro/steering/pharmacy-safety.md`](.kiro/steering/pharmacy-safety.md), mapped to code and tests in [docs/SAFETY.md](docs/SAFETY.md):

- Synthetic data only; a hook and CI block PHI-shaped content.
- Nothing reaches a real person: SMS and email go to a sandbox outbox, voicemail is never dialled.
- A pharmacist confirms lots, verifies fills, approves flagged orders and sends messages.
- A lot is never invented; a lot under 0.95 confidence or without expiry needs a person.
- Rules before the LLM; an inferred serial is never shown as scanned.
- A recalled lot stays blocked even after the recall closes.
- Messages carry the minimum, the pharmacy phone and STOP; voicemail never names the medicine.

## Testing

Measured on 2026-11-20 on the machine that built this repo:

| Command | Result |
| --- | --- |
| `pnpm test` | 20 files, 364 tests passed |
| `pnpm typecheck` | clean in all workspaces |
| `pnpm build:web` | builds |
| `pnpm e2e` | 49 passed and 1 skipped against a fresh data directory (the MFA check is skipped unless the API runs with `MFA=1`); run by the Rx Guardian build item, see [docs/evidence/items/bgagents.md](docs/evidence/items/bgagents.md) |

Property tests (fast-check, in 9 test files) check that on-hand stock always equals received minus dispensed, returned and adjusted, that no serial is dispensed twice, that the Coroner never emits a lot that is not in the source even when a stub model lies, that GS1 parsing round-trips, and that EPCIS events stay valid. Hostile-provider tests feed lying models to every agent and check the gates.

End-to-end (needs the app running, uses Chromium with a fake webcam and real OCR; `npx playwright install chromium` once if the browser is missing):

```bash
pnpm dev                                  # in one terminal
pnpm e2e                                  # in another; BASE=http://localhost:5173 by default
BASE=http://localhost:5530 pnpm e2e       # against another web port
```

The e2e run resets the data. If the API is not on a dev origin, set `CORS_ORIGINS` (below) or the browser's POSTs are refused. A physical webcam, printed labels and live model providers were not tested.

## Configuration

Every variable is optional. Copy `.env.example` to `.env` to set them.

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_PORT` (or `LG_API_PORT`) | `4000` | API port |
| `API_URL` | `http://127.0.0.1:4000` | Where the Vite dev server proxies `/api`, `/v1`, `/mcp`, `/fhir`, `/oauth`, `/hooks` |
| `DATA_DIR` | `./data` | SQLite files and the key file |
| `DATASET` | `demo` | `large` adds a generated six-month history (about 5,000 fills) |
| `TWO_STORES` | `1` | `0` runs one store |
| `MFA` | `0` | `1` requires a 6-digit code after the password |
| `LG_DEMO` | `1` | Show the demo accounts on sign-in and allow the SSO stand-in |
| `TODAY` | real date | Pretend today is this date (`YYYY-MM-DD`) |
| `NIGHT_WATCH` | on | `0` stops the openFDA poll |
| `MIN_EXPIRY_MONTHS` | `6` | Shortest remaining shelf life accepted at receiving |
| `REFILL_GRACE_DAYS` | `7` | Days past due before a refill counts as overdue (0 to 60) |
| `SANDBOX_DELAY_MS` | `1500` | Delay of the sandbox SMS delivery receipts |
| `OPENFDA_API_KEY` | none | Free key; without one the public rate limit applies |
| `LLM_PROVIDER` | `bedrock` | `bedrock`, `anthropic`, `openai-compatible`, `mock`, `none` |
| `AWS_REGION`, `AWS_PROFILE`, `BEDROCK_MODEL_ID` | `us-east-1`, none, `us.anthropic.claude-sonnet-5` | Bedrock |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | none, `claude-3-5-haiku-latest` | Anthropic |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` | OpenAI URL, none, `gpt-4o-mini` | OpenAI-compatible; the key also serves OpenAI voice |
| `VOICE_PROVIDER` | `auto` | Voicemail voice: ElevenLabs, OpenAI, macOS, then the browser |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL` | none | ElevenLabs voice |
| `OPENAI_TTS_VOICE`, `OPENAI_TTS_MODEL` | `coral`, `gpt-4o-mini-tts` | OpenAI voice |
| `MAC_VOICE` | none | Force a macOS voice |
| `KEY_PROVIDER` | `env` if `DATA_KEY` set, else `file` | `env`, `file`, `kms` (placeholder) |
| `DATA_KEY`, `DATA_KEY_PREVIOUS`, `NEW_DATA_KEY` | none | Base64 32-byte key, older keys, rotation target |
| `ALLOW_UNREADABLE_KEYS` | off | Set only by `keys:status` so it can report on unreadable values |
| `COOKIE_SECURE` | `0` | `1` sends the cookie over HTTPS only and enables HSTS |
| `SESSION_IDLE_MINUTES` | `30` | Idle sign-out, 0 turns it off |
| `CORS_ORIGINS` | local dev origins | Browser origins allowed to call the API. Needed when the web app runs on another port |
| `TRUST_PROXY` | `0` | `1` behind a proxy that sets `X-Forwarded-For` |
| `OFFLINE` | off | `1` skips openFDA and shortage-feed calls (used by the timing evidence) |

## Evidence

| Claim | Report | Command |
| --- | --- | --- |
| Lot extraction on 50 real 2025 openFDA recall records | [docs/evidence/accuracy.md](docs/evidence/accuracy.md) | `pnpm evidence` |
| Server time from recall number to affected-patient list, and lot-capture rate | [docs/evidence/timing.md](docs/evidence/timing.md) | `pnpm evidence` |
| What each build item changed, ran and skipped | [docs/evidence/items/](docs/evidence/items/) | |

The timing is server work over the real HTTP routes, not a person using a browser.

## Repo layout

```
apps/api               Fastify API, SQLite (node:sqlite), agents, partner API, scripts (keys, evidence)
apps/web               React and Vite, the screens, browser OCR and scanner
packages/gs1           GS1 element strings, NDC and GTIN rules
packages/summoner      openFDA client with fixture fallback
packages/coroner       lot, NDC and expiry extraction (regex plus optional LLM, verbatim gate)
packages/epcis         EPCIS 2.0 events, validator and parser
fixtures/recalls       50 real 2025 openFDA records and demo recalls
scripts/               dev launcher, end-to-end run, PHI guard
prototype/             the clickable design prototype the screens were built from
.kiro/                 steering, specs, hooks, agents, MCP config
docs/                  architecture, safety, security, agents, demo, DSCSA, refills, submission
Dockerfile, docker-compose.yml, .devcontainer/
```

## Built with Kiro

Steering files hold the safety rules and the stack, specs cover the Coroner and Summoner, a PHI-guard hook blocks risky writes, and a property-test hook runs on save. The honest account, including what Kiro did not do, is in [docs/KIRO_USAGE.md](docs/KIRO_USAGE.md). Criteria mapping: [docs/KIROWEEN.md](docs/KIROWEEN.md). Demo script: [docs/DEMO.md](docs/DEMO.md). Devpost write-up: [docs/SUBMISSION.md](docs/SUBMISSION.md).

## Limitations and non-goals

- No real patient data, ever. All names, ids, phones and addresses are invented.
- No real messaging: SMS, email and voice are sandbox stand-ins. Nothing is dialled or sent.
- The prescriber loop, the DSCSA verifier and the key provider `kms` are sandbox stand-ins. Nothing is filed with any regulator or trading partner.
- The drug rules are a small curated table, not a licensed interaction database. The Rx Guardian's interaction and age-band tables are synthetic demo tables, not clinical content.
- The cold-chain temperature is simulated.
- No payment is processed; over-the-counter stock is not tracked.
- No compliance, certification or clinical-validity claim. This is not a medical device.
- Not verified: a physical webcam with printed cartons, OCR on curved vial labels, any live LLM provider, the Docker image build, an accessibility audit.

## Licence

MIT. See [LICENSE](LICENSE).
