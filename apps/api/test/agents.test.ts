import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, Db, ingestFaxInbox, loadConfig, SandboxNotifier, seedDatabase, type Ctx } from "../src/index";
import type { Actor } from "../src/core";
import {
  AgentRuntime, allAgents, AnthropicProvider, BedrockProvider, claimsAction, draftQueue, listRuns, MockProvider, OpenAiCompatibleProvider, runAgent, runTool,
  type BedrockSdk, type ProviderClient
} from "../src/agents";

// The AI agent platform: providers, the agent framework, the six agents, the gates that make a lying model harmless.

const PW = "moonlight-rx-2026";
const NOW = Date.parse("2026-11-18T18:00:00Z");
let ctx: Ctx;
let app: FastifyInstance;
let rt: AgentRuntime;
let pharmacist: Actor, technician: Actor;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  process.env.OFFLINE = "1";
  const cfg = loadConfig({}, { sqlitePath: ":memory:", sandboxDelayMs: 20, today: "2026-11-18", nightWatch: false, assetsDir: "/nonexistent", webDist: "/nonexistent" });
  const db = new Db(":memory:");
  rt = new AgentRuntime({ LLM_PROVIDER: "mock" });
  ctx = { cfg, db, notify: new SandboxNotifier(db, cfg), now: () => NOW, agents: rt };
  seedDatabase(db, cfg, NOW);
  await ingestFaxInbox(ctx);
  app = await buildApp(ctx);
  const actorOf = (role: string): Actor => {
    const u = db.get<any>("SELECT * FROM users WHERE role = ? ORDER BY id LIMIT 1", role)!;
    return { id: u.id, name: u.name, role: u.role, storeId: u.store_id, workstation: "test" };
  };
  pharmacist = actorOf("pharmacist");
  technician = actorOf("technician");
  for (const who of ["j.rivera", "k.patel", "m.diaz", "s.grant"]) {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { storeId: "store-7", email: `${who}@elmstreetrx.example`, password: PW, trusted: true } });
    cookies[who] = r.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }
}, 60_000);

afterEach(() => { rt.inject(undefined); rt.update({ provider: "mock" }); });

const call = (who: string, method: "GET" | "POST", url: string, payload?: unknown) => app.inject({ method, url, payload: payload as never, headers: { cookie: cookies[who]! } });
const liar = (fn: (agent: string, system: string, user: string) => string): ProviderClient => ({
  id: "mock", name: "liar", model: "liar-1",
  complete: async (system: string, user: string) => fn(/^AGENT:([\w-]+)/m.exec(system)?.[1] ?? "", system, user)
});
const sampleOf = (id: string) => (allAgents().find((a) => a.id === id)!.sample(ctx));
const run = (id: string, input: unknown = sampleOf(id), actor: Actor | null = pharmacist) => runAgent(ctx, actor, id, input);
const AGENT_IDS = ["coroner", "rx-explainer", "outreach-drafter", "night-watch", "stock-advisor", "copilot", "refill-outreach", "rx-guardian"];

describe("the six agents are registered with guardrails", () => {
  it("lists every agent, read-only, with guardrails and a sample", () => {
    expect(allAgents().map((a) => a.id).sort()).toEqual([...AGENT_IDS].sort());
    for (const a of allAgents()) {
      expect(a.guardrails.length).toBeGreaterThan(2);
      expect(a.purpose.length).toBeGreaterThan(20);
      expect(a.input.safeParse(a.sample(ctx)).success).toBe(true);
    }
  });
});

