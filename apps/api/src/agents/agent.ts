import { z } from "zod";
import { audit, HttpError, type Actor, type Ctx } from "../core";
import type { Role } from "../domain";
import { pharmacyProfile } from "../stores";
import { runtimeOf, type ProviderClient } from "./providers";

/**
 * The agent framework. Every agent has:
 *   1. a deterministic core that always runs and decides (rules, regex, SQL);
 *   2. an optional LLM advisory layer that may explain or add a lower-confidence note, never decide;
 *   3. a post-LLM gate that drops anything the rules or the source text do not back up.
 * Every run leaves a record: provider, model, de-identified input, raw output, gated output and what the gate dropped.
 * AI output is advisory and labelled so. A pharmacist decides and sends.
 */

export const ADVISORY_LABEL = "AI advisory, a pharmacist decides";
export const MAX_RECORDS = 300;

export interface Dropped { what: string; why: string }

export interface AgentRunRecord {
  id: number;
  agentId: string;
  provider: string;
  model: string;
  startedAt: number;
  latencyMs: number;
  /** "ai" when the provider answered and the gate ran; "rules only" otherwise */
  mode: "ai" | "rules only";
  /** what was sent to the model: de-identified (patient ids only) */
  input: string;
  ruleOutput: unknown;
  rawOutput: string | null;
  gatedOutput: unknown;
  dropped: Dropped[];
  advisory: true;
  label: string;
  error: string | null;
  by: string;
}

export interface AgentResult {
  ruleOutput: unknown;
  gatedOutput: unknown;
  dropped: Dropped[];
  /** anything the screen needs but the stored record should not keep (e.g. per-patient drafts with first names) */
  extra?: Record<string, unknown>;
}

export interface AgentDef {
  id: string;
  name: string;
  purpose: string;
  roles: Role[];
  guardrails: string[];
  input: z.ZodTypeAny;
  sample(ctx: Ctx): Record<string, unknown>;
  run(ctx: Ctx, actor: Actor | null, input: any, llm: LlmCall): Promise<AgentResult>;
}

// ------------------------------------------------------------------ PHI handling

interface PatientRow { id: string; name: string; dob: string; phone: string; email: string }
/** the signed-in store's own phone (digits): the one number a draft may carry (REV-F06) */
const storeDigits = (ctx: Ctx) => { try { return pharmacyProfile(ctx).phone.replace(/\D/g, ""); } catch { return ""; } };

function patients(ctx: Ctx): PatientRow[] {
  try { return ctx.db.all<PatientRow>("SELECT id, name, dob, phone, email FROM patients"); } catch { return []; }
}
const digits = (s: string) => s.replace(/\D/g, "");

/** The prompts never carry the allergy list (it is not selected), so allergies are not matched here: a drug name may equal an allergy class. */
/** A US-style phone number that is not part of a longer run of digits (so an 11-digit NDC is not mistaken for one). */
const PHONE = /(?<![\d-])\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\d-])/g;
const phoneRe = (d: string) => new RegExp(`(?<!\\d)${d.split("").join("\\D?")}(?!\\d)`);

/** Returns a short description of the first piece of patient data found in `text`, or null. The text itself is never echoed. */
export function findPhi(ctx: Ctx, text: string): string | null {
  const low = text.toLowerCase();
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text)) return "an email address";
  const own = storeDigits(ctx);
  for (const m of text.matchAll(PHONE)) if (digits(m[0]) !== own) return "a phone number";
  const all = patients(ctx);
  for (const p of all) {
    const name = (p.name ?? "").trim();
    if (name.length > 3 && low.includes(name.toLowerCase())) return "a patient name";
    for (const part of name.split(/\s+/)) if (part.length >= 4 && new RegExp(`\\b${part.toLowerCase().replace(/[^a-z]/g, "")}\\b`).test(low)) return "a patient name";
    if (p.dob && text.includes(p.dob)) return "a date of birth";
    const pd = digits(p.phone ?? "");
    if (pd.length === 10 && pd !== own && phoneRe(pd).test(text)) return "a phone number";
  }
  return null;
}

