# Integration placeholders

**None of these connections is wired.** This page lists every outside connection a real deployment of Chimera Rx would need, and how the app would use each one. The repo contains no provider code, no SDK and no credentials for any of them.

Pharmacy-safety rule 2 still holds (`.kiro/steering/pharmacy-safety.md`): nothing reaches a real person. SMS and email go only to the sandbox outbox, and voicemail is rendered but never dialled. Built with HIPAA-style safeguards, not certified.

What exists in code:

- **The seam:** `apps/api/src/channels.ts`. `NotConfiguredChannel` throws "not configured in this demo" for any connection below, and `PLACEHOLDER_ENV` lists the env var names. Nothing in the app constructs a `NotConfiguredChannel` today.
- **The test:** `apps/api/test/channels.test.ts` checks that every placeholder throws. It also checks that every env var name is listed, commented out, in `.env.example` and on this page.
- **The env vars:** every `PLACEHOLDER_...` variable is commented out in `.env.example`, and the app never reads any of them.

The rules below apply to every row.

- **Minimum necessary:** a payload carries only the fields named in its row.
- **Pharmacist decision:** a pharmacist attests before anything goes to a patient or a prescriber, and consent is read again at send time (the same checks that run before the sandbox outbox today).
- **Audit:** every call goes into the hash-chained audit log. Partner-facing calls are also logged in `api_log`.

A real adapter also needs a signed agreement with the provider (for example a business associate agreement where patient data flows), a security review, and a clinical and legal sign-off. Those are outside this repo.

## Patient and prescriber messaging

### SMS (carrier or CPaaS API)

- **Purpose:** recall notices, refill reminders and MFA codes.
- **Triggered by:** a pharmacist pressing Send on Recalls or Refills, after the attestation. The Refill Outreach agent only drafts. MFA codes are sent when a user signs in with `MFA=1`.
- **Data allowed:** the patient's first name, the pharmacy name and phone, a pickup or sale date, and a STOP opt-out. Never another patient, a condition or an Rx number. Rule 9 applies.
- **Consent and attestation:** SMS consent and do-not-contact are checked at send time, and the pharmacist attestation is required. STOP replies are honoured (`POST /api/sms/inbound` is the sandbox stand-in).
- **Env:** `PLACEHOLDER_SMS_API_URL`, `PLACEHOLDER_SMS_API_KEY`, `PLACEHOLDER_SMS_FROM_NUMBER`.
- **Sandbox today:** `SandboxNotifier` in `apps/api/src/notify.ts` writes to the `outbox` table, and the Sandbox outbox screen shows it. Delivery receipts are simulated.

### Email (transactional email API)

- **Purpose:** the same notices as SMS, for patients who chose email.
- **Triggered by:** a pharmacist sending from Recalls or Refills, after the attestation.
- **Data allowed:** the same fields as SMS, plus a subject line that does not name the medicine.
- **Consent and attestation:** email consent is checked at send time, and the pharmacist attestation is required.
- **Env:** `PLACEHOLDER_EMAIL_API_URL`, `PLACEHOLDER_EMAIL_API_KEY`, `PLACEHOLDER_EMAIL_FROM`.
- **Sandbox today:** `SandboxNotifier` writes to the outbox and accepts every email.

### Outbound voice calls (telephony API)

- **Purpose:** recall voicemail for patients who agreed to voice contact.
- **Triggered by:** a pharmacist starting calls on Recalls, after the attestation. The outreach agent only retries inside the 9 AM to 8 PM calling window.
- **Data allowed:** the patient's first name, the pharmacy name and phone, and the pickup date. Never the medicine, the recall reason or a patient ID. `checkScript` in `apps/api/src/outreach.ts` refuses scripts that break this rule.
- **Consent and attestation:** voice consent and do-not-contact are checked, and the pharmacist attestation is required.
- **Audio:** rendered by the existing `VoiceProvider` (`apps/api/src/voice.ts`): local Kokoro (`VOICE_PROVIDER=kokoro`, loopback only), a provider's TTS, macOS speech or the browser. The telephony API would only play the rendered file.
- **Env:** `PLACEHOLDER_VOICE_CALL_API_URL`, `PLACEHOLDER_VOICE_CALL_API_KEY`, `PLACEHOLDER_VOICE_CALLER_ID`.
- **Sandbox today:** the audio is rendered and stored, and call outcomes (answered, voicemail, no answer, retry) are simulated. Nothing is dialled.

