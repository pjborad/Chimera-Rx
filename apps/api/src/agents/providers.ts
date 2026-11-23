import { loadBedrockSdk, type LlmClient } from "@chimera-rx/coroner";
import { assertDestination, type LookupFn } from "./destination";

/**
 * Provider registry for the AI agents. One interface (`ProviderClient`), five providers:
 *   bedrock (default, Converse API) · anthropic · openai-compatible (OpenAI, Azure OpenAI, Ollama, LM Studio, vLLM) · mock · none
 * A provider turns (system, user) into text. Nothing here knows about pharmacy rules; the gates live in the agents.
 *
 * Keys: read from the environment at start-up, or pasted in the UI. A key lives in this process's memory only. It is
 * never written to disk, never logged, and never returned: the API shows the last four characters.
 */

export type ProviderId = "bedrock" | "anthropic" | "openai-compatible" | "mock" | "none";
export const PROVIDER_IDS: ProviderId[] = ["bedrock", "anthropic", "openai-compatible", "mock", "none"];

export interface ProviderClient extends LlmClient {
  readonly id: ProviderId;
  readonly model: string;
}

export interface ProviderSettings {
  provider: ProviderId;
  model: string;
  region: string;
  baseUrl: string;
}

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  bedrock: "us.anthropic.claude-sonnet-5",
  anthropic: "claude-3-5-haiku-latest",
  "openai-compatible": "gpt-4o-mini",
  mock: "mock-1",
  none: ""
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  bedrock: "Amazon Bedrock (default)",
  anthropic: "Anthropic API",
  "openai-compatible": "OpenAI-compatible (OpenAI, Azure OpenAI, Ollama, LM Studio, vLLM)",
  mock: "Mock (offline, deterministic, no key)",
  none: "None (rules only)"
};

const TIMEOUT_MS = 30_000;

// ------------------------------------------------------------------ the adapters

/** Minimal shape of the Bedrock runtime SDK that we use, so tests can stub it. */
export interface BedrockSdk {
  BedrockRuntimeClient: new (cfg: { region: string }) => { send(cmd: unknown, opts?: { abortSignal?: AbortSignal }): Promise<any> };
  ConverseCommand: new (input: any) => unknown;
}

