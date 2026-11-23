# Refills and adherence

## The gap

Pharmacies lose patients and revenue to missed refills and poor adherence. Refill tools know the drug and the date. They do not know which **lot** the patient last received, so they keep nudging a patient to refill a medicine that came from a recalled lot. Chimera Rx scans the lot at fill, so it can hold that refill back.

Everything on the Refills screen is rule-based and needs no AI. The AI only words the reminder messages, and a pharmacist approves them. Synthetic data, sandbox only, no clinical validity is claimed.

## What it does

| Part | Rule |
|---|---|
| Worklist | Each patient and drug has a run-out date: the last fill plus its days supply, with early pickups carried forward. **Due soon** is within the look-ahead (default 7 days). **Due** is up to the grace window past run-out (default 7 days). **Overdue** is beyond it. Set the grace with `REFILL_GRACE_DAYS` or `?grace=`, and the look-ahead with `?lookahead=`. "Today" is the app's today (`TODAY`). |
| Adherence | PDC, below. Flagged under 80 percent. A drug with one fill shows "one fill" and is not flagged. |
| Sync | One pickup day per patient. See below. |
| Recall block | See below. |
| Schedule II | Never auto-refillable. Shown as "needs a new prescription". A product stored in the controlled safe, or a known C-II name, counts. |
| No refills left | Shown as "ask the prescriber for a renewal", not offered. |

## PDC formula

Proportion of days covered, per patient and drug:

```
window  = the last 180 days up to and including today, never earlier than the first fill of that drug
covered = days in the window that fall inside a supply
PDC     = covered / days in the window        (always between 0 and 1)
```

Fills are laid end to end. A fill picked up before the previous supply ends starts on the day that supply ends (carry-forward), so an early pickup is not counted twice and not wasted. Fills marked "Replaced" and fills dated in the future are ignored. The code is `pdc()` in `apps/api/src/refills.ts`; the tests include fast-check properties (always 0 to 1, more days of supply never lowers it, adding a fill after the first fill never lowers it).

## Medication sync

For a patient with two or more offered refills due within 30 days:

1. The pickup day is the earliest run-out date, or today if one has already run out.
2. A drug that is already due gets a full 30-day fill.
3. A drug that runs out later gets a short fill that starts when its supply ends and stops on the common end date (pickup day plus 30). Short fill days = common end date minus its run-out date.
4. A drug whose short fill would be under 7 days is left for the next cycle.

Example: lisinopril ran out Nov 15 (full 30 days), amlodipine runs out Nov 28 (short fill of 20 days), sertraline runs out Dec 4 (14 days). One trip on Nov 18, then all three are due on Dec 18.

## How recall-awareness works

For each patient and drug, the lot of the **last fill** is checked against the lot ledger:

- If that lot is `recalled` or `quarantined`, or is part of a pharmacist-confirmed recall, the refill is **not offered**. The row turns red, says which lot and which recall, and links to Recalls.
- The hold survives closing the recall (pharmacy-safety rule 8, "recalled stays blocked").
- A blocked or Schedule II row is left out of sync suggestions and out of reminders.
- At send time the block is read again. A reminder drafted before a lot was recalled is skipped when it is sent.

## The Refill Outreach agent (agent 7)

Rules build the list and pick the channels from consent. The model may only reword four templates (text, email subject, email body, voicemail). Its prompt holds patient IDs and counts, never a name, phone, email or drug. A gate then checks:

- a template with a name, phone, email, patient ID or unknown placeholder falls back to the approved text;
- a text must carry the pharmacy phone and STOP;
- a voicemail never names the medicine, a condition or a patient ID;
- each finished draft is checked once more, and a draft that names another patient is dropped.

It works with provider `mock` and with `none` (approved templates only). It never sends. Drafts wait in the drafts queue. A pharmacist ticks the attestation and sends from Refills; consent is read again at that moment, and texts and emails go through the same sandbox notifier as recalls, to the outbox. A voicemail is rendered, never dialled. A technician can draft but not send. A cashier gets 403.

## "Use AI draft" in a recall

In Recalls, on the patient-messages step, **Use AI draft** runs the Recall Outreach Drafter and loads its wording into the text, email and voicemail boxes. It is labelled "AI draft, a pharmacist approves". Nothing is sent: the pharmacist edits, ticks the attestation and sends through the existing flow, which still refuses without it.

## Try it in 60 seconds

1. Sign in as the pharmacist (J. Rivera; type the email and the shared synthetic password from `README.md`).
2. Open **Refills**. On a fresh seed four refills are due and offered.
3. Click **Draft reminders**, tick the attestation and send. The messages land in the **Sandbox outbox** (sidebar).
4. In **Recalls**, look up `D-0611-2026` (insulin glargine lot GX4471C) and, on the patient-messages step, try **Use AI draft**.

The recall-hold walkthrough with named patients (an insulin row that turns red and links to the recall, an oxycodone refill that needs a new prescription, a one-trip sync, a low-adherence flag) uses the **Recall-aware refill** fixture in `apps/api/test/scenario-fixtures.ts`. `apps/api/test/refills.test.ts` and `pnpm e2e` load it; the product has no button that does, because the app ships without demo scaffolding.

API: `GET /api/refills`, `POST /api/refills/draft`, `POST /api/refills/send` (pharmacist, with `attest: true`), `GET /api/refills/drafts`.