### E-prescribing network (NCPDP SCRIPT)

- **Purpose:** change requests to prescribers (RxChangeRequest) and their responses (RxChangeResponse).
- **Triggered by:** a pharmacist sending a change request from Fill & pickup, or accepting an Rx Guardian suggestion as a change request.
- **Data allowed:** what the SCRIPT message needs: patient demographics for matching, the prescription, the proposed change and the reason, sent to the prescriber of record only.
- **Consent and attestation:** pharmacist only. No patient consent is needed for treatment communication, but the reason is recorded.
- **Env:** `PLACEHOLDER_ERX_NETWORK_URL`, `PLACEHOLDER_ERX_PHARMACY_NCPDP_ID`, `PLACEHOLDER_ERX_CLIENT_CERT`.
- **Sandbox today:** `apps/api/src/prescriber.ts` stores SCRIPT-shaped messages in `prescriber_messages`. Responses come back through the sandbox route `POST /api/prescriber-messages/:id/respond` or the partner REST surface.

## Supply chain

### Wholesaler EDI and EPCIS feed

- **Purpose:** advance ship notices and invoices (EDI 856 and 810), and transaction information and statements for each delivery (EPCIS 2.0), so receiving can check them.
- **Triggered by:** the wholesaler pushing data, or a scheduled pull. Receiving checks run when a technician scans.
- **Data allowed:** product, lot, serial, expiry, quantities, the trading partners' GLNs and the invoice. No patient data.
- **Consent and attestation:** none from patients. Receiving a Schedule II order needs a witness.
- **Env:** `PLACEHOLDER_WHOLESALER_EDI_URL`, `PLACEHOLDER_WHOLESALER_EPCIS_URL`, `PLACEHOLDER_WHOLESALER_CLIENT_ID`, `PLACEHOLDER_WHOLESALER_CLIENT_SECRET`, `PLACEHOLDER_GLN`.
- **Sandbox today:** seeded deliveries and `ti_records` in `apps/api/src/seed.ts`, plus the EPCIS dry-run import on DSCSA & trace (`apps/api/src/epcis.ts`).

### DSCSA verification router

- **Purpose:** ask the manufacturer whether a product identifier is genuine (suspect-product checks, saleable returns).
- **Triggered by:** a technician or pharmacist pressing Verify on Receiving or on DSCSA & trace.
- **Data allowed:** GTIN, serial, lot and expiry. No patient data.
- **Consent and attestation:** none from patients. A pharmacist opens and closes suspect-product cases.
- **Env:** `PLACEHOLDER_VRS_ROUTER_URL`, `PLACEHOLDER_VRS_CLIENT_CERT`, `PLACEHOLDER_VRS_CLIENT_KEY`.
- **Sandbox today:** the sandbox verifier `verifyProduct` in `apps/api/src/epcis.ts` answers from `apps/api/fixtures/dscsa-verifier.json`, and every answer is labelled as a sandbox.

## Pharmacy and clinical systems

### Pharmacy management or dispensing system (PMS)

- **Purpose:** keep prescriptions, fills and patients in step with the dispensing system a pharmacy already runs, and have Chimera Rx add lot and serial to each fill.
- **Triggered by:** the PMS pushing new and changed prescriptions, and Chimera Rx posting the lot and serial back after a verified fill.
- **Data allowed:** the prescription and fill fields the PMS already holds, plus lot, serial and expiry.
- **Consent and attestation:** the pharmacist verifies each fill, as today.
- **Env:** `PLACEHOLDER_PMS_API_URL`, `PLACEHOLDER_PMS_CLIENT_ID`, `PLACEHOLDER_PMS_CLIENT_SECRET`.
- **Sandbox today:** Chimera Rx is its own ledger with synthetic prescriptions. Partners can read it through the scoped REST and MCP surfaces (`apps/api/src/partner-api.ts`).