export class BedrockProvider implements ProviderClient {
  readonly id = "bedrock" as const;
  readonly name = "bedrock";
  private client: { send(cmd: unknown, opts?: { abortSignal?: AbortSignal }): Promise<any> } | null = null;
  constructor(readonly region: string, readonly model: string, private sdk: () => Promise<BedrockSdk> = loadBedrockSdk as unknown as () => Promise<BedrockSdk>) {}
  async complete(system: string, user: string): Promise<string> {
    const sdk = await this.sdk();
    // The default AWS credential chain (env, AWS_PROFILE, SSO, container or instance role) is resolved by the SDK itself.
    this.client ??= new sdk.BedrockRuntimeClient({ region: this.region });
    const send = (inferenceConfig: Record<string, number>) => this.client!.send(new sdk.ConverseCommand({
      modelId: this.model,
      system: [{ text: system }],
      messages: [{ role: "user", content: [{ text: user }] }],
      inferenceConfig
    }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
    let out;
    try { out = await send({ temperature: 0, maxTokens: 1024 }); }
    catch (e) {
      // Newer models reject `temperature`; ask again without it. Any other error is passed up unchanged.
      if (!/temperature/i.test(String((e as Error)?.message))) throw e;
      out = await send({ maxTokens: 1024 });
    }
    return ((out?.output?.message?.content ?? []) as { text?: string }[]).map((c) => c.text ?? "").join("");
  }
}

export class AnthropicProvider implements ProviderClient {
  readonly id = "anthropic" as const;
  readonly name = "anthropic";
  constructor(private apiKey: string, readonly model: string, private fetchFn: typeof fetch = fetch) {}
  async complete(system: string, user: string): Promise<string> {
    const res = await this.fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: this.model, max_tokens: 1024, temperature: 0, system, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`anthropic returned HTTP ${res.status}`);
    const j = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (j.content ?? []).map((c) => c.text ?? "").join("");
  }
}

/** One adapter for every server that speaks the OpenAI chat-completions protocol. */
export class OpenAiCompatibleProvider implements ProviderClient {
  readonly id = "openai-compatible" as const;
  readonly name = "openai-compatible";
  constructor(private baseUrl: string, private apiKey: string, readonly model: string, private fetchFn: typeof fetch = fetch, private lookup?: LookupFn) {}
  async complete(system: string, user: string): Promise<string> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    // Destination policy again, right before the request (the saved URL may predate the policy or come from OPENAI_BASE_URL).
    // A refused destination gets no request and never sees the key.
    try { await assertDestination(url, this.lookup); } catch (e) { throw new Error(`openai-compatible base URL refused: ${(e as Error).message}`); }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) { headers.authorization = `Bearer ${this.apiKey}`; headers["api-key"] = this.apiKey; } // "api-key" is what Azure OpenAI reads
    const res = await this.fetchFn(url, {
      method: "POST", headers,
      body: JSON.stringify({ model: this.model, temperature: 0, max_tokens: 1024, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      redirect: "error", // a redirect could point at a blocked address after the check; never follow one
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`openai-compatible server returned HTTP ${res.status}`);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? "";
  }
}

// ------------------------------------------------------------------ the mock provider

/**
 * Deterministic and offline. It reads the agent marker on the first line of the system prompt ("AGENT:<id>") and the JSON in the
 * user prompt, and answers the way a careful model would. It is what the demo and the tests run on when no key is set.
 */
export class MockProvider implements ProviderClient {
  readonly id = "mock" as const;
  readonly name = "mock";
  readonly model = "mock-1";
  async complete(system: string, user: string): Promise<string> {
    const agent = /^AGENT:([\w-]+)/m.exec(system)?.[1] ?? legacyAgent(system);
    const data = safeJson(user);
    switch (agent) {
      case "coroner": return mockCoroner(data);
      case "rx-explainer": return mockRx(data);
      case "outreach-drafter": return mockOutreach();
      case "refill-outreach": return mockRefill();
      case "night-watch": return mockNightWatch(data);
      case "stock-advisor": return mockStock(data);
      case "copilot": return mockCopilot(data);
      case "rx-guardian": return mockGuardian(user);
      case "stock-line": return `${String(user).split(". ")[0]!.slice(0, 200)}. Check it against what is on the shelf.`;
      default: return "OK";
    }
  }
}

const legacyAgent = (system: string) =>
  /Coroner/.test(system) ? "coroner" : /Rx Watcher/.test(system) ? "rx-explainer" : /stock suggestions/.test(system) ? "stock-line" : "";

function safeJson(s: string): any {
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return {};
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return {}; }
}

/** The mock Guardian explains each hit from its own facts (no new numbers) and adds no note. */
function mockGuardian(user: string): string {
  let hits: { id: string; rule: string; severity: string; facts: string[] }[] = [];
  try { hits = JSON.parse(/<hits>([\s\S]*?)<\/hits>/.exec(user)?.[1] ?? "[]"); } catch { hits = []; }
  return JSON.stringify({
    explanations: hits.map((h) => ({ id: h.id, text: `${h.rule.replace(/-/g, " ")}: ${(h.facts ?? []).slice(0, 2).join(" ")}`.slice(0, 500) })),
    note: null
  });
}

function mockCoroner(d: any): string {
  const regexLots: { value: string; expiry?: string; confidence: number }[] = d?.regex_result?.lots ?? [];
  const ndcs: { value: string }[] = d?.regex_result?.ndcs ?? [];
  return JSON.stringify({
    ndcs: ndcs.map((n) => n.value),
    lots: regexLots.map((l) => ({ value: l.value, expiry: l.expiry ?? null, confidence: Math.max(0.9, l.confidence) })),
    notes: regexLots.length > 1 ? "Several lots are listed; check each one against the printed notice." : ""
  });
}

function mockRx(d: any): string {
  const f: { rule: string; severity: string; title: string }[] = d?.rule_findings ?? [];
  const flagged = f.filter((x) => x.severity === "needs_review" || x.severity === "block");
  const summary = flagged.length
    ? `${flagged.length} check${flagged.length === 1 ? "" : "s"} need a pharmacist: ${flagged.map((x) => x.title.toLowerCase()).join("; ")}.`
    : "The rules found nothing that needs review. A pharmacist still verifies the fill.";
  return JSON.stringify({ summary, possible: [] });
}

function mockOutreach(): string {
  return JSON.stringify({
    sms: "Elm Street Pharmacy: Hi {first_name}, a medicine you picked up on {sold_date} is part of a safety recall. Please don't use it. Call {pharmacy_phone} for a free replacement. Reply STOP to opt out.",
    emailSubject: "Important: please call us about your recent pickup",
    emailBody: "Dear {first_name},\n\nOn {sold_date} you picked up a medicine from Elm Street Pharmacy that the maker has recalled. Please do not use any remaining doses. Call us at {pharmacy_phone} or visit the pharmacy and we will replace it at no cost.\n\nYour pharmacist",
    voicemail: "Hello {first_name}. This is your pharmacist at Elm Street Pharmacy. I'm calling about something you picked up from us on {sold_date}. It's important, but it is not an emergency. Please call us back at {pharmacy_phone} so we can talk it over and take care of it for you at no cost. Again, that number is {pharmacy_phone}. Thank you."
  });
}

function mockRefill(): string {
  return JSON.stringify({
    sms: "Elm Street Pharmacy: Hi {first_name}, it is almost time for your next refill. Call {pharmacy_phone} and we will get it ready for you. Reply STOP to opt out.",
    emailSubject: "A friendly reminder about your refill",
    emailBody: "Dear {first_name},\n\nYour {drug_name} is ready to be refilled. Call us at {pharmacy_phone} or stop by and we will have it waiting for you.\n\nYour pharmacy team at Elm Street Pharmacy",
    voicemail: "Hello {first_name}. This is {pharmacist} at Elm Street Pharmacy. We have a refill waiting to be arranged for you. It is not an emergency. Please call us back at {pharmacy_phone} when you can. Again, that number is {pharmacy_phone}. Thank you."
  });
}

function mockNightWatch(d: any): string {
  const c = d?.counts ?? {};
  const parts = [
    `${c.newRecalls ?? 0} open recall${c.newRecalls === 1 ? "" : "s"} with lots on the shelf or sold`,
    `${c.shortages ?? 0} shortage${c.shortages === 1 ? "" : "s"} on products you stock`,
    `${c.expiringLots ?? 0} lot${c.expiringLots === 1 ? "" : "s"} at risk of expiring unused`,
    `${c.heldOrders ?? 0} order${c.heldOrders === 1 ? "" : "s"} held for review`
  ];
  return JSON.stringify({ summary: `Overnight: ${parts.join(", ")}. Nothing was confirmed or sent; a pharmacist decides each item.` });
}

function mockStock(d: any): string {
  const items: { key: string; reason: string }[] = d?.items ?? [];
  return JSON.stringify({ explanations: items.map((i) => ({ key: i.key, text: `${i.reason.split(";")[0]}. Worth a look today.`.replace(/\.\./g, ".") })) });
}

/** The mock copilot picks one read-only tool from the question words, then answers from the tool result. */
function mockCopilot(d: any): string {
  const results: { tool: string; result: unknown }[] = d?.tool_results ?? [];
  const q = String(d?.question ?? "");
  if (!results.length) {
    const lot = /\b(?=[A-Z0-9-]*\d)[A-Z][A-Z0-9-]{4,}\b/.exec(q.toUpperCase().replace(/[^A-Z0-9\s-]/g, " "))?.[0];
    if (/who|patient/i.test(q) && lot) return JSON.stringify({ tool: "patients_for_lot", args: { lot } });
    if (/shelf|on hand|how many|units/i.test(q)) return JSON.stringify({ tool: "units_on_shelf", args: { query: q.replace(/[^\w\s-]/g, " ").replace(/\b(how|many|units|are|on|the|shelf|do|we|have|of|in|stock|is|there)\b/gi, "").trim() || q } });
    if (/recall/i.test(q) && !lot) return JSON.stringify({ tool: "open_recalls", args: {} });
    if (lot) return JSON.stringify({ tool: "lot_lookup", args: { lot } });
    return JSON.stringify({ tool: "open_recalls", args: {} });
  }
  const r = results[results.length - 1]!;
  const x = r.result as any;
  const answer = r.tool === "patients_for_lot" ? (x.count ? `${x.count} patient${x.count === 1 ? "" : "s"} received lot ${x.lot}: ${x.patientIds.join(", ")}.` : `No patient has been sold lot ${x.lot}.`)
    : r.tool === "units_on_shelf" ? ((x.products ?? []).map((p: any) => `${p.product}: ${p.unitsOnShelf} on the shelf.`).join(" ") || "No product matched.")
    : r.tool === "lot_lookup" ? ((x.lots ?? []).map((l: any) => `Lot ${l.lot} of ${l.product}: expires ${l.expiry}, status ${l.status}, ${l.unitsOnShelf} on the shelf, ${l.unitsQuarantined} quarantined.`).join(" ") || "No lot with that number is in the ledger.")
    : r.tool === "open_recalls" ? ((x.recalls ?? []).length ? `Open recalls: ${x.recalls.map((c: any) => `${c.id} (${c.product}, ${c.lotsAwaitingConfirmation} lot${c.lotsAwaitingConfirmation === 1 ? "" : "s"} awaiting confirmation)`).join("; ")}.` : "No open recalls.")
    : (x?.error ? String(x.error) : "Done.");
  return JSON.stringify({ answer });
}

// ------------------------------------------------------------------ the runtime

export interface RuntimeDeps { fetch?: typeof fetch; bedrockSdk?: () => Promise<BedrockSdk>; now?: () => number; lookup?: LookupFn }

export interface PublicSettings {
  provider: ProviderId;
  providerLabel: string;
  model: string;
  region: string;
  baseUrl: string;
  keySet: boolean;
  /** last four characters only, e.g. "…a1b2" */
  keyHint: string | null;
  keySource: "environment" | "pasted in the UI (memory only)" | "none";
  credentials: string;
  providers: { id: ProviderId; label: string; defaultModel: string; needsKey: boolean }[];
  unavailableUntil: number | null;
}

/**
 * The live provider choice. Defaults to Bedrock. A judge can switch provider and model, and paste a key, at run time.
 * After a failed call the provider is marked unavailable for a minute so agents fall back to "rules only" quickly.
 */
export class AgentRuntime {
  private s: ProviderSettings;
  private keys = new Map<ProviderId, { key: string; source: "environment" | "ui" }>();
  private breaker: { until: number; reason: string } | null = null;
  constructor(env: Record<string, string | undefined> = process.env, private deps: RuntimeDeps = {}) {
    const raw = (env.LLM_PROVIDER ?? "").toLowerCase().trim();
    const provider: ProviderId = (PROVIDER_IDS as string[]).includes(raw) ? (raw as ProviderId) : "bedrock";
    const model = provider === "bedrock" ? env.BEDROCK_MODEL_ID : provider === "anthropic" ? env.ANTHROPIC_MODEL : provider === "openai-compatible" ? env.OPENAI_MODEL : "";
    this.s = {
      provider,
      model: model || DEFAULT_MODELS[provider],
      region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
      baseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1"
    };
    if (env.ANTHROPIC_API_KEY) this.keys.set("anthropic", { key: env.ANTHROPIC_API_KEY, source: "environment" });
    if (env.OPENAI_API_KEY) this.keys.set("openai-compatible", { key: env.OPENAI_API_KEY, source: "environment" });
    this.envModels = { anthropic: env.ANTHROPIC_MODEL, "openai-compatible": env.OPENAI_MODEL, bedrock: env.BEDROCK_MODEL_ID };
    this.profile = env.AWS_PROFILE || null;
    this.hasAwsEnv = !!(env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE || env.AWS_WEB_IDENTITY_TOKEN_FILE || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI);
  }
  private envModels: Record<string, string | undefined>;
  private profile: string | null;
  private hasAwsEnv: boolean;
  private now = () => (this.deps.now ?? Date.now)();

