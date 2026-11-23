import type { Actor } from "./core";

/**
 * The route authorization matrix: one table, one source of truth (docs/SECURITY.md, "Read authorization matrix").
 *
 * Every route the API registers must have a row here. The `preHandler` in app.ts looks the row up by method and route pattern and
 * answers 401 (no session, handled before this table), 403 (role not listed) or 403 `route_unlisted` (no row at all: default deny).
 * A handler may still be stricter than its row (for example `only(req, "pharmacist")` inside a handler); it never gets looser.
 *
 * Product table (.kiro/steering/product.md): the cashier sees pickup only (no allergies, no date of birth, no clinical history),
 * the admin sees integrations only, the technician sees what the table allows, the pharmacist sees everything except integrations admin.
 */
export type Role = Actor["role"];
export type Rule = readonly Role[] | "public" | "partner" | "static";

const P = "pharmacist", T = "technician", C = "cashier", A = "admin";
/** Pharmacist only. */
const PH: Rule = [P];
/** Pharmacist and technician: anything that carries patient-linked or clinical data. */
const ST: Rule = [P, T];
/** Floor roles: pharmacist, technician, cashier. Stock, delivery and pickup data with no patient-linked clinical content. */
const FLOOR: Rule = [P, T, C];

/** "METHOD /route/pattern" (Fastify's own pattern, e.g. `/api/recalls/:id`) -> who may call it. */
export const ACCESS: Record<string, Rule> = {
  // ---- open on purpose (the session hook skips these); each has a reason
  "GET /api/health": "public",                // liveness probe: date and notifier name only
  "GET /api/auth/config": "public",           // the sign-in screen needs the demo flag before anyone signs in
  "POST /api/auth/login": "public",           // creates the session
  "POST /api/auth/verify": "public",          // second step of sign-in
  "POST /api/auth/sso": "public",             // sign-in
  "POST /api/auth/logout": "public",          // clearing a cookie leaks nothing
  "GET /api/auth/demo-code/:challenge": "public", // demo-mode only code hint, challenge-bound
  // ---- surfaces with their own authentication, checked in partner-api.ts (OAuth bearer + scopes), never a session
  "POST /oauth/token": "partner", "GET /v1/availability": "partner", "GET /v1/inventory": "partner", "GET /v1/recalls/:fda/status": "partner",
  "GET /v1/recalled-lots": "partner", "GET /v1/rx/:rx/change-requests": "partner", "GET /v1/change-requests": "partner",
  "POST /v1/change-requests/:id/response": "partner", "GET /v1/patients/:id/medications": "partner", "POST /mcp": "partner", "GET /mcp": "partner",
  "GET /fhir/r4/metadata": "partner", "GET /fhir/r4/Medication": "partner", "GET /fhir/r4/Medication/:id": "partner",
  "GET /fhir/r4/MedicationDispense": "partner", "GET /fhir/r4/MedicationDispense/:id": "partner", "GET /fhir/r4/Patient/:id": "partner",
  "POST /hooks/sink/:webhookId": "partner",   // signature-verified webhook sink, no session
  "GET /fax/:file": "static",                 // synthetic fax images from the assets folder, no patient data

  // ---- any signed-in role
  "GET /api/me": [P, T, C, A],                // the caller's own user and store
  "GET /api/voice": [P, T, C, A],             // voice provider name only

  // ---- Today, search, register (cashier: pickup and register only)
  "GET /api/today": [P, T, C, A],             // counts and generic tasks; patient-naming Rx Watcher tasks are staff-only (today.ts)
  "GET /api/search": [P, T, C, A],            // lots; fill-queue rows only for non-admin (app.ts), the cashier already reads the fill queue
  "GET /api/register/items": [C, P],
  "GET /api/register/patients": [C, P],
  "GET /api/register/patients/:id": [C, P],
  "POST /api/register/sales": [C, P],

  // ---- receiving and inventory (no patient data)
  "GET /api/deliveries": FLOOR, "GET /api/deliveries/:id": FLOOR,
  "POST /api/deliveries/:id/scan": ST, "POST /api/packages/:id/putaway": ST, "POST /api/packages/:id/problem": ST,
  "GET /api/lots": FLOOR, "GET /api/lots/:id": FLOOR, "POST /api/lots/:id/move": ST, "POST /api/lots/:id/adjust": ST,
  "GET /api/demo/labels": FLOOR, "POST /api/ocr/parse": FLOOR,
  "GET /api/stores": PH, "POST /api/transfers": PH,

  // ---- fill and pickup
  "GET /api/rx": FLOOR,                       // the cashier gets the pickup columns only (fill.ts)
  "GET /api/rx/:rx": FLOOR,                   // allergies, DOB and history are withheld from the cashier inside rxDetail
  "GET /api/rx/:rx/review": ST, "POST /api/rx/:rx/review": ST, "GET /api/rx/:rx/change-draft": PH, "POST /api/rx/:rx/decision": PH,
  "GET /api/prescriber-messages": ST, "POST /api/prescriber-messages/:id/respond": PH,
  "POST /api/rx/:rx/scan": ST, "POST /api/dispenses/:id/label": ST, "POST /api/dispenses/:id/verify": PH,
  "POST /api/dispenses/:id/sendback": PH, "POST /api/dispenses/:id/sell": [C, P],

  // ---- patients and refills
  "GET /api/patients": ST, "GET /api/patients/:id": ST, "POST /api/patients/:id/refill-sync": PH,
  "GET /api/refills": ST, "GET /api/refills/drafts": ST, "POST /api/refills/draft": ST, "POST /api/refills/send": PH,

  // ---- recalls: patient-linked impact, results and messages are pharmacist and technician (reads); actions are pharmacist
  "GET /api/recalls": ST, "GET /api/recalls/:id": ST, "GET /api/recalls/:id/results": ST, "GET /api/recalls/:id/messages": ST,
  "GET /api/fax": ST, "GET /api/audio/:id": ST, "GET /api/outbox": ST,
  "POST /api/recalls/lookup": PH, "POST /api/recalls/:id/confirm-lot": PH, "POST /api/recalls/:id/preview": ST,
  "POST /api/recalls/:id/notifications": PH, "GET /api/recalls/:id/voicemail": PH, "POST /api/recalls/:id/voicemail/preview": PH,
  "POST /api/recalls/:id/voicemail": PH, "GET /api/recalls/:id/calls": PH, "POST /api/outreach/run": PH,
  "POST /api/recalls/:id/return-pickup": PH, "POST /api/recalls/:id/manufacturer-response": PH, "POST /api/recalls/:id/close": PH,
  "GET /api/recalls/:id/report.pdf": PH, "GET /api/recalls/:id/trace-export": PH, "POST /api/night-watch/run": PH,
  "POST /api/calls/inbound": FLOOR,          // front desk takes callbacks; answers with id, name and recall id only
  "POST /api/sms/inbound": [P, T, C, A],     // simulated patient STOP reply; answers with a handled flag and the patient id only

  // ---- DSCSA and EPCIS
  "GET /api/epcis/export": ST, "POST /api/epcis/import": ST, "GET /api/epcis/imports": ST,
  "POST /api/dscsa/verify": ST, "GET /api/dscsa/verifications": ST, "GET /api/dscsa/cases": ST, "GET /api/dscsa/cases/:id": ST,
  "POST /api/dscsa/cases": PH, "POST /api/dscsa/cases/:id/quarantine": PH, "POST /api/dscsa/cases/:id/close": PH,

  // ---- stock help
  "GET /api/stock-help": ST, "POST /api/stock-help/decision": PH,

  // ---- AI agents. Run history, per-agent records and Rx Guardian suggestions hold patient ids and clinical findings: pharmacist and technician.
  "GET /api/agents": [P, T, C, A],            // agent names and what the caller may run, no run data; the admin configures the provider
  "GET /api/agents/provider": [P, T, A], "POST /api/agents/provider": [P, A], "POST /api/agents/provider/test": [P, A],
  "GET /api/agents/runs": ST, "GET /api/agents/drafts": PH, "GET /api/agents/:id": ST,
  "POST /api/agents/:id/run": [P, T, A],      // handler narrows it to the roles the agent lists
  "POST /api/agents/:id/enable": [P, A], "POST /api/agents/:id/disable": [P, A], "POST /api/agents/:id/run-now": PH,
  "GET /api/suggestions": ST, "POST /api/suggestions/:id/accept": PH, "POST /api/suggestions/:id/dismiss": PH, "POST /api/suggestions/:id/change-request": PH,

  // ---- integrations and audit (admin changes; the pharmacist can look)
  "GET /api/integrations": [A, P], "POST /api/integrations": [A], "POST /api/integrations/:id": [A],
  "POST /api/integrations/:id/rotate": [A], "POST /api/integrations/:id/webhooks": [A],
  "GET /api/audit": [P, A], "GET /api/audit/verify": [P, A], "GET /api/audit/export": [A],

  // ---- demo tools
  "GET /api/demo/scenarios": ST, "POST /api/demo/scenarios/:id": PH, "POST /api/demo/reset": PH
};

export function ruleFor(method: string, pattern: string | undefined): Rule | undefined {
  return pattern ? ACCESS[`${method.toUpperCase()} ${pattern}`] : undefined;
}

/** Who a row lets in, or null for a row that is not session-based (public, partner, static). */
export function rolesOf(rule: Rule | undefined): readonly Role[] | null {
  return Array.isArray(rule) ? (rule as readonly Role[]) : null;
}
