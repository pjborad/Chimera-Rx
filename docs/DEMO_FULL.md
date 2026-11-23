# Full demo: a day in a modern pharmacy (voiceover script, about 10 minutes)

This is the long version, written to be read aloud. It supersedes the long version in [DEMO_SCRIPT.md](DEMO_SCRIPT.md); that file stays as the short script. The 3-minute competition cut is [DEMO_CUT3.md](DEMO_CUT3.md). Every path on Fill & pickup, with how to trigger it, is in [FILL_PATHS.md](FILL_PATHS.md).

Everything on screen is **synthetic data in a sandbox**. Say "sandbox" whenever something is simulated. Never say "compliant", "certified" or "clinically validated".

**How to read this page.** Each section has a time target, the screen and clicks, the words to say, and why it matters. Spoken lines are in quote blocks. `[pause]` is a one-second beat. Words in square brackets are stage directions, not spoken. The spoken lines total about 1,500 words, which is about 10 minutes at a calm 150 words a minute. The timestamps count speech only, so a stalled click costs you extra time. Nobody has timed this on camera: rehearse once and trim. If you run long, cut the optional beats first (receiving problems, Store 2, the manufacturer response).

## Setup (before you record)

```bash
pnpm install --frozen-lockfile
pnpm setup                       # once; downloads the OCR model
LLM_PROVIDER=mock pnpm dev       # or Bedrock after `aws sso login`; API :4000, web :5173
```

- Chrome at 1440 by 900, on `localhost`. Camera off: paste codes from **Test labels** (Demo guide) into the scan box.
- Press **Reset demo** on Today before the take. Sign out.
- Accounts: pharmacist `j.rivera@elmstreetrx.example`, technician `k.patel@…`, cashier `m.diaz@…`, admin `s.grant@…`, password `moonlight-rx-2026`. Store 2 pharmacist `s.okoro@birchavenuerx.example`.
- Have these Test labels ready: the atorvastatin fill label (Rx 0072214), the insulin fill label (Rx 0072210), and the amoxicillin receiving label (delivery ASH-1105-07).
- The web app uses hash routes, so a page is `http://localhost:5173/#/fill`.

---

## A. The problem and the modernization story (0:00 to 1:20)

**Screen:** the sign-in page, the demo notice visible at the top. No clicks yet.

> Most pharmacies still run on software that is decades old. [pause] The core of a pharmacy system has evolved for about four decades, and buyer guides for independent pharmacies still list "connects dispensing, register and patient messaging" as what separates modern software from the old kind. We won't quote an average age, because we found no sourced one.
>
> Here is what the old model leaves behind. The wholesaler tracks a package by lot and serial. The dispensing system tracks the patient and the drug. Nobody records which lot went home with which patient. [pause] So when a lot is recalled, the pharmacy warns everyone, or no one.
>
> Prescriber changes still travel by fax and phone. Cold-chain logs and controlled counts live on paper. And the alerts people do see get overridden: one community pharmacy study found 289 of 510 relevant interaction alerts were overridden with no action. When most alerts say nothing new, the one that matters gets the same click.
>
>
>
> Package-level tracing is also becoming the rule under the federal DSCSA law, so that data has to exist anyway.
>
> Chimera Rx is a modern pharmacy system built on one ledger: lot, serial, patient and prescription history in one place. Agents watch it in the background. A pharmacist decides. A recall is the sharpest proof, because it needs every piece at once.

**Why it matters:** the claim is not "we found a recall tool", it is "we replaced the silos". Sources for every number above are in the README and [docs/evidence/items/market.md](evidence/items/market.md). Do not add numbers that are not there.

---

## B. The day in the pharmacy

### B1. Sign in and roles (1:20 to 1:40)

**Clicks:** point at the store picker and the demo accounts on the sign-in page. Sign in as the pharmacist (`j.rivera`). In the sidebar point at the groups: Operations, Care, AI, Admin, Demo.

> Staff pick their pharmacy and sign in. There are four roles, enforced on the server, not just on the screen. [pause] The pharmacist decides. The technician receives and fills. The cashier hands over, and never sees allergies or birth dates. The admin manages partners. Every action lands in the audit log.

**Why it matters:** safety rule 3, a pharmacist decides, is a permission model and not a banner.

### B2. Today (1:40 to 2:01)

**Clicks:** Today. Hover the red recall banner, the Rx Guardian suggestions card, the four tiles, the work queue, Expiring lots, Lot activity. Point at the search box and say you can scan a package into it.

