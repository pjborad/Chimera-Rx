/**
 * The seam where a real deployment would plug in outside connections (docs/INTEGRATION_PLACEHOLDERS.md).
 *
 * None is wired. Pharmacy-safety rule 2 stands: nothing reaches a real person, SMS and email go only to the sandbox
 * outbox, voicemail is rendered and never dialled. This file has no provider code, no SDK and no credentials. A
 * `NotConfiguredChannel` only names a placeholder and throws when anything tries to use it, so the gap is visible
 * in code and in tests instead of being silently skipped. Nothing in the app constructs one today.
 */

export type ExternalConnection =
  | "sms" | "email" | "voice-calls" | "wholesaler-feed" | "dscsa-verification" | "e-prescribing"
  | "pms" | "ehr-fhir" | "payer" | "secrets-manager" | "kms" | "identity-provider";

/** Env var names a real adapter would read. Placeholders only: the app never reads them. */
export const PLACEHOLDER_ENV: Record<ExternalConnection, string[]> = {
  sms: ["PLACEHOLDER_SMS_API_URL", "PLACEHOLDER_SMS_API_KEY", "PLACEHOLDER_SMS_FROM_NUMBER"],
  email: ["PLACEHOLDER_EMAIL_API_URL", "PLACEHOLDER_EMAIL_API_KEY", "PLACEHOLDER_EMAIL_FROM"],
  "voice-calls": ["PLACEHOLDER_VOICE_CALL_API_URL", "PLACEHOLDER_VOICE_CALL_API_KEY", "PLACEHOLDER_VOICE_CALLER_ID"],
  "wholesaler-feed": ["PLACEHOLDER_WHOLESALER_EDI_URL", "PLACEHOLDER_WHOLESALER_EPCIS_URL", "PLACEHOLDER_WHOLESALER_CLIENT_ID", "PLACEHOLDER_WHOLESALER_CLIENT_SECRET", "PLACEHOLDER_GLN"],
  "dscsa-verification": ["PLACEHOLDER_VRS_ROUTER_URL", "PLACEHOLDER_VRS_CLIENT_CERT", "PLACEHOLDER_VRS_CLIENT_KEY"],
  "e-prescribing": ["PLACEHOLDER_ERX_NETWORK_URL", "PLACEHOLDER_ERX_PHARMACY_NCPDP_ID", "PLACEHOLDER_ERX_CLIENT_CERT"],
  pms: ["PLACEHOLDER_PMS_API_URL", "PLACEHOLDER_PMS_CLIENT_ID", "PLACEHOLDER_PMS_CLIENT_SECRET"],
  "ehr-fhir": ["PLACEHOLDER_EHR_FHIR_BASE_URL", "PLACEHOLDER_EHR_CLIENT_ID", "PLACEHOLDER_EHR_PRIVATE_KEY"],
  payer: ["PLACEHOLDER_PAYER_SWITCH_URL", "PLACEHOLDER_PAYER_BIN", "PLACEHOLDER_PAYER_PCN", "PLACEHOLDER_PAYER_CLIENT_CERT"],
  "secrets-manager": ["PLACEHOLDER_SECRETS_MANAGER_URL", "PLACEHOLDER_SECRETS_PATH"],
  kms: ["PLACEHOLDER_KMS_KEY_ID", "PLACEHOLDER_KMS_REGION"],
  "identity-provider": ["PLACEHOLDER_OIDC_ISSUER_URL", "PLACEHOLDER_OIDC_CLIENT_ID", "PLACEHOLDER_OIDC_CLIENT_SECRET"]
};

export class NotConfiguredError extends Error {
  readonly code = "not_configured";
  constructor(readonly connection: ExternalConnection) {
    super(`${connection} is not configured in this demo. Chimera Rx uses its sandbox stand-in instead; see docs/INTEGRATION_PLACEHOLDERS.md.`);
  }
}

/** The shape a real adapter would fill in. Every method of the placeholder throws `NotConfiguredError`. */
export interface ExternalChannel {
  readonly connection: ExternalConnection;
  readonly configured: false;
  send(payload?: unknown): Promise<never>;
}

export class NotConfiguredChannel implements ExternalChannel {
  readonly configured = false as const;
  constructor(readonly connection: ExternalConnection) {}
  async send(_payload?: unknown): Promise<never> { throw new NotConfiguredError(this.connection); }
}