/** Replace names, phones, emails and dates of birth in free text (a pharmacist's question, a directions line). */
export function deidentify(ctx: Ctx, text: string): string {
  let t = text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(PHONE, (m) => (digits(m) === storeDigits(ctx) ? m : "[phone]"));
  for (const p of patients(ctx)) {
    const name = (p.name ?? "").trim();
    if (name.length > 3) t = t.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), p.id);
    for (const part of name.split(/\s+/)) if (part.length >= 4) t = t.replace(new RegExp(`\\b${part.replace(/[^A-Za-z]/g, "")}\\b`, "gi"), p.id);
    if (p.dob) t = t.split(p.dob).join("[dob]");
  }
  return t;
}

/** Scrub phone numbers and emails out of text before it is stored in a run record. */
export const scrubContact = (s: string, ownDigits = "") => s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]").replace(PHONE, (m) => (ownDigits && digits(m) === ownDigits ? m : "[phone]"));

// ------------------------------------------------------------------ the LLM handle an agent gets

export class LlmCall {
  readonly prompts: string[] = [];
  readonly raws: string[] = [];
  error: string | null = null;
  constructor(private ctx: Ctx, readonly client: ProviderClient | null, readonly agentId: string) {}
  get available() { return !!this.client && !this.error; }
  /**
   * One model call. The prompt is checked for patient data first; a prompt that fails the check is never sent (fail closed).
   * Returns null on any failure, and records why. The caller then keeps the rule output.
   */
  async ask(system: string, user: string, opts: { publicSource?: boolean } = {}): Promise<string | null> {
    if (!this.client) return null;
    // A public source text (an FDA notice) cannot hold patient data, so the patient-data check is skipped for it.
    const leak = opts.publicSource ? null : findPhi(this.ctx, `${system}\n${user}`);
    if (leak) { this.error = `Prompt blocked: it contained ${leak}. Nothing was sent to the model.`; return null; }
    this.prompts.push(user);
    try {
      const raw = await this.client.complete(`AGENT:${this.agentId}\n${system}`, user);
      this.raws.push(raw);
      return raw;
    } catch (e) {
      this.error = String((e as Error).message ?? e).slice(0, 200);
      return null;
    }
  }
}

export function parseJsonObject(raw: string | null): any | null {
  if (!raw) return null;
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(raw.slice(a, b + 1)); } catch { return null; }
}

