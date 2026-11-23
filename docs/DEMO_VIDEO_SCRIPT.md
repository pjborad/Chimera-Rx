# Submission video script (under 3:00)

The spoken script for `demo-video/chimera-rx-submission.mp4` (v4). Every line that starts with `> A:` or `> B:` is one
narration turn. Two Kokoro male voices hand over to each other, no pauses: **A** (`am_onyx`, env `VOICE_A`) gives the why:
the modernization story, the gap, roles, security and Kiro. **B** (`am_michael`, env `VOICE_B`) gives the how: what is on
screen and how the agents work. Each turn is generated on its own, trimmed and normalised to -16 LUFS; the screen recording
is then fitted to the measured audio. Rebuild with `pnpm demo:record:submission`. HIPAA-style safeguards, not certified.

Pace (round 6): the whole video stays in the pharmacist's view (j.rivera, signed in once, off camera). The other roles are
mentioned in narration only. Eight scenes, about 20 seconds each. Inside a scene the cursor glides about 700 ms and each
click is followed by at least 1.2 s before the next action. No scene is sped up beyond 1.25x.

Story balance: modernization first, AI agents next, the recall as one example of the gap legacy systems leave.

## 1. Modernization <!-- id: hook -->

**Screen:** Today, pharmacist view.

> A: Most pharmacies still run on fax machines, phone calls, paper logs, and systems that don't talk to each other. The lot, the patient, and the prescription live in three different places.
> A: Chimera Rx shows what a modern pharmacy looks like: one connected ledger, from the dock to the pickup counter, with every step on the record.
> B: We stay in the pharmacist's view. Today shows their own work: deliveries to check in, stock to watch, and suggestions from the AI agents, all in one place.

## 2. Receiving <!-- id: receiving -->

**Screen:** Receiving, one scan, lot captured, put-away.

> B: Receiving starts at the dock. One scan with the camera reads the lot, serial, and expiry from the label, with no typing and no paper log.
> B: Four checks run: the invoice, the paperwork, the expiry, and the recall list. The lot is captured, and put-away is recorded.

## 3. Fill and pickup <!-- id: fill -->

**Screen:** one order with the Rx Guardian suggestion and its evidence, then accept.

> B: At the counter, Rx Guardian reviews an order the moment it arrives. It shows what it found, and the evidence from the patient's own history, so nothing is a guess.
> B: Accept the suggestion, and the order goes on hold with the reason recorded in the audit log. The pharmacist always decides.

## 4. AI agents <!-- id: agents -->

**Screen:** AI agents page, Rx Guardian Run now, providers.

> A: Now the AI agents. Eight of them work in the background, and every one follows one rule: rules decide, the model explains, a gate checks the model, and a pharmacist decides.
> B: Rx Guardian works on its own, even when nobody is looking. Run it now, and it flags what a busy pharmacist could miss. It never changes an order itself.
> B: Pick any provider: Bedrock, Anthropic, an OpenAI-compatible endpoint, or a local model. Patient names and birth dates stay out of the prompts, and every run is logged.

## 5. The gap a recall exposes <!-- id: recalls -->

**Screen:** Recalls: one lookup, units and patients affected, messages, attestation, sandbox outbox.

> A: Here is the gap old systems leave. When a recall arrives, nobody knows which patients got which lot, so you either warn everyone, or you warn no one at all.
> B: Connected, one lookup finds the recall. The pharmacist confirms each lot, and the screen shows the units and the patients affected.
> B: Messages are drafted for exactly those patients, and no one else. The pharmacist attests, and only then do they reach the sandbox outbox.

## 6. Open and connected <!-- id: integrations -->

**Screen:** Integrations: partners, MCP server, then the placeholder list as a lower-third.

> A: Everything speaks open standards. Partners connect through a REST API, an MCP server, FHIR behind OAuth, and signed webhooks, and every call is checked against its scopes and written to the audit log.
> A: The real-world connections, like text, email, phone, wholesaler, e-prescribing, the health record, payer, and single sign-on, are designed seams, sandboxed today, so nothing reaches a real person while you evaluate it.

## 7. Roles and security <!-- id: security -->

**Screen:** Today (pharmacist still signed in) with a lower-third listing the four roles, then the audit chain.

> A: Roles are enforced on the server. A cashier only sees pickup and the register, never allergies or recalls. An admin only manages partner access, nothing clinical.
> A: Security is built in. PHI fields are encrypted, and the audit log is hash-chained, so any tampering shows up. These are HIPAA-style safeguards, not certified.

## 8. Built with Kiro <!-- id: kiro -->

**Screen:** animated Kiro card, then the end card (name, repository and site only).

> A: Built with Kiro. Specs carry requirement IDs, steering holds the safety rules, and hooks run a PHI guard on save. A custom agent and a Kiro Crew team did the work, with a human at every gate.
> A: Chimera Rx. github dot com slash P J Borad slash Chimera R X. ||| Chimera Rx. github.com/pjborad/Chimera-Rx. pjborad.github.io/Chimera-Rx.
