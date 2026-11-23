# Submission video script (under 3:00)

The spoken script for `demo-video/chimera-rx-submission.mp4`. Every line that starts with `>` is one narration unit. The
voice is Kokoro (male, `am_onyx`), generated first; the screen recording is then fitted to the measured audio length.
Rebuild with `pnpm demo:record:submission`. Synthetic data only; HIPAA-style safeguards, not certified.

Story balance: about 45 percent modernization of pharmacy systems, about 35 percent AI agents in the background with a
pharmacist in the loop, the rest a quick tour by role. The recall is one example of the gap legacy systems leave.

## 1. Modernization <!-- id: hook -->

**Screen:** sign-in page, then the pharmacist signs in.

> Most pharmacies still run on fax machines, phone calls, paper logs, and systems that don't talk to each other. The lot, the patient, and the prescription live in three different places.
> Chimera Rx shows what a modern pharmacy system looks like. One connected ledger links every lot, every patient, and every prescription, from the dock to the pickup counter.
> Here's a quick tour, by role.

## 2. Tour by role <!-- id: tour -->

**Screen:** technician receiving, pharmacist inventory and fill, cashier register, refills.

> The technician receives a delivery. Scan the label, and the lot gate checks the paperwork, the expiry, and the recall list before stock is shelved.
> The pharmacist sees inventory by lot, with expiry and shelf location, then fills and verifies each order, with Rx Watcher checking the rules.
> The cashier runs pickup and the register, and can't see allergies or recalls.
> Refills show who is due, and patients keep their full history in one place.

## 3. The gap a recall exposes <!-- id: recall -->

**Screen:** Recalls: fax OCR, lots, confirm, quarantine, patients, messages.

> Here's the gap old systems leave. A recall fax arrives, and nobody captured the lot, so you warn everyone, or no one.
> Connected, it takes seconds. The pharmacist confirms the lots, stock moves to quarantine, and the exact patients appear, with messages drafted for approval.

## 4. Open and connected <!-- id: open -->

**Screen:** DSCSA and EPCIS, partner access, MCP, two stores, the outbound placeholder list.

> Everything speaks open standards. DSCSA traceability and EPCIS exports give every package a history, and the sandbox verifier flags a spoofed one.
> Partners connect through a REST API, an MCP server, FHIR behind OAuth, and signed webhooks. The admin controls who gets in, and every call is audited.
> Two stores can transfer stock, and both audit logs record the move.
> Real-world connections are designed seams: text messages, email, phone calls, wholesaler, e-prescribing, the dispensing system, the EHR, payer, SSO, and key management. They are sandboxed today, so nothing reaches a real person.

## 5. AI agents <!-- id: agents -->

**Screen:** AI agents page, Rx Guardian Run now, suggestions with evidence, accept, Coroner gate, providers.

> Now the AI agents. Eight of them help in the background: a recall reader, an order watcher, a guardian, outreach drafters, a night digest, and more. Every one follows the same rule. Rules decide, the model explains, a gate checks the model, and a pharmacist decides.
> Rx Guardian works on its own, even when nobody is looking, and it never changes an order itself. Run it now, and it flags things a busy pharmacist could miss, like duplicate therapy, an interaction, or late fills.
> Each suggestion shows its evidence from the patient's history. Accept one, and the order goes on hold with the reason recorded, so the pharmacist can decide. Dismiss it, and the reason is kept too.
> The Coroner keeps only lots printed word for word on the recall notice, and drops anything the model invented. Outreach drafts for recalls and refills need the pharmacist's attestation before anything is sent, and a patient on a recalled lot never gets a routine reminder.
> Pick any provider: Bedrock, Anthropic, an OpenAI-compatible endpoint, or a local model. Patient names and birth dates stay out of the prompts, and every run is logged.

## 6. Security <!-- id: security -->

**Screen:** audit chain.

> Security is built in. PHI fields are encrypted, roles are enforced on the server, and the audit log is hash-chained. These are HIPAA-style safeguards, not certified.

## 7. Built with Kiro <!-- id: kiro -->

**Screen:** animated Kiro card, animated end card.

> Built with Kiro. Specs carry requirement IDs, steering holds the safety rules, and hooks run a PHI guard on save. A custom agent and a Kiro Crew team did the work, with a human at every gate.
> Chimera Rx. github dot com slash P J Borad slash Chimera R X. Synthetic data only. ||| Chimera Rx. github.com/pjborad/Chimera-Rx. pjborad.github.io/Chimera-Rx. Synthetic data only.