  get provider(): ProviderId { return this.s.provider; }
  get model(): string { return this.s.model; }

  /** Every secret this runtime holds, so error text can be scrubbed before it is stored or returned. */
  private secrets(): string[] { return [...this.keys.values()].map((k) => k.key).filter((k) => k.length >= 6); }
  scrubSecrets(text: string): string {
    let t = text;
    for (const k of this.secrets()) t = t.split(k).join("[key]");
    return t.replace(/(sk-|AKIA|ASIA|Bearer\s+)[A-Za-z0-9._\-]{8,}/g, "[key]");
  }

  settings(): PublicSettings {
    const k = this.keys.get(this.s.provider);
    const needsKey = (p: ProviderId) => p === "anthropic";
    return {
      provider: this.s.provider, providerLabel: PROVIDER_LABELS[this.s.provider], model: this.s.model, region: this.s.region, baseUrl: this.s.baseUrl,
      keySet: !!k, keyHint: k ? `…${k.key.slice(-4)}` : null, keySource: k ? (k.source === "environment" ? "environment" : "pasted in the UI (memory only)") : "none",
      credentials: this.s.provider === "bedrock"
        ? (this.hasAwsEnv ? `AWS credential chain${this.profile ? ` (profile ${this.profile})` : ""}` : "AWS default credential chain (no AWS_PROFILE or key variables set; SSO, shared config or a role may still apply)")
        : this.s.provider === "mock" ? "none needed" : this.s.provider === "none" ? "none needed" : k ? "API key set" : this.s.provider === "openai-compatible" ? "no key (fine for Ollama, LM Studio and vLLM)" : "API key missing",
      providers: PROVIDER_IDS.map((id) => ({ id, label: PROVIDER_LABELS[id], defaultModel: DEFAULT_MODELS[id], needsKey: needsKey(id) })),
      unavailableUntil: this.breaker && this.breaker.until > this.now() ? this.breaker.until : null
    };
  }

