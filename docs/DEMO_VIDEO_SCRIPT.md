# Submission video script (under 3:00)

The spoken script for `demo-video/chimera-rx-submission.mp4`. Every line that starts with `>` is one narration unit. The
voice is Kokoro (male, `am_michael`), generated first; the screen recording is then fitted to the measured audio length.
Rebuild with `pnpm demo:record:submission`. Synthetic data only; HIPAA-style safeguards, not certified.

## 1. The problem <!-- id: hook -->

**Screen:** sign-in page, then the pharmacist signs in.

> A recall hits your pharmacy. Which patients received that lot? Today, in most pharmacies, nobody knows for sure. Someone searches paper logs, and hopes.
> Chimera Rx captures the lot at receiving, and again at fill, so the answer is already there when the recall arrives.
> Everything you will see runs on synthetic data, in a real browser, against the real application.

## 2. Roles <!-- id: roles -->

**Screen:** technician receiving, pharmacist fill with suggestions, cashier register, admin integrations.

> Each role sees a different pharmacy. The technician receives a delivery: scan the GS1 DataMatrix, and the lot gate checks the transaction information and statement. The expiry and the recall list are checked too. Then the stock is shelved, in the aisle and bay the app suggests.
> The pharmacist fills and verifies. Rx Watcher and Rx Guardian raise suggestions, each with its evidence. Accept one, and the order goes on hold until the pharmacist decides.
> The cashier does pickup and the front store register, but cannot see allergies, birth dates or recalls. The menu is short on purpose.
> The admin manages partner access only, in Integrations, and cannot see patients at all.

## 3. A recall, end to end <!-- id: recall -->

**Screen:** Recalls: fax OCR, lots, confirm, quarantine, patients, messages, outbox.

> Now a recall. A fax arrives, OCR reads it, and the Coroner agent extracts the lots. A verbatim gate drops any lot that is not printed on the page.
> The pharmacist confirms each lot. Stock moves to quarantine, and the exact patients appear, matched by the lot recorded at fill.
> The messages are drafted by AI, and the pharmacist attests before anything is sent. They land in the sandbox outbox. The voicemail is rendered, never dialed. Refills for those lots are blocked, so a recalled lot cannot go out the door again.

## 4. Agents <!-- id: agents -->

**Screen:** AI agents page, provider selector, Rx Guardian Run now.

> Agents work in the background, and every one follows the same rule. Rules decide, the model explains, a gate checks the model, and a pharmacist decides.
> Providers are pluggable: Bedrock, Anthropic, any OpenAI-compatible endpoint, or a local model. Run Rx Guardian now, and new suggestions appear for the pharmacist, with the history behind each one.

## 5. Integrations and placeholders <!-- id: integrations -->

**Screen:** Integrations (admin), then the placeholder list as a caption.

> Partners connect through REST, an MCP server, FHIR behind OAuth, signed webhooks, and DSCSA and EPCIS exports. Two stores can transfer stock between them, and both audit logs record the move.
> Everything real is a designed seam: SMS, email, phone calls, wholesaler EDI, DSCSA verification, e-prescribing, the dispensing system, the EHR over FHIR, payer, secrets manager, KMS, and single sign-on. They are sandboxed today, and nothing reaches a real person.

## 6. Security <!-- id: security -->

**Screen:** audit chain.

> PHI fields are encrypted. Roles are checked on the server, not just hidden in the screen. The audit log is hash-chained, so an edit shows. An independent review found eight issues, and all eight are fixed. These are HIPAA-style safeguards, not certified.

## 7. Built with Kiro <!-- id: kiro -->

**Screen:** end card.

> Built with Kiro. Specs carry requirement IDs, steering holds the safety rules, and hooks run a PHI guard and property tests on save. A custom agent, and a Kiro Crew team of agents, did the work, with a human reviewing every gate.
> Chimera Rx. github dot com slash P J Borad slash Chimera R X. Synthetic data only. ||| Chimera Rx. github.com/pjborad/Chimera-Rx. Synthetic data only.