> Today is the pharmacist's work list. The red banner is a recall fax that arrived overnight. The card below is the Rx Guardian, an agent that has already read the open orders. The tiles show deliveries, fills, lot capture rate and a simulated fridge sensor. Everything links to where the work happens.

**Why it matters:** one screen, no switching between a dispensing system, a spreadsheet and a fax machine.

### B3. Receiving (2:01 to 2:36)

**Clicks:** Receiving, delivery ASH-1105-07. Paste the amoxicillin label code and press **Check**. Show the checks. Confirm the suggested put-away spot. Then run the scenario shortcut only if you have time: Demo guide, "Receiving problems", scan the warm insulin label, show the red check and **Report a problem**.

> Receiving is where the ledger starts. A technician scans the barcode on each package, so lot, expiry and serial are read, not typed. Four checks run at once: the invoice, the supplier's transaction record, the expiry, and any recall. Refrigerated items are checked against the shipper's temperature log. A Schedule II put-away needs a second staff member as witness. [pause] If a check fails, the package cannot be shelved. It can only be reported and quarantined. No barcode? Browser OCR reads the text, and a person checks every field.

**Why it matters:** this is where the lot enters the ledger, so a recall later has something to find. The temperature log and the supplier record are synthetic, and the suspect check compares against stand-in data.

### B4. Inventory (2:36 to 2:50)

**Clicks:** Inventory. Click the filter chips: Recalled, Expiring, Refrigerated, Controlled. Open one lot to show the lot history. Point at **Move location** and **Adjust count**.

> Inventory is by lot. The chips filter to recalled, expiring, refrigerated and controlled stock. Each lot has a history of every receive, fill, move and adjustment. Controlled count changes need a pharmacist and a witness.

**Why it matters:** the same ledger answers "where is it" and "who got it".

### B5. Fill and pickup, every path (2:50 to 4:17)

**Clicks, in order.** Full map: [FILL_PATHS.md](FILL_PATHS.md).

1. Fill & pickup. Point at the queue and its chips: To review, To fill, To verify, Ready, Sold.
2. Click Rx 0072210 (Daniel Brooks, insulin). Show Rx Watcher's two findings and the Rx Guardian panel below it.
3. Try to scan: paste the insulin label. Show the refusal.
4. On a Guardian suggestion press **Accept: hold the order**, then show the refusal again ("on hold").
5. Press **Ask prescriber to change**, **Send change request**, then **Prescriber approved** (sandbox). Open the new order `0072210-R1`.
6. Open Rx 0072214 (Linda Chen). Paste a code with no serial. Show the amber note. **Print label**, then **Send back**.
7. Rescan with the serial. **Print label & send to pharmacist**, tick the four boxes, **Approve as**, switch to the cashier, tick ID, counseling, signature, **Complete sale**.
8. Show the cashier's view of an order: no birth date, no allergies.

> This is the heart of the day. [pause] First, a flagged order. Before anyone touches the package, Rx Watcher has read it with plain rules. This insulin says twice a day, but the label says once. And the days supply does not match the quantity. A scan is refused until a pharmacist decides.
>
> Under it, the Rx Guardian has read the patient's whole history and cites the evidence: gaps in fills, a medicine he already takes, a late refill. Every suggestion says "AI advisory, a pharmacist decides." The pharmacist can accept, which holds the order, dismiss with a reason, or send a change request. That request is a sandbox message in the standard prescriber format. The answer creates a new version of the order, checked again, and the original stays unchanged.
>
> Now a clean order. The drug must match, the lot must be clean, and in date. The serial is matched to the exact package we received. [pause] If the label has no serial, Chimera Rx assumes the oldest unit of that lot and says so, in amber. It never shows an assumed serial as scanned.
>
> Then the label prints, and only the pharmacist verifies. At pickup, photo ID, counseling and signature. The lot and serial are now on the patient's record. That is the link nobody records today.

**Say if asked about a recalled lot, and run it in B9:** a recalled lot is refused at fill, even after the recall is closed.
**Say if asked about Schedule II:** the witness step is at receiving and at count changes. There is no Schedule II witness at fill in this build.

**Why it matters:** safety rules 3, 6, 7 and 8 are each a path you can click.

### B6. Register (4:17 to 4:32)

**Clicks:** sign in as the cashier. Register. Add an over-the-counter item. Pick the patient with a ready prescription, tick the pickup checks.

> The register joins the front store and the pharmacy. One sale can mix an over-the-counter item and a verified prescription. A recalled lot is blocked here too. "Paid" is only a label. No payment is processed.