/** Every integer or decimal that appears in the text, as strings without thousands separators. */
export const numbersIn = (s: string): string[] => (s.replace(/(\d),(?=\d{3}\b)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []);

// ------------------------------------------------------------------ records

export function ensureTables(ctx: Ctx) {
  // `run` rather than a raw exec: in two-store mode ctx.db routes to the signed-in store's own database.
  ctx.db.run(`CREATE TABLE IF NOT EXISTS ai_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, provider TEXT, model TEXT, started_at INTEGER, latency_ms INTEGER, mode TEXT,
    input TEXT, rule_output TEXT, raw_output TEXT, gated_output TEXT, dropped TEXT, error TEXT, by_user TEXT
  )`);
  ctx.db.run(`CREATE TABLE IF NOT EXISTS ai_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, recall_id TEXT, patient_id TEXT, channel TEXT, subject TEXT, body TEXT,
    status TEXT DEFAULT 'draft', created_at INTEGER
  )`);
}

const rowToRecord = (r: any): AgentRunRecord => ({
  id: r.id, agentId: r.agent, provider: r.provider, model: r.model, startedAt: r.started_at, latencyMs: r.latency_ms, mode: r.mode,
  input: r.input, ruleOutput: JSON.parse(r.rule_output ?? "null"), rawOutput: r.raw_output, gatedOutput: JSON.parse(r.gated_output ?? "null"),
  dropped: JSON.parse(r.dropped ?? "[]"), advisory: true, label: ADVISORY_LABEL, error: r.error, by: r.by_user
});

export function listRuns(ctx: Ctx, agentId?: string, limit = 25): AgentRunRecord[] {
  ensureTables(ctx);
  const rows = agentId
    ? ctx.db.all<any>("SELECT * FROM ai_runs WHERE agent = ? ORDER BY id DESC LIMIT ?", agentId, limit)
    : ctx.db.all<any>("SELECT * FROM ai_runs ORDER BY id DESC LIMIT ?", limit);
  return rows.map(rowToRecord);
}

// ------------------------------------------------------------------ the registry and the runner

const AGENTS = new Map<string, AgentDef>();
export const registerAgent = (a: AgentDef) => { AGENTS.set(a.id, a); };
export const allAgents = () => [...AGENTS.values()];
export const getAgent = (id: string) => AGENTS.get(id);

export const canRun = (a: AgentDef, role: Role | undefined) => !!role && a.roles.includes(role);

export async function runAgent(ctx: Ctx, actor: Actor | null, agentId: string, rawInput: unknown): Promise<AgentRunRecord & { extra?: Record<string, unknown> }> {
  const agent = AGENTS.get(agentId);
  if (!agent) throw new HttpError(404, "Unknown agent.");
  if (actor && !canRun(agent, actor.role)) throw new HttpError(403, `A ${actor.role} cannot run ${agent.name}.`, "forbidden");
  const parsed = agent.input.safeParse(rawInput ?? {});
  if (!parsed.success) throw new HttpError(422, `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ").slice(0, 200)}`);
  ensureTables(ctx);

  const rt = runtimeOf(ctx);
  const client = rt.client();
  const llm = new LlmCall(ctx, client, agent.id);
  const t0 = Date.now();
  const startedAt = ctx.now();
  let result: AgentResult;
  try {
    result = await agent.run(ctx, actor, parsed.data, llm);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, `${agent.name} could not run.`);
  }
  const latencyMs = Date.now() - t0;
  const answered = llm.raws.length > 0;
  const rec = {
    provider: client?.id ?? "none", model: client?.model ?? "", mode: (answered ? "ai" : "rules only") as "ai" | "rules only",
    input: llm.prompts.join("\n---\n").slice(0, 6000),
    raw: answered ? scrubContact(rt.scrubSecrets(llm.raws.join("\n---\n")), storeDigits(ctx)).slice(0, 6000) : null,
    error: llm.error ? rt.scrubSecrets(llm.error) : null
  };
  const id = Number(ctx.db.run(
    "INSERT INTO ai_runs (agent, provider, model, started_at, latency_ms, mode, input, rule_output, raw_output, gated_output, dropped, error, by_user) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    agent.id, rec.provider, rec.model, startedAt, latencyMs, rec.mode, rec.input, JSON.stringify(result.ruleOutput), rec.raw, JSON.stringify(result.gatedOutput), JSON.stringify(result.dropped), rec.error, actor?.name ?? "system"
  ).lastInsertRowid);
  ctx.db.run("DELETE FROM ai_runs WHERE id <= (SELECT id FROM ai_runs ORDER BY id DESC LIMIT 1 OFFSET ?)", MAX_RECORDS);
  audit(ctx, actor, "agent.run", "agent", agent.id, undefined, { runId: id, provider: rec.provider, model: rec.model, mode: rec.mode, dropped: result.dropped.length });
  const record = rowToRecord(ctx.db.get<any>("SELECT * FROM ai_runs WHERE id = ?", id)!);
  return { ...record, extra: result.extra };
}

/** Sample input for the "try it" button. */
export function sampleFor(ctx: Ctx, agentId: string) { return getAgent(agentId)?.sample(ctx) ?? {}; }