### EHR via FHIR

- **Purpose:** let a clinic or hospital EHR see which lot a patient received, and pull medication lists for the Rx Guardian's history check.
- **Triggered by:** the EHR calling Chimera Rx's FHIR read API, or a pharmacist opening a patient (a future pull).
- **Data allowed:** `MedicationDispense` with lot, plus `Medication` and `Patient`. Patient data only goes to a partner with the `patient.read` scope and an admin-approved agreement flag.
- **Consent and attestation:** the admin approves the partner, and every read is logged in `api_log`.
- **Env:** `PLACEHOLDER_EHR_FHIR_BASE_URL`, `PLACEHOLDER_EHR_CLIENT_ID`, `PLACEHOLDER_EHR_PRIVATE_KEY`.
- **Sandbox today:** an inbound FHIR R4 read surface (`/fhir/r4/*`) with seeded synthetic partners. No outbound EHR connection.

### Payer (claims switch)

- **Purpose:** submit pharmacy claims and read the copay before pickup.
- **Triggered by:** a technician or pharmacist submitting a fill, and the cashier reading the copay on Register.
- **Data allowed:** the NCPDP telecommunication claim fields (member ID, BIN, PCN, group, product and quantity) and nothing beyond the claim.
- **Consent and attestation:** covered by the patient's insurance enrolment. The pharmacist handles rejections.
- **Env:** `PLACEHOLDER_PAYER_SWITCH_URL`, `PLACEHOLDER_PAYER_BIN`, `PLACEHOLDER_PAYER_PCN`, `PLACEHOLDER_PAYER_CLIENT_CERT`.
- **Sandbox today:** none. Register marks a sale "Paid" as a label, and no claim or payment is processed.

## Platform

### Secrets manager

- **Purpose:** hold API keys, client secrets and certificates for the connections above, instead of `.env`.
- **Triggered by:** API start-up and key rotation.
- **Data allowed:** credentials only. No patient data.
- **Consent and attestation:** an admin rotates credentials, and each rotation is audited.
- **Env:** `PLACEHOLDER_SECRETS_MANAGER_URL`, `PLACEHOLDER_SECRETS_PATH`.
- **Sandbox today:** `.env` and environment variables. Agent provider keys pasted on the AI agents screen stay in memory only.

### KMS for the data key

- **Purpose:** wrap the AES-256-GCM data key that seals patient fields, so the key never sits next to the database.
- **Triggered by:** API start-up (unwrap) and `keys:rotate`.
- **Data allowed:** the wrapped data key only.
- **Consent and attestation:** an admin runs rotation.
- **Env:** `PLACEHOLDER_KMS_KEY_ID`, `PLACEHOLDER_KMS_REGION`. When it is built, it would be selected with `KEY_PROVIDER=kms`.
- **Sandbox today:** `KEY_PROVIDER=env` or `file`. The `kms` provider in `apps/api/src/crypto.ts` is a placeholder that refuses to start. See `docs/SECURITY.md`.

### Identity provider and SSO (OIDC or SAML)

- **Purpose:** staff sign-in with the pharmacy's own accounts, MFA and offboarding.
- **Triggered by:** staff signing in.
- **Data allowed:** the staff member's subject ID, name, email and role or group claims. No patient data.
- **Consent and attestation:** an admin maps groups to the pharmacist, technician, cashier and admin roles.
- **Env:** `PLACEHOLDER_OIDC_ISSUER_URL`, `PLACEHOLDER_OIDC_CLIENT_ID`, `PLACEHOLDER_OIDC_CLIENT_SECRET`.
- **Sandbox today:** email and password for synthetic staff, an optional 6-digit second factor (`MFA=1`, code sent to the sandbox outbox), lockout and idle sign-out. There is no SSO button.
