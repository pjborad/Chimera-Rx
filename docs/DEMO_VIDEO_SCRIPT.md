# Submission video script (under 3:00)

The spoken script for `demo-video/chimera-rx-submission.mp4`. Every line that starts with `> A:` or `> B:` is one narration
turn. Two Kokoro male voices hand over to each other, no pauses: **A** (`am_onyx`, env `VOICE_A`) gives the why: the
modernization story, the gap, security and Kiro. **B** (`am_michael`, env `VOICE_B`) gives the how: each tab and role, and
how the agents work in the background. Each turn is generated on its own, trimmed and normalised to -16 LUFS; the screen
recording is then fitted to the measured audio. Rebuild with `pnpm demo:record:submission`. Synthetic data only;
HIPAA-style safeguards, not certified.

Story balance: modernization first (about 40 percent), AI agents (about 30 percent), a quick tab tour by role. The recall is
one example of the gap legacy systems leave.

## 1. Modernization <!-- id: hook -->

**Screen:** sign-in page, then the pharmacist signs in, then Today.

> A: Most pharmacies still run on fax machines, phone calls, paper logs, and systems that don't talk to each other. The lot, the patient, and the prescription live in three different places. Chimera Rx shows what a modern pharmacy system looks like: one connected ledger, from the dock to the pickup counter. Show them how that works.
> B: Sure. Staff sign in with a password and a six-digit code, and the server checks every role.
> B: Today shows each person only their own work.

## 2. Tour by role <!-- id: tour -->

**Screen:** technician receiving, pharmacist inventory and fill, cashier register, refills and patients.

> B: A technician receives a delivery. Scan the label, and the lot gate checks the paperwork, the expiry, and the recall list.
> B: The pharmacist sees stock by lot, with expiry and shelf location, then fills and verifies each order while Rx Watcher checks the rules.
> A: Least privilege is the point. The cashier runs the register and can't see allergies or recalls.
> A: Refills show who is due, and each patient keeps one history.

## 3. The gap a recall exposes <!-- id: recall -->

**Screen:** Recalls: fax OCR, lots, confirm, quarantine, patients, messages.

> A: Here's the gap old systems leave. A recall fax arrives, and nobody captured the lot, so you warn everyone, or no one.
> B: Connected, it takes seconds. The pharmacist confirms the lots, stock moves to quarantine, and the exact patients appear, with messages drafted for approval.

## 4. Open and connected <!-- id: open -->

**Screen:** DSCSA and EPCIS export, then the sandbox verifier (a real serial, then a spoofed one), partner access and MCP, two stores, the outbound placeholder list.

> A: Everything speaks open standards. DSCSA and EPCIS exports give every package a history.
> B: Here the sandbox verifier checks a package: a real serial verifies, and a spoofed one comes back not verified.
> B: Partners connect through a REST API, an MCP server, FHIR behind OAuth, and signed webhooks. The admin controls who gets in, and every call is audited.
> A: Two stores can transfer stock, and both audit logs record the move.
> A: The real-world connections, like text, email, phone, wholesaler, e-prescribing, the health record, payer, and single sign-on, are designed seams, sandboxed today, so nothing reaches a real person.

## 5. AI agents <!-- id: agents -->

**Screen:** AI agents page, Rx Guardian Run now, suggestions with evidence, accept, Coroner gate, providers.

> A: Now the AI agents. Eight of them help in the background, and every one follows one rule: rules decide, the model explains, a gate checks the model, and a pharmacist decides. Take us through Rx Guardian.
> B: Rx Guardian works on its own, even when nobody is looking, and never changes an order itself. Run it now, and it flags things a busy pharmacist could miss, like duplicate therapy, an interaction, or a late fill.
> B: Each suggestion shows its evidence from the patient's history. Accept one, and the order goes on hold with the reason recorded. Dismiss it, and that reason is kept too.
> A: The Coroner gate is the safety net. It keeps only lots printed word for word on the recall notice, and drops anything the model invented.
> B: Pick any provider: Bedrock, Anthropic, an OpenAI-compatible endpoint, or a local model. Patient names and birth dates stay out of the prompts, and every run is logged.

## 6. Security <!-- id: security -->

**Screen:** audit chain.

> A: Security is built in. PHI fields are encrypted, roles are enforced on the server, and the audit log is hash-chained. These are HIPAA-style safeguards, not certified.

## 7. Built with Kiro <!-- id: kiro -->

**Screen:** animated Kiro card, animated end card.

> A: Built with Kiro. Specs carry requirement IDs, steering holds the safety rules, and hooks run a PHI guard on save. A custom agent and a Kiro Crew team did the work, with a human at every gate.
> A: Chimera Rx. github dot com slash P J Borad slash Chimera R X. Synthetic data only. ||| Chimera Rx. github.com/pjborad/Chimera-Rx. pjborad.github.io/Chimera-Rx. Synthetic data only.
