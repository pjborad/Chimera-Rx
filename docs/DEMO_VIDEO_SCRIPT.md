# Submission video script (under 3:00)

The spoken script for `demo-video/chimera-rx-submission.mp4` (v5). Every line that starts with `> A:` or `> B:` is one
narration turn. Two Kokoro male voices, each speaking one half, no pauses: **A** (`am_onyx`, env `VOICE_A`) speaks the first
half (the modernization hook, then Today through Fill & pickup), one handover line closes it, and **B** (`am_michael`, env
`VOICE_B`) speaks the second half (Patients through Integrations, roles and security, Kiro, the end card). Each turn is
generated on its own, trimmed and normalised to -16 LUFS; the screen recording is then fitted to the measured audio.
Rebuild with `pnpm demo:record:submission`. HIPAA-style safeguards, not certified.

Pace (round 7): the whole video stays in the pharmacist's view (j.rivera, signed in once, off camera). All 14 sidebar
tabs appear in workflow order: Today, Receiving, Inventory, Register, Stock help, Transfers, Fill & pickup, Patients,
Recalls, Refills, DSCSA & trace, Sandbox outbox, AI agents, Integrations. A caption names each tab on arrival. The cursor
glides about 450 ms and each click is followed by about 0.7 s. No scene is sped up beyond 1.4x. The other roles are
mentioned in narration and one four-role lower-third only.

Story balance: modernization first, AI agents prominent, the recall as one example of the gap legacy systems leave.

## 1. Modernization and Today <!-- id: hook -->

**Screen:** Today, pharmacist view.

> A: Most pharmacies still run on fax machines, phone calls, paper logs, and systems that don't talk to each other. Chimera Rx is one connected ledger, from the dock to the pickup counter. Here is every tab a pharmacist uses.
> A: Today is the pharmacist's home. Deliveries to check in, stock to watch, and suggestions from the AI agents, all in one place.

## 2. Receiving <!-- id: receiving -->

**Screen:** one scan, lot captured, put-away.

> A: Receiving starts at the dock. One scan with the camera reads the lot, serial, and expiry, with no typing and no paper log.
> A: Four checks run: the invoice, the paperwork, the expiry, and the recall list. Then put-away is recorded, with the bay.

## 3. Inventory <!-- id: inventory -->

**Screen:** Inventory with the expiring, refrigerated and controlled filters.

> A: Inventory shows every lot on the shelf, by store, with its expiry. Filter for what is expiring, what is refrigerated, and what is controlled, and a count is always one click away.

## 4. Register <!-- id: register -->

**Screen:** Register, one item, paid, receipt.

> A: Register handles the sale at the counter. Pick an item, mark it paid, and the receipt prints, with the sale recorded against the same ledger as everything else.

## 5. Stock help <!-- id: stock -->

**Screen:** Stock help, reorder and expiry risk.

> A: Stock help suggests what to reorder and what is close to expiry, so the pharmacy orders what it needs and stops throwing medicine away.

## 6. Transfers <!-- id: transfers -->

**Screen:** Transfers, one lot moved to the second store.

> A: Transfers move stock between two stores. Pick a lot, move it, and the transfer lands in both stores' audit logs, with no phone call and no paper slip.

## 7. Fill and pickup <!-- id: fill -->

**Screen:** one order with the Rx Guardian suggestion and its evidence, then accept.

> A: Fill and pickup is where it all meets. Rx Guardian reviews an order the moment it arrives, and shows the evidence from the patient's own history, so nothing is a guess.
> A: Accept the suggestion, and the order goes on hold with the reason recorded in the audit log. The pharmacist always decides, and the agent never changes an order itself.
> A: That is the dock to the counter. Over to my co-host for the care side.

## 8. Patients <!-- id: patients -->

**Screen:** Patients, search, reason for opening, profile.

> B: Patients holds each history. Search for a patient, state why you are opening the profile, and that reason is written to the audit log.

## 9. Recalls <!-- id: recalls -->

**Screen:** Recalls: fax read, lots confirmed, affected patients, messages, attestation.

> B: Here is one gap old systems leave. A recall arrives by fax, and nobody knows who got which lot. Connected, the lots are read from it.
> B: The pharmacist confirms each lot, and the affected patients appear.
> B: Messages are drafted for exactly those patients. The pharmacist attests, and only then do they go out, to the sandbox.

## 10. Refills <!-- id: refills -->

**Screen:** Refills worklist, draft reminders.

> B: Refills lists who is due, drafts reminders, and flags prescriptions that need a new one.

## 11. DSCSA and trace <!-- id: dscsa -->

**Screen:** DSCSA & trace, export preview, verification.

> B: DSCSA and trace exports the product history, and checks serials in a sandbox.

## 12. Sandbox outbox <!-- id: outbox -->

**Screen:** Sandbox outbox.

> B: Every message lands in the sandbox outbox, so nothing reaches a real person.

## 13. AI agents <!-- id: agents -->

**Screen:** AI agents page, Rx Guardian Run now, providers.

> B: Now the AI agents. Eight work in the background. Rules decide, the model explains, a gate checks the model, and a pharmacist decides.
> B: Run Rx Guardian now, and it flags what a busy pharmacist could miss. It never changes an order itself.
> B: Pick any provider, even a local model. Patient names stay out of the prompts, and every run is logged.

## 14. Integrations <!-- id: integrations -->

**Screen:** Integrations: partners, MCP server, placeholders.

> B: Integrations speak open standards: REST, an MCP server, FHIR behind OAuth, and signed webhooks.
> B: Real connections, like text, email and e-prescribing, are designed seams, sandboxed today.

## 15. Roles and security <!-- id: security -->

**Screen:** Today with a lower-third listing the four roles, then the audit chain.

> B: Roles are enforced on the server. A cashier never sees allergies, and an admin never touches anything clinical.
> B: PHI is encrypted and the audit log is hash-chained. HIPAA-style safeguards, not certified.

## 16. Built with Kiro <!-- id: kiro -->

**Screen:** animated Kiro card, then the end card (name, repository and site only).

> B: Built with Kiro: specs, steering, hooks, and a Kiro Crew team, with a human at every gate.
> B: Chimera Rx. github dot com slash P J Borad slash Chimera R X. ||| Chimera Rx. github.com/pjborad/Chimera-Rx. pjborad.github.io/Chimera-Rx.
