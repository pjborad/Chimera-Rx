# Modernizing the pharmacy system

The long version of the README's case. Chimera Rx is a modern, agent-assisted pharmacy system built around one lot ledger. A recall is the sharpest proof, because it needs every part of the pharmacy at once. This is a pilot sandbox with synthetic data, not a product for sale and not a compliance claim ([SAFETY.md](SAFETY.md), [SECURITY.md](SECURITY.md)).

How to read the numbers: a figure with a link is from that source, paraphrased. A figure in this repo was measured by running the code. A figure with neither is a target, and is marked as one.

## 1. The problem, by role

| Role | What the day looks like now | What Chimera Rx changes | Where |
| --- | --- | --- | --- |
| Pharmacist | Verifies each fill against alerts that are mostly noise: in published studies, [289 of 510 relevant community-pharmacy interaction alerts](https://pubmed.ncbi.nlm.nih.gov/17381663/) and [52.6 percent of outpatient alerts](https://pubmed.ncbi.nlm.nih.gov/24166725/) were overridden. A recall means phone calls. | Suggestions arrive with the history evidence beside the order. A recall resolves to shelf units and patients, and a pharmacist approves the messages. | Fill & pickup, Today, Recalls |
| Technician | Receives, shelves and fills. The lot is on the carton and goes nowhere. Cold-chain and count checks are manual. | Scan the DataMatrix at receiving and fill; four receiving checks; witnessed Schedule II receiving; put-away records the lot. | Receiving, Inventory, Fill & pickup |
| Cashier | Sells over-the-counter items and hands over prescriptions in two separate flows. | One register for both. A recalled lot cannot be sold. A cashier sees no allergies or dates of birth. | Register |
| Owner | Thin margins and closures: the 2024 NCPA Digest describes independent pharmacies [closing at more than one a day](https://www.drugtopics.com/view/2024-ncpa-digest-highlights-challenges-in-independent-pharmacy-ncpa-2024). Burnout is common: [74.9 percent of 412 surveyed community pharmacists](https://www.pharmacytimes.com/view/pharmacist-burnout-poses-challenges-to-patient-access) reported it in at least one domain. DSCSA readiness is a looming task. | One system for the ledger, refills, stock help, traceability events and multi-store transfers, with an audit log. Agents take the sweeping and drafting; people keep the decisions. | Today, Stock help, DSCSA & trace, Transfers |
| Patient | Learns about a recall from the news, or not at all. Refills get filled from a lot nobody checked. | Told only if their own fill came from the lot, by their consented channel, with the pharmacy phone. A recalled-lot patient is held out of refill reminders. | Recalls, Refills |

## 2. Current state and future state

| Area | Current state | Chimera Rx state | Status |
| --- | --- | --- | --- |
| Lot and serial | On the carton; wholesaler holds it; not tied to the patient | Captured at receiving and fill, tied to the patient | Built |
| Recall | Fax or notice read by a person; call or warn everyone | Fax read by browser OCR, openFDA confirms, the Coroner keeps only lots printed in the notice; shelf units quarantined; patients listed by consent | Built |
| Prescription checks | Per-alert popups, high override | Rx Watcher rules plus the Rx Guardian's history check, with evidence | Built (demo tables, not clinical content) |
| Prescriber contact | Fax and phone | NCPDP SCRIPT-shaped change request, sandbox | Sandbox |
| Refills | Reminder by due date | PDC adherence, med sync, recall hold | Built |
| Traceability | Separate system or paper | EPCIS 2.0 export and import, sandbox verifier, suspect cases | Sandbox |
| Cold chain | Twice-daily manual reading; in a CDC simulation of vaccine storage such readings [caught 4.8 to 6.4 percent of excursions](https://stacks.cdc.gov/view/cdc/119983/cdc_119983_DS1.pdf) | Receiving check against the shipper's log, with simulated data | Partial. No live sensor feed |
| Controlled substances | Counts by hand | Witnessed receiving; count changes need a pharmacist and a witness | Built |
| Front store | Separate POS | Register with verified prescriptions; "paid" is a label | Built (no payments) |
| Multi-store | Phone and spreadsheet | Two stores, transfers keep lot and serial, mirrored recalls | Built (two demo stores) |
| Messaging | Bulk text or phone list | Consent-checked, minimum necessary, pharmacist attests, sandbox outbox | Sandbox |
| Integration | Batch files, screen scraping | REST, MCP and FHIR R4 behind scoped OAuth; signed webhooks | Built (no real partners) |
| Audit | Mutable logs | Hash-chained audit with a verify route | Built |

## 3. Agent roadmap

Rule for every agent: rules decide, the model explains, a gate checks the model, a pharmacist decides. An agent never sends, orders, confirms a lot or changes an order. Details in [AGENTS.md](AGENTS.md).

**Built now (eight):**

| Agent | Role |
| --- | --- |
| Coroner | Reads a recall notice; keeps a lot only if it appears verbatim |
| Rx Watcher Explainer | Explains rule findings; cannot remove or soften one |
| Rx Guardian | Checks a new or changed order against the patient's history; raises suggestions a pharmacist accepts, dismisses or sends as a prescriber change request. Runs in the background when switched on |
| Recall Outreach Drafter | Rewrites approved recall templates; no send path |
| Refill Outreach | Rewrites refill reminders; skips recalled lots and Schedule II. Background |
| Night Watch | Daily digest of recalls, shortages and expiring lots. Background |
| Stock and Shortage Advisor | One sentence per reorder or shortage item, numbers checked. Background |
| Pharmacist Copilot | Answers a question with up to three read-only tools |

**Next (not built):**

| Idea | Why | What it needs |
| --- | --- | --- |
| Live Bedrock check, with latency and cost | The default provider has had one live check (Test connection and one Coroner run), but no latency or cost measurement | AWS credentials and a measured run |
| A licensed drug-interaction and dosing source for the Guardian | The demo tables are synthetic | A licence and a clinical review |
| Prescriber-reply reading (accept a faxed change) | Closes the change-request loop | OCR of replies and a gate like the Coroner's |
| Wholesaler and PMS connectors | Replaces seeded data | Real partner access; not a sandbox job |
| In-store temperature sensor feed | The cold-chain check uses a shipper log only | Hardware and an ingest route |
| Hosted sandbox for judges | Today a judge runs it locally | Hosting and a key policy |

## 4. A 90-day pilot for one independent pharmacy

A plan, not a result. Nothing here has been run. Every number in the measures below is a target until measured.

| Days | Goal | Work | Exit check |
| --- | --- | --- | --- |
| 0 to 14 | Shadow mode, no patient impact | Install in a sandbox beside the current system. Load a de-identified copy of the formulary and a month of fills agreed with the owner and counsel. Train the pharmacist and two technicians on scanning. | Staff can receive and fill ten packages by scan. |
| 15 to 45 | Capture the lot | Scan at receiving and at fill on one shift, then all shifts. Keep the current system as the system of record. | Share of fills with a captured lot (measured by `pnpm evidence` on the sandbox, and by a weekly count in the pilot). Target: most fills. |
| 46 to 70 | Agents in advisory mode | Switch on the Rx Guardian and Night Watch. A pharmacist reviews each suggestion and records accept or dismiss with a reason. No change to the workflow of record. | Override rate and dismiss reasons collected for four weeks. |
| 71 to 90 | Recall drill and review | Run one mock recall end to end with a sandbox outbox. Compare time to a patient list against the current method. Hold a review with staff. | Written go, no-go or change list. |

Before any real patient data: a security review, the key provider moved off the local file, TLS in front of the API, a retention and breach process, legal review of messaging consent, and an agreement with the pharmacy. None of those exist yet ([SECURITY.md](SECURITY.md) lists the gaps).

## 5. Success measures

| Measure | Definition | Baseline | Target |
| --- | --- | --- | --- |
| Recall time-to-reach | Minutes from a recall notice to an approved list of affected patients and shelf units | In this repo's synthetic data the server work is measured in [evidence/timing.md](evidence/timing.md); a person using a browser has not been timed | Set after the pilot drill; any number now would be a guess |
| Suggestion override rate | Share of Rx Guardian suggestions dismissed | None yet | Target: a low dismiss rate with a reason on every dismissal. Published alert override rates are in the table above for contrast; a low rate also needs a low volume |
| Missed-refill rate | Share of due refills with no fill or contact within the grace days | Measured per store from the refills worklist | Target: lower than the first-month rate |
| Lot capture rate | Share of dispensed fills with a lot and serial | Measured by `pnpm evidence` on synthetic data | Target: most fills |
| Staff minutes on recall and receiving | Time-and-motion sample | None | Measure first |

## 6. Risks and how the design handles them

| Risk | Handling in the design | What is still open |
| --- | --- | --- |
| A model invents a lot, a patient fact or a clinical claim | Rules first; a gate after the model drops anything the rules or source text do not back up; the dropped output is shown | Live models have not been exercised on this build machine |
| Alert fatigue returns | One suggestion per distinct finding, evidence beside the order, a reason required to dismiss, and suggestions that resolve when the history no longer backs them | The real dismiss rate is unknown until a pilot |
| A suggestion is wrong or the table is wrong | Interaction and age-band tables are labelled demo tables; the agent never changes an order | A licensed source and clinical review are needed before real use |
| Patient data in a prompt | Prompts carry patient ids, drugs, dates and class codes; a scan before every call refuses the call if it finds a name, phone, email or date of birth | Not independently reviewed |
| A message reaches the wrong person or without consent | Sandbox outbox only; consent checked again at send; minimum necessary text; pharmacist attests | Real channels do not exist |
| Records are edited | Hash-chained audit with a verify route | No external anchor for the chain |
| Data at rest | AES-256-GCM on listed columns, key rotation | Default key sits next to the data; no KMS; plaintext columns outside the list |
| Regulation changes | The DSCSA sandbox follows the FDA's published dates: the stabilization period ended [November 27, 2024](https://www.fda.gov/media/179256/download), and small dispensers have an [exemption to November 27, 2027](https://www.fda.gov/drugs/drug-supply-chain-security-act-dscsa/exemptions-under-drug-supply-chain-security-act) | Confirm your own status with the FDA; this repo is not advice and files nothing |
| Over-reach in claims | Built with HIPAA-style safeguards, not certified; no HIPAA, DSCSA, certification or clinical-validity claim anywhere | None |