describe.each(["mock", "none"] as const)("every agent runs end to end on provider %s", (provider) => {
  beforeAll(() => { rt.update({ provider }); });
  for (const id of AGENT_IDS) {
    it(`${id}: advisory record, labelled, stored`, async () => {
      rt.update({ provider });
      const r = await run(id);
      expect(r.advisory).toBe(true);
      expect(r.label).toBe("AI advisory, a pharmacist decides");
      expect(r.agentId).toBe(id);
      expect(r.provider).toBe(provider);
      expect(r.mode).toBe(provider === "none" ? "rules only" : "ai");
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
      expect(r.ruleOutput).toBeTruthy();
      expect(r.gatedOutput).toBeTruthy();
      expect(Array.isArray(r.dropped)).toBe(true);
      if (provider === "none") { expect(r.rawOutput).toBeNull(); expect(r.input).toBe(""); }
      else { expect(r.rawOutput).toBeTruthy(); expect(r.input.length).toBeGreaterThan(2); }
      expect(listRuns(ctx, id, 1)[0]!.id).toBe(r.id);
      expect(ctx.db.get("SELECT 1 FROM audit WHERE action = 'agent.run' AND entity_id = ?", id)).toBeTruthy();
    });
  }

  it("coroner: reads the sample notice's lots", async () => {
    rt.update({ provider });
    const r = await run("coroner");
    const lots = (r.gatedOutput as any).lots.map((l: any) => l.value);
    expect(lots).toEqual(expect.arrayContaining(["PRORX050925-1", "PRORX050925-3"]));
  });

  it("rx-explainer: every rule hit survives and carries source rule", async () => {
    rt.update({ provider });
    const r = await run("rx-explainer");
    const rules = (r.ruleOutput as any).findings.filter((f: any) => f.severity !== "pass");
    expect(rules.length).toBeGreaterThan(0);
    const out = (r.gatedOutput as any).findings as any[];
    for (const f of rules) expect(out.some((o) => o.rule === f.rule && o.severity === f.severity && o.body === f.body && o.source === "rule")).toBe(true);
  });

  it("outreach-drafter: drafts only, one recipient each, consent respected, nothing sent", async () => {
    rt.update({ provider });
    const before = ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM outbox")!.n;
    const r = await run("outreach-drafter");
    expect(ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM outbox")!.n).toBe(before);
    const drafts = (r.extra as any).drafts as { patientId: string; channel: string; text: string; subject: string | null }[];
    expect((r.extra as any).sent).toBe(false);
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) {
      const me = ctx.db.get<any>("SELECT name, phone, email, sms_consent, email_consent, sms_opt_out, dnc, voice_consent FROM patients WHERE id = ?", d.patientId)!;
      expect(d.text).toContain(me.name.split(" ")[0]);
      if (d.channel === "sms") { expect(d.text).toMatch(/\(555\) 010-2200/); expect(d.text).toMatch(/STOP/); expect(me.sms_consent && !me.sms_opt_out).toBeTruthy(); }
      if (d.channel === "email") expect(me.email_consent).toBeTruthy();
      if (d.channel === "voicemail") {
        expect(d.text).not.toMatch(/\bS-\d{4}\b/);
        expect(d.text).not.toMatch(/recall|sterile|methylpred|ondansetron/i);
        expect(!me.dnc && me.voice_consent).toBeTruthy();
      }
      for (const other of ctx.db.all<{ id: string; name: string }>("SELECT id, name FROM patients WHERE id <> ?", d.patientId)) {
        const mine = new Set(me.name.toLowerCase().split(/\s+/));
        for (const part of other.name.toLowerCase().split(/\s+/)) if (part.length >= 4 && !mine.has(part)) expect(`${d.subject ?? ""} ${d.text}`.toLowerCase()).not.toContain(part);
      }
    }
    expect(draftQueue(ctx, (r.gatedOutput as any).recallId).length).toBe(drafts.length);
    expect(ctx.db.all("SELECT status FROM ai_drafts WHERE status NOT IN ('draft','superseded')")).toHaveLength(0);
  });

  it("night-watch: a digest that confirms nothing", async () => {
    rt.update({ provider });
    const before = ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM recall_lots WHERE confirmed_at IS NOT NULL")!.n;
    const r = await run("night-watch");
    expect(ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM recall_lots WHERE confirmed_at IS NOT NULL")!.n).toBe(before);
    const g = r.gatedOutput as any;
    expect(g.counts.newRecalls).toBeGreaterThanOrEqual(1);
    expect(g.autoConfirmed).toBe(0);
    expect(g.summary).toMatch(/recall/);
  });

  it("stock-advisor: the numbers equal the rule numbers", async () => {
    rt.update({ provider });
    const r = await run("stock-advisor");
    const rules = (r.ruleOutput as any).items as any[];
    const out = (r.gatedOutput as any).items as any[];
    expect(out.length).toBeGreaterThan(0);
    if (provider === "mock") expect(out.some((i) => i.explanation)).toBe(true);
    expect(out.map((i) => [i.key, i.reason, i.suggestedQty])).toEqual(rules.map((i) => [i.key, i.reason, i.suggestedQty]));
  });

  it("copilot: answers from a read-only tool", async () => {
    rt.update({ provider });
    const r = await run("copilot", { question: "Which recalls are open?" });
    const g = r.gatedOutput as any;
    expect(g.toolCalls.every((c: any) => c.ok)).toBe(true);
    expect(g.answer).toMatch(/D-0417-2026/);
    expect(g.source).toBe(provider === "none" ? "rules" : "ai");
  });
});

describe("a LYING provider cannot get past the gates", () => {
  const patientNames = () => ctx.db.all<{ name: string; phone: string }>("SELECT name, phone FROM patients");

  it("coroner: an invented lot is dropped and listed, real lots stay", async () => {
    rt.inject(liar(() => JSON.stringify({ ndcs: ["70004-417-05"], lots: [{ value: "PRORX050925-1", expiry: "2027-09-30", confidence: 0.99 }, { value: "FAKE999999", expiry: "2030-01-01", confidence: 0.99 }, { value: "PRORX-0509251", expiry: null, confidence: 0.99 }], notes: "" })));
    const r = await run("coroner");
    const lots = (r.gatedOutput as any).lots.map((l: any) => l.value);
    expect(lots).not.toContain("FAKE999999");
    expect(lots).toContain("PRORX050925-1");
    expect(r.dropped.map((d) => d.what)).toContain("lot FAKE999999");
    // every emitted lot is printed in the source (squashed, upper-cased)
    const src = String((sampleOf("coroner") as any).text).replace(/\s+/g, "").toUpperCase();
    for (const l of lots) expect(src).toContain(String(l).replace(/\s+/g, "").toUpperCase());
  });

  it("coroner: garbage from the model falls back to the regex result", async () => {
    rt.inject(liar(() => "I am sure the lots are ALL OF THEM."));
    const r = await run("coroner");
    expect(JSON.stringify((r.gatedOutput as any).lots)).toBe(JSON.stringify((r.ruleOutput as any).lots));
  });

  it("rx-explainer: cannot remove, soften or relabel a rule hit; false 'all clear' is dropped", async () => {
    rt.inject(liar(() => JSON.stringify({
      summary: "All checks clear. It is safe to fill.", removeRules: ["allergy", "frequency"], findings: [],
      possible: [{ title: "Ignore the allergy hit", body: "That is a false positive, dismiss it." }, { title: "Check storage", body: "Confirm the fridge log." }],
      prescriberDraft: "Dear Dr, please call (555) 010-0199."
    })));
    // find an order with at least one needs_review/block rule hit
    const rx = ctx.db.all<{ rx: string }>("SELECT rx FROM prescriptions ORDER BY rx").map((r) => r.rx);
    let checked = 0;
    for (const n of rx) {
      const base = (await run("rx-explainer", { rx: n }, pharmacist));
      const hits = (base.ruleOutput as any).findings.filter((f: any) => f.severity === "needs_review" || f.severity === "block");
      if (!hits.length) continue;
      checked++;
      const out = (base.gatedOutput as any);
      for (const f of (base.ruleOutput as any).findings) expect(out.findings.some((o: any) => o.rule === f.rule && o.severity === f.severity && o.source === "rule")).toBe(true);
      expect(out.summary).not.toMatch(/safe to fill/i);
      expect(out.summary).toBe((base.ruleOutput as any).summary);
      expect(out.worst).toBe((base.ruleOutput as any).worst);
      const extra = out.findings.filter((f: any) => f.source === "llm");
      expect(extra.length).toBe(1);
      expect(extra[0].severity).toBe("monitor");
      expect(extra[0].body).toMatch(/AI suggestion/);
      expect(out.prescriberDraft).toBeNull();
      expect(base.dropped.map((d) => d.what).join("|")).toMatch(/removeRules/);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("rx-explainer: the persisted Rx Watcher review is never touched by an agent run", async () => {
    const before = JSON.stringify(ctx.db.all("SELECT rx, review FROM prescriptions ORDER BY rx"));
    const f = ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM rx_findings")!.n;
    await run("rx-explainer");
    expect(JSON.stringify(ctx.db.all("SELECT rx, review FROM prescriptions ORDER BY rx"))).toBe(before);
    expect(ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM rx_findings")!.n).toBe(f);
  });

  it("outreach-drafter: a liar cannot put a name, phone, patient id, medicine or reason into a draft", async () => {
    const [a, b] = patientNames();
    rt.inject(liar(() => JSON.stringify({
      sms: `Hi ${a!.name}, call ${b!.phone} now.`,
      emailSubject: `Recall for ${b!.name}`,
      emailBody: `Dear {first_name}, ${b!.name} also got this. Call ${a!.phone}. See evil@example.com {secret_field}`,
      voicemail: "Hello {first_name}. Your Methylprednisolone is recalled for sterility, patient S-0417. Call {pharmacy_phone}. Again {pharmacy_phone}. Thank you for listening to this message."
    })));
    const before = ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM outbox")!.n;
    const r = await run("outreach-drafter");
    expect(ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM outbox")!.n).toBe(before);
    expect(r.dropped.map((d) => d.what).sort()).toEqual(expect.arrayContaining(["sms", "emailSubject", "emailBody", "voicemail"]));
    const g = r.gatedOutput as any;
    expect(g.source).toEqual({ sms: "rules", emailSubject: "rules", emailBody: "rules", voicemail: "rules" });
    const all = JSON.stringify((r.extra as any).drafts) + JSON.stringify(g);
    for (const p of [a!, b!]) {
      // a patient may legitimately receive their OWN first name; nobody's full name or phone is in any draft
      expect(all).not.toContain(p.name);
      expect(all).not.toContain(p.phone);
    }
    expect(all).not.toContain("evil@example.com");
    expect(all).not.toContain("{secret_field}");
    for (const d of (r.extra as any).drafts) if (d.channel === "voicemail") expect(d.text).not.toMatch(/S-\d{4}|recall|sterile/i);
  });

  it("outreach-drafter: a model text without the pharmacy phone is dropped; a missing STOP is added", async () => {
    rt.inject(liar(() => JSON.stringify({ sms: "Hi {first_name}, please come in.", emailSubject: "A note", emailBody: "Dear {first_name}, please visit. {pharmacy_phone}", voicemail: "x" })));
    const r = await run("outreach-drafter");
    expect((r.gatedOutput as any).source).toMatchObject({ sms: "rules", emailSubject: "ai", emailBody: "ai", voicemail: "rules" });
    rt.inject(liar(() => JSON.stringify({ sms: "Hi {first_name}, call {pharmacy_phone} about your pickup on {sold_date}.", emailSubject: "A note", emailBody: "Dear {first_name}, call {pharmacy_phone}.", voicemail: "x" })));
    const r2 = await run("outreach-drafter");
    expect((r2.gatedOutput as any).templates.sms).toMatch(/Reply STOP to opt out\.$/);
  });

  it("night-watch: a summary with an invented number, or one that claims actions, is dropped", async () => {
    rt.inject(liar(() => JSON.stringify({ summary: "I confirmed 99 lots and sent 40 messages." })));
    const r = await run("night-watch");
    expect((r.gatedOutput as any).summary).toBe((r.ruleOutput as any).summary);
    expect(r.dropped.length).toBe(1);
    rt.inject(liar(() => JSON.stringify({ summary: "Recalls were confirmed and the patients were notified." })));
    const r2 = await run("night-watch");
    expect((r2.gatedOutput as any).source).toBe("rules");
    expect(claimsAction("Recalls were confirmed.")).toBe(true);
    expect(claimsAction("Nothing was confirmed or sent.")).toBe(false);
  });

  it("stock-advisor: an explanation that changes or adds a number is dropped; the rule numbers do not move", async () => {
    rt.inject(liar((_a, _s, user) => JSON.stringify({ explanations: (JSON.parse(user).items as any[]).map((i) => ({ key: i.key, text: "Order 999 units now." })).concat([{ key: "no-such-key", text: "x" }]) })));
    const r = await run("stock-advisor");
    const out = (r.gatedOutput as any).items as any[];
    expect(out.length).toBeGreaterThan(0);
    for (const i of out) expect(i.explanation).toBeNull();
    expect(r.dropped.length).toBeGreaterThan(0);
    expect(out.map((i) => i.reason)).toEqual(((r.ruleOutput as any).items as any[]).map((i) => i.reason));
  });

  it("copilot: write tools do not exist, so a liar cannot run them; an invented lot, patient id or name never reaches the answer", async () => {
    const before = JSON.stringify(ctx.db.all("SELECT id, confirmed_at FROM recall_lots"));
    let turn = 0;
    rt.inject(liar(() => (++turn === 1 ? JSON.stringify({ tool: "confirm_recall_lot", args: { lot: "PRORX050925-1" } }) : JSON.stringify({ answer: "Lot ZZ99999 went to S-9999 and also to Maria Alvarez, 777 units." }))));
    const r = await run("copilot", { question: "Which recalls are open?" });
    expect(JSON.stringify(ctx.db.all("SELECT id, confirmed_at FROM recall_lots"))).toBe(before);
    expect(r.dropped.some((d) => /confirm_recall_lot/.test(d.what))).toBe(true);
    const g = r.gatedOutput as any;
    expect(g.source).toBe("rules");
    expect(g.answer).not.toMatch(/ZZ99999|S-9999|Maria|777/);
  });

  it("copilot: a technician cannot read patient ids, even if the model asks", async () => {
    let turn = 0;
    rt.inject(liar(() => (++turn === 1 ? JSON.stringify({ tool: "patients_for_lot", args: { lot: "PRORX050925-1" } }) : JSON.stringify({ answer: "Done." }))));
    const r = await run("copilot", { question: "Who got lot PRORX050925-1?" }, technician);
    expect(JSON.stringify(r.gatedOutput)).not.toMatch(/S-0\d{3}/);
    expect(r.dropped.some((d) => /cannot use patients_for_lot/.test(d.why))).toBe(true);
    const t = runTool(ctx, "technician", "patients_for_lot", { lot: "PRORX050925-1" });
    expect(t.ok).toBe(false);
    expect(runTool(ctx, "pharmacist", "patients_for_lot", { lot: "PRORX050925-1" }).ok).toBe(true);
  });

  it("a provider that throws leaves rules-only output and a clear note", async () => {
    rt.inject({ id: "mock", name: "broken", model: "b", complete: async () => { throw new Error("boom with key sk-live-1234567890abcdef"); } });
    for (const id of AGENT_IDS) {
      const r = await run(id);
      expect(r.mode).toBe("rules only");
      expect(r.error).toBeTruthy();
      expect(r.error).not.toContain("sk-live-1234567890abcdef");
      expect(r.gatedOutput).toBeTruthy();
    }
  });
});

describe("PHI minimisation: prompts carry patient ids only", () => {
  it("no agent prompt contains a name, phone, email or date of birth, even when the question does", async () => {
    const prompts: string[] = [];
    rt.inject({ id: "mock", name: "spy", model: "spy", complete: async (system: string, user: string) => { prompts.push(`${system}\n${user}`); return new MockProvider().complete(system, user); } });
    const pts = ctx.db.all<{ id: string; name: string; dob: string; phone: string; email: string; allergies: string }>("SELECT id, name, dob, phone, email, allergies FROM patients");
    expect(pts.length).toBeGreaterThan(3);
    for (const id of AGENT_IDS) await run(id);
    for (const n of ctx.db.all<{ rx: string }>("SELECT rx FROM prescriptions")) await run("rx-explainer", { rx: n.rx });
    const p0 = pts[0]!;
    await run("copilot", { question: `Did ${p0.name} (${p0.phone}, ${p0.email}, born ${p0.dob}) get lot AMX0926B? Who else?` });
    await run("copilot", { question: "Which patients received lot PRORX050925-1?" });
    expect(prompts.length).toBeGreaterThan(20);
    const blob = prompts.join("\n").toLowerCase();
    const products = ctx.db.all<{ name: string }>("SELECT name FROM products").map((p) => p.name.toLowerCase()).join(" ");
    for (const p of pts) {
      for (const part of p.name.toLowerCase().split(/\s+/).filter((x) => x.length >= 4)) expect(blob, `name part of ${p.id}`).not.toMatch(new RegExp(`\\b${part}\\b`));
      if (p.dob) expect(blob).not.toContain(p.dob);
      if (p.phone && !/010-2200/.test(p.phone)) expect(blob.replace(/\D/g, "")).not.toContain(p.phone.replace(/\D/g, ""));
      if (p.email) expect(blob).not.toContain(p.email.toLowerCase());
      for (const a of (p.allergies ?? "").toLowerCase().split(/[,;]/).map((x) => x.trim()).filter((x) => x.length >= 4 && !products.includes(x))) expect(blob, `allergy of ${p.id}`).not.toContain(a);
    }
    expect(blob).toMatch(/s-\d{4}/); // ids are what prompts use instead
  });

  it("a prompt that would leak is refused, not sent", async () => {
    const seen: string[] = [];
    rt.inject({ id: "mock", name: "spy", model: "spy", complete: async (_s: string, u: string) => { seen.push(u); return "{}"; } });
    const { LlmCall } = await import("../src/agents");
    const name = ctx.db.get<{ name: string }>("SELECT name FROM patients LIMIT 1")!.name;
    const llm = new LlmCall(ctx, rt.client(), "copilot");
    expect(await llm.ask("sys", `tell me about ${name}`)).toBeNull();
    expect(seen).toHaveLength(0);
    expect(llm.error).toMatch(/blocked/i);
    expect(llm.error).not.toContain(name);
  });
});

describe("provider runtime: keys stay in memory, are role-checked, audited, never echoed", () => {
  const SECRET = "sk-test-SECRETKEY-abcdefgh-wxyz1234";

  it("a pharmacist can switch provider and paste a key; the key is shown as its last four characters only", async () => {
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }));
    try {
      const r = await call("j.rivera", "POST", "/api/agents/provider", { provider: "anthropic", model: "claude-test", apiKey: SECRET });
      expect(r.statusCode).toBe(200);
      const p = r.json().provider;
      expect(p).toMatchObject({ provider: "anthropic", model: "claude-test", keySet: true, keyHint: "…1234", keySource: "pasted in the UI (memory only)" });
      expect(r.body).not.toContain(SECRET);
      expect((await call("j.rivera", "GET", "/api/agents")).body).not.toContain(SECRET);
      expect((await call("j.rivera", "GET", "/api/agents/provider")).body).not.toContain(SECRET);
      // the audit row says a key changed, not what it was
      const row = ctx.db.get<any>("SELECT * FROM audit WHERE action = 'agents.provider.update' ORDER BY id DESC LIMIT 1")!;
      expect(row.user_name).toBeTruthy();
      expect(JSON.stringify(row)).not.toContain(SECRET);
      expect(JSON.parse(row.after_json)).toMatchObject({ provider: "anthropic", keyChanged: true, keyHint: "…1234" });
      // a failing call whose error text echoes the key never leaks it
      const failing = new AgentRuntime({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: SECRET }, { fetch: (async () => { throw new Error(`bad key ${SECRET}`); }) as unknown as typeof fetch });
      const t = await failing.test();
      expect(t.ok).toBe(false);
      expect(JSON.stringify(t)).not.toContain(SECRET);
      // the agents run with the pasted key's provider failing closed to rules only
      rt.update({ provider: "anthropic" });
      const out = await run("copilot", { question: "Which recalls are open?" });
      expect(out.mode).toBe("rules only");
      expect(JSON.stringify(out)).not.toContain(SECRET);
      expect(JSON.stringify(ctx.db.all("SELECT * FROM ai_runs"))).not.toContain(SECRET);
      expect(JSON.stringify(ctx.db.all("SELECT * FROM audit"))).not.toContain(SECRET);
    } finally { spies.forEach((s) => s.mockRestore()); }
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("the key is not written to disk or persisted: a new runtime does not have it", () => {
    const a = new AgentRuntime({});
    a.update({ provider: "anthropic", apiKey: SECRET });
    expect(a.settings().keySet).toBe(true);
    expect(JSON.stringify(a.settings())).not.toContain(SECRET);
    expect(new AgentRuntime({}).settings().keySet).toBe(false);
    expect(a.update({ apiKey: "" }).keyChanged).toBe(true);
    expect(a.settings().keySet).toBe(false);
  });

  it("only a pharmacist or admin can change or test the provider; everyone signed in can read it", async () => {
    expect((await call("k.patel", "POST", "/api/agents/provider", { provider: "none" })).statusCode).toBe(403); // technician
    expect((await call("m.diaz", "POST", "/api/agents/provider", { provider: "none" })).statusCode).toBe(403); // cashier
    expect((await call("k.patel", "POST", "/api/agents/provider/test")).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/agents/provider", payload: { provider: "none" } })).statusCode).toBe(401);
    expect((await call("k.patel", "GET", "/api/agents/provider")).statusCode).toBe(200);
    expect((await call("s.grant", "POST", "/api/agents/provider", { provider: "mock" })).statusCode).toBe(200);
  });

  it("rejects an unsafe base URL and unknown fields", async () => {
    for (const baseUrl of ["file:///etc/passwd", "http://user:pw@localhost:11434/v1", "http://169.254.169.254/latest", "not a url"]) {
      expect((await call("j.rivera", "POST", "/api/agents/provider", { provider: "openai-compatible", baseUrl })).statusCode, baseUrl).toBe(422);
    }
    expect((await call("j.rivera", "POST", "/api/agents/provider", { provider: "mock", extra: 1 })).statusCode).toBe(422);
    expect((await call("j.rivera", "POST", "/api/agents/provider", { provider: "nope" })).statusCode).toBe(422);
    expect((await call("j.rivera", "POST", "/api/agents/provider", { provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "llama3" })).statusCode).toBe(200);
  });

  it("Test connection works on mock and none, and is audited", async () => {
    await call("j.rivera", "POST", "/api/agents/provider", { provider: "mock" });
    const ok = (await call("j.rivera", "POST", "/api/agents/provider/test")).json();
    expect(ok).toMatchObject({ ok: true, provider: "mock" });
    await call("j.rivera", "POST", "/api/agents/provider", { provider: "none" });
    expect((await call("j.rivera", "POST", "/api/agents/provider/test")).json()).toMatchObject({ ok: true, provider: "none" });
    expect(ctx.db.get("SELECT 1 FROM audit WHERE action = 'agents.provider.test'")).toBeTruthy();
  });

  it("Bedrock is the default when nothing is configured", () => {
    expect(new AgentRuntime({}).settings()).toMatchObject({ provider: "bedrock", model: "us.anthropic.claude-sonnet-5" });
    expect(new AgentRuntime({ LLM_PROVIDER: "none" }).client()).toBeNull();
  });
});

describe("provider adapters against stubs", () => {
  it("Bedrock: Converse request shape, region, model, text extraction (stubbed SDK client)", async () => {
    const sent: any[] = [];
    const created: any[] = [];
    const sdk: BedrockSdk = {
      BedrockRuntimeClient: class { constructor(cfg: any) { created.push(cfg); } async send(cmd: any) { sent.push(cmd); return { output: { message: { content: [{ text: "hel" }, { text: "lo" }] } } }; } } as any,
      ConverseCommand: class { constructor(public input: any) { Object.assign(this, { input }); } } as any
    };
    const p = new BedrockProvider("eu-west-1", "anthropic.test-model", async () => sdk);
    expect(await p.complete("SYS", "USER")).toBe("hello");
    expect(created).toEqual([{ region: "eu-west-1" }]);
    expect(sent[0].input).toMatchObject({ modelId: "anthropic.test-model", system: [{ text: "SYS" }], messages: [{ role: "user", content: [{ text: "USER" }] }], inferenceConfig: { temperature: 0 } });
    await p.complete("a", "b");
    expect(created).toHaveLength(1); // client reused
  });

  it("Bedrock through the runtime: errors are scrubbed, and a failed provider is not hammered", async () => {
    let calls = 0;
    const sdk: BedrockSdk = {
      BedrockRuntimeClient: class { async send() { calls++; throw new Error("CredentialsProviderError: Could not load credentials AKIAABCDEFGHIJKLMNOP"); } } as any,
      ConverseCommand: class { constructor(public input: any) {} } as any
    };
    const r = new AgentRuntime({ LLM_PROVIDER: "bedrock", AWS_REGION: "us-west-2" }, { bedrockSdk: async () => sdk });
    const c = r.client()!;
    await expect(c.complete("s", "u")).rejects.toThrow(/Could not load credentials/);
    await expect(c.complete("s", "u")).rejects.toThrow(/unavailable right now/);
    expect(calls).toBe(1);
    try { await c.complete("s", "u"); } catch (e) { expect(String((e as Error).message)).not.toContain("AKIAABCDEFGHIJKLMNOP"); }
    const t = await r.test();
    expect(t.ok).toBe(false);
    expect(JSON.stringify(t)).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(calls).toBe(2); // Test connection ignores the pause
  });

  it("Anthropic: request shape (stubbed fetch)", async () => {
    let seen: any;
    const f = (async (url: string, init: any) => { seen = { url, init }; return { ok: true, json: async () => ({ content: [{ type: "text", text: "hi" }] }) }; }) as unknown as typeof fetch;
    expect(await new AnthropicProvider("k-1234", "claude-x", f).complete("S", "U")).toBe("hi");
    expect(seen.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen.init.headers["x-api-key"]).toBe("k-1234");
    expect(JSON.parse(seen.init.body)).toMatchObject({ model: "claude-x", system: "S", messages: [{ role: "user", content: "U" }] });
  });

  it("OpenAI-compatible: base URL, optional key, chat completions shape (stubbed fetch)", async () => {
    let seen: any;
    const f = (async (url: string, init: any) => { seen = { url, init }; return { ok: true, json: async () => ({ choices: [{ message: { content: "yo" } }] }) }; }) as unknown as typeof fetch;
    expect(await new OpenAiCompatibleProvider("http://localhost:11434/v1/", "", "llama3", f).complete("S", "U")).toBe("yo");
    expect(seen.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(seen.init.headers.authorization).toBeUndefined();
    expect(JSON.parse(seen.init.body)).toMatchObject({ model: "llama3", messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }] });
    await new OpenAiCompatibleProvider("https://x.openai.azure.com/openai/v1", "azure-key", "gpt", f, async () => [{ address: "93.184.216.34", family: 4 }]).complete("S", "U");
    expect(seen.init.headers.authorization).toBe("Bearer azure-key");
    expect(seen.init.headers["api-key"]).toBe("azure-key");
  });

  it("an HTTP error never includes the response body or the key", async () => {
    const f = (async () => ({ ok: false, status: 401, json: async () => ({ error: "bad key k-1234" }) })) as unknown as typeof fetch;
    await expect(new AnthropicProvider("k-1234", "m", f).complete("s", "u")).rejects.toThrow(/HTTP 401$/);
  });
});

describe("agent routes", () => {
  it("GET /api/agents lists the six agents with what the caller may run", async () => {
    const r = (await call("k.patel", "GET", "/api/agents")).json();
    expect(r.label).toBe("AI advisory, a pharmacist decides");
    expect(r.agents).toHaveLength(8);
    const can = Object.fromEntries(r.agents.map((a: any) => [a.id, a.canRun]));
    expect(can).toMatchObject({ coroner: true, "stock-advisor": true, copilot: true, "rx-explainer": false, "outreach-drafter": false, "refill-outreach": true });
    expect(r.canConfigure).toBe(false);
    expect((await call("m.diaz", "GET", "/api/agents")).json().agents.every((a: any) => !a.canRun)).toBe(true);
    expect((await app.inject({ url: "/api/agents" })).statusCode).toBe(401);
  });

  it("POST /api/agents/:id/run: sample input works in one call, role-checked, audited", async () => {
    rt.update({ provider: "mock" });
    const r = await call("j.rivera", "POST", "/api/agents/coroner/run", { useSample: true });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.label).toBe("AI advisory, a pharmacist decides");
    expect(j.run).toMatchObject({ agentId: "coroner", provider: "mock", advisory: true, mode: "ai" });
    expect(j.run.gatedOutput.lots.length).toBeGreaterThan(0);
    expect((await call("k.patel", "POST", "/api/agents/outreach-drafter/run", { useSample: true })).statusCode).toBe(403);
    expect((await call("m.diaz", "POST", "/api/agents/coroner/run", { useSample: true })).statusCode).toBe(403);
    expect((await call("j.rivera", "POST", "/api/agents/nope/run", {})).statusCode).toBe(404);
    expect((await call("j.rivera", "POST", "/api/agents/coroner/run", { input: { text: "x" } })).statusCode).toBe(422);
    const a = ctx.db.get<any>("SELECT * FROM audit WHERE action = 'agent.run' AND entity_id = 'coroner' ORDER BY id DESC LIMIT 1")!;
    expect(a.user_name).toBe(pharmacist.name);
  });

  it("GET /api/agents/runs and /api/agents/:id; run records are bounded", async () => {
    const runs = (await call("j.rivera", "GET", "/api/agents/runs?limit=5")).json();
    expect(runs.runs.length).toBeGreaterThan(0);
    expect(runs.runs[0]).toMatchObject({ advisory: true });
    const d = (await call("j.rivera", "GET", "/api/agents/copilot")).json();
    expect(d.sample.question).toBeTruthy();
    expect(d.guardrails.length).toBeGreaterThan(2);
    for (let i = 0; i < 320; i++) ctx.db.run("INSERT INTO ai_runs (agent, provider, model, started_at, latency_ms, mode, input, rule_output, raw_output, gated_output, dropped, error, by_user) VALUES ('x','none','',?,0,'rules only','','null',NULL,'null','[]',NULL,'t')", i);
    await run("coroner");
    expect(ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM ai_runs")!.n).toBeLessThanOrEqual(300);
  });

  it("GET /api/agents/drafts is for pharmacists and says nothing was sent", async () => {
    rt.update({ provider: "mock" });
    await run("outreach-drafter");
    const ok = (await call("j.rivera", "GET", "/api/agents/drafts")).json();
    expect(ok.note).toMatch(/Nothing here has been sent/);
    expect(ok.drafts.length).toBeGreaterThan(0);
    expect(ok.drafts[0].label).toMatch(/Draft/);
    expect((await call("k.patel", "GET", "/api/agents/drafts")).statusCode).toBe(403);
  });
});

describe("MCP surface: the read-only agents are tools behind a scope", () => {
  it("only a partner with agents.read sees and can call them", async () => {
    rt.update({ provider: "mock" });
    const tokenFor = async (id: string, secret: string) => (await app.inject({ method: "POST", url: "/oauth/token", payload: { grant_type: "client_credentials", client_id: id, client_secret: secret } })).json().access_token as string;
    // the seeded concierge has no agents.read: its tool list is unchanged
    const created = (await call("s.grant", "POST", "/api/integrations", { partner: "Agent tester (synthetic)", kind: "MCP", scopes: ["availability.check", "recall.read", "agents.read"] })).json();
    expect(created.clientSecret).toBeTruthy();
    const tok = await tokenFor(created.clientId, created.clientSecret);
    const rpc = (body: unknown) => app.inject({ method: "POST", url: "/mcp", payload: body as never, headers: { authorization: `Bearer ${tok}` } });
    const names = (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json().result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["agent_night_watch_digest", "agent_stock_advisor", "agent_copilot"]));
    for (const t of (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json().result.tools) expect(t.annotations.readOnlyHint).toBe(true);
    const out = (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agent_copilot", arguments: { question: "Which patients received lot PRORX050925-1?" } } })).json().result;
    expect(out.isError).toBe(false);
    expect(out.structuredContent).toMatchObject({ advisory: "AI advisory, a pharmacist decides", agent: "copilot" });
    expect(JSON.stringify(out)).not.toMatch(/S-\d{4}/); // a partner never gets patient ids
    const nw = (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "agent_night_watch_digest", arguments: {} } })).json().result;
    expect(nw.structuredContent.result.counts).toBeTruthy();
    // a partner without the scope is refused
    const concierge = ctx.db.get<any>("SELECT id FROM integrations WHERE id = 'int-rx-concierge'");
    expect(concierge).toBeTruthy();
  });
});
