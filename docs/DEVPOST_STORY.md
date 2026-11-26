## Inspiration

Pharmacies run on yesterday's software. Recalls and prescriber changes still arrive by fax and phone. Cold-chain and controlled-substance counts live on paper. Drug interaction alerts pop up one at a time, and in one study of community pharmacies **289 of 510** relevant alerts were overridden with no action. Pharmacists are stretched thin: **74.9%** of 412 surveyed reported burnout.

Under all of that sits one gap that nobody closes. **The wholesaler knows which lot is in the box. The dispensing system knows which patient took a box home. Nothing connects the two.** The lot number is printed in the 2D barcode on every package, but nobody records it at the counter. So when the FDA recalls a lot, a pharmacy has two bad choices: warn everyone, or warn no one.

Kiroween's Frankenstein category asked for something stitched together from parts that were never meant to fit. A pharmacy counter is exactly that: barcode scanners, faxes, openFDA, supply-chain data standards, health-data APIs and now language models, all living in separate boxes. I wanted to sew them into one body with one heartbeat: **a ledger that knows the lot, the patient and the prescription, watched by AI agents, with a pharmacist making every decision.**

## What it does

![Today](https://pjborad.github.io/Chimera-Rx/media/gallery/01-today.jpg)

Chimera Rx is a working pharmacy system with fourteen tabs, built around one lot ledger:

- **Receiving.** Scan the GS1 DataMatrix with a webcam or USB scanner (or OCR a label with no barcode). Lot, serial and expiry are captured, then four checks run before a package can reach the shelf: invoice, the supplier's transaction data, expiry and active recalls. Schedule II receipts need a witness.
- **Fill & pickup.** The lot is captured again at fill and tied to the patient. Deterministic Rx Watcher rules run first, then the **Rx Guardian** agent reads the patient's whole history and raises suggestions with the evidence it used.
- **Register.** The front store and the pharmacy share one till. A cashier can sell a verified prescription, and a recalled lot is refused at the scanner.
- **Recalls.** A faxed notice is read by OCR in the browser, or a recall number is looked up on openFDA. The **Coroner** agent extracts the lots, units are quarantined, and the exact patients who took one home are listed. Messages are drafted, consent is checked, and a pharmacist attests before anything goes to the sandbox outbox.
- **Refills** track adherence (proportion of days covered) and hold any refill whose last fill came from a recalled lot.
- **DSCSA & trace** exports and imports EPCIS 2.0 events, runs a sandbox verifier and tracks suspect-product cases.
- **Two stores** transfer stock with lot and serial intact, and recalls mirror across both.
- **Integrations** expose REST, MCP and FHIR R4 behind OAuth 2.0 scopes, with HMAC-signed webhooks. Every real-world connection a deployment would need (SMS, email, calls, wholesaler EDI, e-prescribing, EHR, payer, KMS, SSO) has a designed seam that is sandboxed today.

Four roles see four different products. The pharmacist sees everything clinical. The technician receives and fills. The cashier sees pickup and the register, never allergies, birth dates or recalls. The admin sees partner access only. Every route is checked on the server against one access table with default deny.

### Eight agents, one rule

![AI agents](https://pjborad.github.io/Chimera-Rx/media/gallery/04-agents.jpg)

> **Rules decide, the model explains, a gate checks the model, a pharmacist decides.**

Every agent has a deterministic core that always runs, an optional model layer, and a gate after the model that drops anything the rules or the source text don't back up. Four agents can run in the background: Rx Guardian checks every new order each minute, and Night Watch, the Stock Advisor and Refill Outreach run daily. The Recall and Refill Outreach drafters, a Pharmacist Copilot and an Rx Watcher Explainer complete the eight.

Providers are swappable from the screen: Amazon Bedrock (the default), Anthropic, any OpenAI-compatible endpoint including local Ollama, an offline mock, or rules only. Prompts never carry a name, phone, email or birth date. A spy test records every prompt from every agent and checks it against every patient.

## How I built it

Chimera Rx is TypeScript end to end: a Fastify API with zod and Node's built-in SQLite, a React and Vite front end, Tesseract.js for OCR in the browser and bwip-js for barcodes. Patient fields are encrypted at rest with AES-256-GCM and key rotation, and every state change a person makes goes through a hash-chained audit log.

**Kiro was the whole workshop.**

- **Steering first.** Before any code, I wrote eleven pharmacy safety rules into `.kiro/steering/pharmacy-safety.md`, loaded on every request. The trick was writing them as checkable facts, not intentions: the exact fake phone format, the exact on-screen notice, "never show an inferred serial as scanned", "a lot under 0.95 confidence needs a pharmacist". Each rule maps to the code that enforces it and a test that proves it.
- **Specs where mistakes hurt.** The Coroner and the openFDA client were built from EARS requirements in `.kiro/specs`. Requirement **COR-3**, "never emit a lot that is not in the source text", travels into the tests by name.
- **Hooks.** A PHI guard blocks any commit that looks like real patient data, and the property tests run whenever the lot-extraction or GS1 code is saved.
- **A custom agent** scoped to the Coroner and GS1 packages, which must run the property tests before it finishes.
- **Kiro Crew as a team.** Later rounds ran as a team: a lead agent took goals like "harden security" or "fix the eight review findings", split them into items, dispatched workers in parallel on separate files and ports, then re-ran the tests and read the diffs itself before anything shipped.

The full answer to every Kiro question is in [KIRO_USAGE.md](https://github.com/pjborad/Chimera-Rx/blob/main/docs/KIRO_USAGE.md).

### Property-based tests on the things that must never break

The ledger has one invariant that has to hold under any sequence of receive, fill, return, adjust and recall:

$$\text{on hand} = \text{received} - \text{dispensed} - \text{returned} - \text{adjusted}$$

fast-check throws random sequences at it, and also checks that no serial is ever dispensed twice and that every dispensed serial was received. On its first run it caught a defect the unit tests had missed: about **1 in 97** seeded historical fills had no package behind it.

For COR-3, the test feeds the Coroner a model that lies. Whatever the model says, a lot \\( \ell \\) survives only if it appears as a whole token in the normalized notice text \\( T \\):

$$\ell \in \text{output} \implies \ell \sqsubseteq_{\text{token}} \operatorname{normalize}(T)$$

Fifty real 2025 openFDA recall records then found three more Coroner defects that hand-written cases had missed: "Mar-25" expiries read as lots, plural "Lots:" headers, and lot lists cut short at a semicolon.

### The real app, hosted with no server

Judges shouldn't have to install anything, so the live link runs the **real Fastify API inside the browser**. The web app's calls are routed to Fastify's in-process `inject()`, Node's SQLite is shimmed over sql.js (SQLite compiled to WebAssembly), and the encryption, background jobs and audit chain all still run. It's the same code that runs on the server, deployed to GitHub Pages.

## Challenges

- **Never inventing a lot.** A model reading a recall notice will happily return a plausible lot number that isn't on the page. One wrong lot means a patient isn't warned. The first version of the gate accepted slices of a real lot; it was rewritten to whole-token matching and tested with hostile inputs.
- **Keeping AI advisory.** An agent that can remove a rule hit, soften a warning or put a medicine name into a voicemail is dangerous. Every agent has a gate after the model, and the tests use a deliberately lying model to prove it can't get through.
- **An independent review that found real bugs.** An outside reviewer filed eight findings. An automatic review could overwrite a pharmacist's hold. A recall confirmed in one store didn't reach the second. A cashier could read clinical data through some read routes. An interrupted transfer left the same serial on the shelf in both stores. All eight are fixed, and the reviewer's 21 acceptance tests now pass in the repo.
- **Encryption versus search.** Patient fields are sealed inside SQLite, so search decrypts in memory, because a blind index only supports exact match.
- **A camera flow without a camera.** The end-to-end test swaps the webcam for a canvas holding generated barcode labels, then drives the real UI.

## Accomplishments that I'm proud of

- A recall goes from a faxed notice to the exact patients and approved messages in one flow, on data captured at the counter.
- **476** unit, API and property-based tests pass, plus end-to-end browser runs of the real UI (49 of 49 checks on the server build, 57 of 57 on the hosted build).
- Every one of the eleven safety rules has an enforcing file and a proving test.
- An agent platform where a lying model can't remove a rule hit, add a lot, or leak a name.

## What I learned

- **Specs pay back where mistakes are expensive.** The spec-driven packages came through the independent review clean. All eight findings were in modules I built faster from a plan and mockups.
- **Steering works best as facts, not wishes.** Rules an agent can check its own output against get followed. Vague ones don't.
- **Review is its own round.** A second set of eyes found bugs the builder's tests never would.
- **A sandbox labelled as a sandbox beats a claim.** Being clear about what's simulated made every real part easier to trust.

## What's next

- A real key-management provider and TLS in front of the API.
- A licensed drug-interaction source in place of the demonstration rule table.
- A physical webcam test with printed cartons, and a pilot plan with one independent pharmacy.
- Live connections behind the seams that are sandboxed today, each with its own consent and attestation step.

*Synthetic data only. Not for clinical use. Built with HIPAA-style safeguards, not certified.*