**Why it matters:** one counter, one ledger. The recall block follows the lot even at the register.

### B7. Patients (4:32 to 4:42)

**Clicks:** sign back in as the pharmacist. Patients, search "Brooks", **Open profile**. Show Medication history with lots, Active medicines, Upcoming refills.

> A patient profile shows medicine history with the lot on every fill, active medicines and upcoming refills. Opening it records a reason in the audit log.

**Why it matters:** history with lots is what lets the agents and the recall find the right patient.

### B8. Refills (4:42 to 5:01)

**Clicks:** Demo guide, scenario **Recall-aware refill**. Refills. Show the worklist, the adherence panel, **Medication sync**. Press **Draft reminders**.

> Refills are rules, not guesswork. The worklist shows who is due. Adherence is the share of days covered, flagged under eighty percent. Sync lines up one pickup trip a month. An agent can reword the reminders, and a pharmacist approves them. Schedule II drugs are never offered automatically.

**Why it matters:** a refill system that knows the lot is the only kind that can stop a reminder for a recalled medicine. The next section shows that.

### B9. Recalls, end to end (5:01 to 6:05)

**Clicks:** Recalls. **Start recall** from Today, or **Read this fax with OCR** on D-0417-2026. Show the lots read, the verbatim gate, **Review impact**, **Continue to patient messages**, **Use AI draft**, tick the attestation, send. Open **Sandbox outbox**. Then Demo guide, scenario **Class I recall**, Recalls, look up `D-0611-2026`. Go to Refills: Priya's row is red. Go to Fill & pickup, approve Rx 0072210, scan lot GX4471C: refused.

> A fax arrived. I retype nothing. The browser reads it, openFDA confirms the record, and the Coroner pulls the lots. [pause] The rule that matters: a lot is kept only if it is printed in the notice, word for word. If a model invents one, it is thrown away, and you can see what it dropped.
>
> One click quarantines the exact units and lists the patients who took one home, with the channel each agreed to. An agent drafts the messages and cannot send them. The pharmacist reads, attests and sends. Each text names only that patient, with the pharmacy phone and a STOP option. Nothing leaves this laptop. It goes to a sandbox outbox.
>
> Now a Class I insulin recall. Same flow. And look at Refills: her row turns red, because her last fill came from that lot, so no reminder goes out. [pause] Back at the counter, scanning that lot is refused. It stays refused after the recall closes.

**Why it matters:** notice, shelf, patients, messages, refills and the counter, from one ledger. Rules 4, 5, 8 and 9.

### B10. Transfers and two stores (6:05 to 6:18)

**Clicks:** Transfers. Choose a lot, a quantity, **Move stock**. Optionally sign in as `s.okoro@birchavenuerx.example` to see it arrive.

> There are two stores. A pharmacist can move packages between them, and each keeps its lot and serial. Both audit logs record it, and a recall in one store is mirrored to the other.

**Why it matters:** a pharmacy group is more than one store, and lot and serial must survive the move.

---

## C. How the AI agents work in the backend (6:18 to 7:44)

**Clicks:** AI agents. Point at the Provider card, then the list of eight agents. Open **Rx Guardian**: **Run now**, show **Switch on**, last run and next run. Open **Suggestions**. Open **Recent runs** and one run's detail with the dropped list. Show **Guardrails**.

> Behind the screens are eight agents, and all follow one pattern. Rules decide. The model explains. A gate checks the model. A pharmacist decides. [pause]
>
> Take the Rx Guardian. Rules read the order against the patient's history and produce findings with evidence. The model only explains them in plain words. Then the gate drops any sentence with a number the facts don't contain, any note citing a fact that doesn't exist, and any "this is fine" wording. The agent cannot change an order. It can only raise a suggestion.
>
> Four agents can run in the background once a pharmacist or admin switches them on. The Guardian checks every new or changed order within a minute. The others run daily. If the model fails, you get the rules-only result, labelled as such.
>
> The model is a setting, not a dependency. Amazon Bedrock is the default. Bring your own: Anthropic, any OpenAI-compatible endpoint including a local model, an offline mock, or rules only.
>
> Prompts carry patient IDs, drugs and lot numbers, never names or birth dates, and a check blocks the call if one slips in. Tests use lying models that try to invent a lot or hide a finding, and the gates catch them. Outside agents can ask too, through a read-only MCP endpoint with scoped keys.