  /** Apply a change. Returns what changed, without the key. */
  update(patch: { provider?: ProviderId; model?: string; region?: string; baseUrl?: string; apiKey?: string }): { provider: ProviderId; model: string; keyChanged: boolean } {
    let keyChanged = false;
    if (patch.provider && patch.provider !== this.s.provider) {
      this.s.provider = patch.provider;
      this.s.model = this.envModels[patch.provider] || DEFAULT_MODELS[patch.provider];
    }
    if (patch.model !== undefined && patch.model.trim()) this.s.model = patch.model.trim();
    if (patch.region !== undefined && patch.region.trim()) this.s.region = patch.region.trim();
    if (patch.baseUrl !== undefined && patch.baseUrl.trim()) this.s.baseUrl = patch.baseUrl.trim();
    if (patch.apiKey !== undefined) {
      const target = this.s.provider;
      if (patch.apiKey.trim()) { this.keys.set(target, { key: patch.apiKey.trim(), source: "ui" }); keyChanged = true; }
      else if (this.keys.get(target)?.source === "ui") { this.keys.delete(target); keyChanged = true; }
    }
    this.breaker = null;
    return { provider: this.s.provider, model: this.s.model, keyChanged };
  }

  /** The active client, or null when the provider is "none" (rules only). */
  client(): ProviderClient | null {
    const raw = this.build();
    if (!raw) return null;
    return this.guard(raw);
  }

  private injected: ProviderClient | null | undefined;
  /** Test seam and embedding hook: answer every call with this client instead of the chosen provider (undefined = off). */
  inject(c: ProviderClient | null | undefined) { this.injected = c; this.breaker = null; }

  private build(): ProviderClient | null {
    if (this.injected !== undefined) return this.injected;
    const { provider, model, region, baseUrl } = this.s;
    switch (provider) {
      case "none": return null;
      case "mock": return new MockProvider();
      case "bedrock": return new BedrockProvider(region, model, this.deps.bedrockSdk);
      case "anthropic": {
        const k = this.keys.get("anthropic")?.key;
        if (!k) return new MissingKey("anthropic", model);
        return new AnthropicProvider(k, model, this.deps.fetch);
      }
      case "openai-compatible": return new OpenAiCompatibleProvider(baseUrl, this.keys.get("openai-compatible")?.key ?? "", model, this.deps.fetch, this.deps.lookup);
    }
  }

  /** Wrap a client: scrub secrets out of errors, and stop calling a provider that just failed for 60 seconds. */
  private guard(inner: ProviderClient): ProviderClient {
    const rt = this;
    return {
      id: inner.id, name: inner.name, model: inner.model,
      async complete(system: string, user: string) {
        const t = rt.now();
        if (rt.breaker && rt.breaker.until > t && inner.id !== "mock") throw new Error(`${inner.id} is unavailable right now (${rt.breaker.reason}). Retrying after a short pause.`);
        try {
          return await inner.complete(system, user);
        } catch (e) {
          const reason = rt.scrubSecrets(String((e as Error)?.message ?? e)).slice(0, 200);
          if (inner.id === "bedrock" || inner.id === "anthropic" || inner.id === "openai-compatible") rt.breaker = { until: rt.now() + 60_000, reason };
          throw new Error(reason);
        }
      }
    };
  }