**Why it matters:** this is the answer to "how do you trust AI in a pharmacy": the model is never the decider, and the rules and the gate are tested. The Guardian's interaction and age tables are small synthetic demo tables, not clinical content. Live Bedrock was checked once on 2026-11-20; if the connection fails on the day, switch to `mock` and say so.

---

## D. DSCSA and EPCIS (7:44 to 8:00)

**Clicks:** DSCSA & trace. **Download .jsonld** for a lot, **Ask the sandbox verifier**, show Suspect product cases.

> Because every package's lot and serial is in the ledger, the same events export as EPCIS 2.0, the standard for package-level tracing. A verifier answers verification requests. [pause] That verifier is a sandbox stand-in, and nothing here is a filing.

**Why it matters:** the ledger already holds what package-level tracing needs; the export shows it can leave the building in a standard form. A sandbox, not a filing.

---

## E. Security and privacy (8:00 to 8:53)

**Clicks:** open [SECURITY.md](SECURITY.md) or the Integrations screen's Security card. Optionally show `GET /api/audit/verify` returning `"ok": true`.

> Patient names, birth dates, phones, emails, allergies, directions and message bodies are encrypted at rest with AES-256-GCM. A test reads the raw database file and finds none of them. Keys rotate with one command. Roles are enforced on the server. The audit log is hash-chained, so an edit breaks the chain and the verify route says so. Messages go only to a sandbox outbox.
>
> Here is what is not covered, because saying it builds trust. No TLS in the app: put a proxy in front. No managed key service: the default key sits beside the data. Some columns, like lot and prescription numbers, are plaintext. No breach process and no independent security review. This is a sandbox with synthetic data. It is not HIPAA compliant, and we do not claim it is.

**Why it matters:** judges and pharmacists trust a system that states its limits. Read the not-covered list aloud.

---

## F. How it was built with Kiro (8:53 to 9:29)

**Clicks:** show the `.kiro` folder: `steering/pharmacy-safety.md`, `specs/coroner`, `hooks/phi-guard.json`, then `docs/KIRO_USAGE.md`.

> We built this with Kiro. Steering files hold the eleven pharmacy safety rules and always load. Specs, written as requirements, cover the Coroner and the openFDA client, and requirement numbers travel into the tests. A hook blocks any commit that looks like patient data, and another runs property tests on save. We planned the pilot with Kiro's AI-DLC workflow, and independent agent reviews found and fixed real bugs.
>
> To be straight: the AI-DLC run stopped at user stories, we did not use MCP to build, and only two modules have specs.

**Why it matters:** the claims here are exactly the ones in [KIRO_USAGE.md](KIRO_USAGE.md). Do not add to them.

---

## G. Integration and the future (9:29 to 9:48)

**Clicks:** Integrations (sign in as admin or pharmacist). Show Connected partners, the REST, MCP and FHIR tabs, **Send request**, Webhooks.

> What exists today: a REST API, an MCP endpoint, FHIR R4 reads, signed webhooks and EPCIS export, all behind scoped keys. [pause] What is future, and not built: wholesaler data exchange, real electronic prescribing, payer connections, immunization registries, multi-store analytics, on-device voice and a managed key service.

**Why it matters:** the pharmacy is not a silo. The integration surfaces are real and tested; the roadmap items are labelled future and are not in the repo.

---

## H. Close (9:48 to 9:58)

> One ledger, agents in the background, and a pharmacist who decides. A modern pharmacy system, and the recall is the proof. This is Chimera Rx.

The full read is longer than ten minutes if you add the optional receiving-problem and Store 2 beats. Cut those first.

---

## Appendix 1. Screen guide: what each control means

Use this to answer questions on camera. Roles in brackets can use the control.

### Sign in
- **Pharmacy picker:** which store's database you open. **Email, password:** a wrong password five times locks the account for 15 minutes.
- **Badge tap / SSO:** a demo stand-in that signs in the Store 7 pharmacist. Off when `MFA=1`.
- **Second factor:** with `MFA=1`, a six-digit code goes to the sandbox outbox (shown on the page in demo mode).

### Today
- **Red banner, Start recall:** a recall fax is waiting; opens Recalls.
- **Refills due or overdue card:** counts from the refill worklist; opens Refills.
- **Rx Guardian suggestions card:** open suggestions by severity (Block, Needs review, Monitor), top three, **See all** opens AI agents.
- **Tiles:** deliveries to check in; prescriptions filled and waiting; lot capture rate (share of fills with lot and serial recorded); fridge temperature (simulated sensor).
- **Work queue, Expiring lots, Lot activity:** each row links to where the work is done. Lot activity is the live ledger feed.
- **Search box:** type a lot, NDC or Rx number, or scan a package with a USB scanner.