  /** "Test connection": one tiny call, ignoring the unavailable pause. */
  async test(): Promise<{ ok: boolean; provider: ProviderId; model: string; latencyMs: number; message: string }> {
    const raw = this.build();
    const base = { provider: this.s.provider, model: this.s.model };
    if (!raw) return { ok: true, ...base, latencyMs: 0, message: "Provider is none: agents run on rules only." };
    const t0 = Date.now();
    try {
      const out = await raw.complete("AGENT:ping\nReply with the single word OK.", "ping");
      this.breaker = null;
      return { ok: true, ...base, latencyMs: Date.now() - t0, message: `Connected. Reply: ${this.scrubSecrets(out).trim().slice(0, 40) || "(empty)"}` };
    } catch (e) {
      const reason = this.scrubSecrets(String((e as Error)?.message ?? e)).slice(0, 200);
      return { ok: false, ...base, latencyMs: Date.now() - t0, message: `Could not connect: ${reason}` };
    }
  }

  /** The existing `ctx.llm` slot (Coroner at receiving, stock explanations) follows the same live choice. */
  asLlm(): LlmClient | null { return this.client(); }
}

class MissingKey implements ProviderClient {
  readonly name: string;
  constructor(readonly id: ProviderId, readonly model: string) { this.name = id; }
  async complete(): Promise<string> { throw new Error(`no API key set for ${this.id}`); }
}

// ------------------------------------------------------------------ helpers

const runtimes = new WeakMap<object, AgentRuntime>();
let shared: AgentRuntime | null = null;

/** The runtime attached to a ctx, else the process-wide one built from the environment. */
export function runtimeOf(ctx: { agents?: AgentRuntime }): AgentRuntime {
  if (ctx.agents) return ctx.agents;
  const hit = runtimes.get(ctx);
  if (hit) return hit;
  shared ??= new AgentRuntime(process.env);
  runtimes.set(ctx, shared);
  return shared;
}