### Receiving [technician, pharmacist]
- **Delivery card:** invoice, lines, packages left. **Scan with camera / Read label text (OCR) / Upload a label photo / Check:** four ways to read a package. OCR output is a suggestion you edit.
- **Check results:** invoice, transaction information, expiry, recall, plus temperature (refrigerated) and order match (controlled). Any red check blocks put-away.
- **Put away at:** confirms the suggested location. Schedule II asks for a witness's email and password.
- **Report a problem:** short shipment, damaged, wrong item or suspect product; quarantines the package. **Verify with manufacturer (sandbox):** asks the stand-in verifier.

### Inventory [technician, pharmacist]
- **Chips:** All lots, Recalled, Expiring within 60 days, Refrigerated, Controlled. Status labels: Available, Reorder, Expiring soon, Expired, Recalled · held.
- **Move location:** moves units on the shelf; a refrigerated lot cannot go to a room shelf; only a pharmacist moves Schedule II. **Adjust count:** needs a reason; Schedule II needs a witness. **Lot history:** every event on the lot.

### Fill & pickup [cashier sees pickup only]
See [FILL_PATHS.md](FILL_PATHS.md). Queue chips: **To review** (Rx Watcher flagged it), **To fill** (cleared), **On hold** (waiting for the prescriber), **Rejected**, **To verify**, **Ready**, **Sold**. "Rx Watcher · Clear / 2 flags / Approved with flags / Resolved" is the rule result. "Rx Guardian · N suggestions" is the history check.

### Register [cashier, pharmacist]
- **Scan or search items:** twelve synthetic over-the-counter items. **Find the patient:** brings up that patient's verified prescriptions. **Pickup checks:** photo ID, counseling, signature. **Mark paid and print receipt:** records the sale; no payment is processed.

### Patients [technician, pharmacist]
- **Find a patient:** name, date of birth, phone or ID. **Open profile:** asks for a reason, audited. Panels: medication history (lot on every fill), active medicines, upcoming refills, recalled lots received. **Refill sync:** lines up one pickup day.

### Recalls [pharmacist only]
- **Look up recall** or **Read this fax with OCR** or **Upload the fax instead**. **Confirm lot:** one lot at a time when confidence is under 0.95 or there is no expiry. **Review impact:** shelf units (moved to quarantine) and patients, matched by lot recorded at fill. **Continue to patient messages**, **Use AI draft**, attestation, send. **Call patients / Pharmacist call list**, **Schedule return pickup**, **Send response to the manufacturer**, **Close this recall**, **Download audit report**, **Export trace (EPCIS)**.

### Refills [staff]
- **Refill worklist** states: due soon, due, overdue, needs a new prescription, no refills left, **Recall hold**. **Adherence (PDC)**, **Medication sync**, **Draft reminders** (a pharmacist approves and sends).

### Stock help [staff]
- Tabs: **Reorder**, **Expiry risk**, **Shortages**. **Accept** / **Dismiss** record a decision. "AI advice" is one sentence per item with numbers checked.

### Transfers [pharmacist]
- **Move to**, **Choose a lot**, **How many packages**, **Move stock**. Recorded in both audit logs.

### DSCSA & trace [staff]
- **Export trace (EPCIS 2.0)** with **Preview** and **Download .jsonld**. **Import trace (advisory)**: dry run first. **Verification requests / sandbox verifier.** **Suspect product cases.**

### AI agents [pharmacist, technician; admin for settings]
- **Agents** tab: eight cards, each with **Run with sample input**, **Use my own input**, **Guardrails**, and for the four background agents **Switch on / Switch off** and **Run now**. **Suggestions** tab: the Guardian's list. **Provider:** choose, **Save**, **Test connection**. **Recent runs:** stored runs with the dropped list.

### Integrations [admin, pharmacist]
- **Connected partners**, **Rotate secret**, **Revoke**, **Connect a system, try it live** (REST, MCP, FHIR tabs and **Send request**), **Security**, **API activity**, **Webhooks** (**Add webhook**), **Export audit log (NDJSON)**.

### Demo guide, Test labels, Sandbox outbox
- Demo only, and hidden when `LG_DEMO=0`. **Scenarios** reset the data and show a brief. **Test labels** are real DataMatrix codes. **Sandbox outbox** shows every message the demo "sends".
