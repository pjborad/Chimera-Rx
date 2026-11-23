import { resetDemo } from "./scenario-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, Db, ingestFaxInbox, loadConfig, SandboxNotifier, seedDatabase, type Ctx } from "../src/index";
import { verifyAuditChain, type Actor } from "../src/core";
import { runRules } from "../src/rxwatcher";
import { reviewPending } from "../src/rxwatcher";
import {
  AgentRuntime, backgroundStatus, backgroundTick, gateGuardian, getAgent, guardianHits, listSuggestions, MockProvider, runAgent, setEnabled,
  type GuardInput, type Hit, type ProviderClient
} from "../src/agents";
import type { Hist } from "../src/agents/guardian";

// Rx Guardian: the patient-history prescription checker and the background mode around it.

const PW = "moonlight-rx-2026";
const NOW = Date.parse("2026-11-18T18:00:00Z");
const TODAY = "2026-11-18";
process.env.OFFLINE = "1";

// ------------------------------------------------------------------ pure rules on crafted histories

const ago = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const fill = (drug: string, daysAgo: number, days = 30, o: Partial<Hist> = {}): Hist => ({ filled_on: ago(daysAgo), ndc11: "", drug, sig: "As directed", qty: 1, days_supply: days, status: "Active", lot: "", prescriber: "Dr. A", ...o });
const order = (drug: string, directions: string, qty: number, days: number | null, prescriber = "Dr. A") => ({ rx: "T1", drug, ndc11: "00000000000", qty, directions, days_supply: days, prescriber });
const input = (o: Partial<GuardInput> & { order: GuardInput["order"] }): GuardInput => ({
  today: TODAY, product: { name: o.order.drug, pack_size: "" }, patient: { id: "S-0001", dob: "1975-05-05", allergies: "" }, history: [], lotBlocked: () => null, priorFlags: { total: 0, accepted: 0 }, ...o
});
const rulesOf = (i: GuardInput) => guardianHits(i).map((h) => h.rule);
const ATORVA = order("Atorvastatin 20 mg · 90 tab", "Take 1 tablet by mouth daily", 1, 90);
const INSULIN = order("Insulin glargine 100 units/mL · 5 × 3 mL pens", "Inject 20 units under the skin once daily at bedtime", 1, 68);

describe("Rx Guardian rules fire on a crafted history and stay quiet on a clean one", () => {
  it("a clean order and history raise nothing", () => {
    expect(guardianHits(input({ order: ATORVA, history: [fill("Atorvastatin 20 mg · 90 tab", 120, 90)] }))).toEqual([]);
    expect(guardianHits(input({ order: INSULIN }))).toEqual([]);
  });

  it("duplicate therapy: the same medicine already active from another prescriber", () => {
    const h = guardianHits(input({ order: order("Lisinopril 10 mg · 90 tab", "Take 1 tablet by mouth daily", 1, 90, "Dr. B"), history: [fill("Lisinopril 10 mg · 90 tab", 10, 90, { prescriber: "Dr. A" })] }));
    expect(h.some((x) => x.rule === "duplicate-therapy")).toBe(true);
    expect(rulesOf(input({ order: order("Lisinopril 10 mg · 90 tab", "Take 1 tablet by mouth daily", 1, 90, "Dr. A"), history: [fill("Lisinopril 10 mg · 90 tab", 120, 90, { prescriber: "Dr. A" })] }))).not.toContain("duplicate-therapy");
  });

  it("interaction: a Watcher pair and a demo-table pair, each backed by a dated history fact", () => {
    const glp = guardianHits(input({ order: INSULIN, history: [fill("Semaglutide 1 mg/dose pen", 12, 28)] })).find((h) => h.rule === "interaction")!;
    expect(glp.severity).toBe("needs_review");
    expect(glp.facts.some((f) => f.date === ago(12))).toBe(true);
    const demo = guardianHits(input({ order: order("Ciprofloxacin 500 mg · 14 tab", "Take 1 tablet twice daily for 7 days", 1, 7), history: [fill("Insulin glargine 100 U/mL · 5 pens", 20, 68)] })).find((h) => h.rule === "interaction")!;
    expect(demo.title).toMatch(/demo table/);
    expect(rulesOf(input({ order: INSULIN, history: [fill("Metformin ER 500 mg · 100 tab", 12, 30)] }))).not.toContain("interaction");
  });

  it("allergy class conflict is a block and the prompt text carries only a class code", () => {
    const h = guardianHits(input({ order: order("Amoxicillin 500 mg · 100 cap", "Take 1 capsule three times daily for 10 days", 1, 10), patient: { id: "S-0001", dob: "1975-05-05", allergies: "Penicillin" } })).find((x) => x.rule === "allergy-class")!;
    expect(h.severity).toBe("block");
    expect(h.facts[0]!.promptText).toMatch(/PCN/);
    expect(h.facts[0]!.promptText).not.toMatch(/penicillin/i);
    expect(rulesOf(input({ order: order("Amoxicillin 500 mg · 100 cap", "Take 1 capsule three times daily for 10 days", 1, 10) }))).not.toContain("allergy-class");
  });

  it("dose or days supply that does not match the directions", () => {
    const h = guardianHits(input({ order: order("Insulin glargine 100 units/mL · 5 × 3 mL pens", "Inject 20 units under the skin every morning and at bedtime", 1, 90) }));
    expect(h.filter((x) => x.rule === "sig-mismatch").length).toBeGreaterThanOrEqual(2);
    expect(rulesOf(input({ order: INSULIN }))).not.toContain("sig-mismatch");
  });

  it("early refill: a Schedule II fill is needs_review, another medicine is a monitor, a normal refill is silent", () => {
    const c2 = guardianHits(input({ order: order("Oxycodone HCl 5 mg · 100 tab", "Take 1 tablet every 6 hours as needed", 1, 25), history: [fill("Oxycodone HCl 5 mg · 100 tab", 8, 30)] })).find((h) => h.rule === "early-refill")!;
    expect(c2.severity).toBe("needs_review");
    const other = guardianHits(input({ order: order("Lisinopril 10 mg · 90 tab", "Take 1 tablet by mouth daily", 1, 90), history: [fill("Lisinopril 10 mg · 90 tab", 20, 90)] })).find((h) => h.rule === "early-refill")!;
    expect(other.severity).toBe("monitor");
    expect(rulesOf(input({ order: order("Lisinopril 10 mg · 90 tab", "Take 1 tablet by mouth daily", 1, 90), history: [fill("Lisinopril 10 mg · 90 tab", 85, 90)] }))).not.toContain("early-refill");
  });

  it("non-adherence reuses the PDC maths; late refill of another active medicine is a monitor", () => {
    const gaps = [fill("Insulin glargine 100 U/mL · 5 pens", 178), fill("Insulin glargine 100 U/mL · 5 pens", 115), fill("Insulin glargine 100 U/mL · 5 pens", 52)];
    const h = guardianHits(input({ order: INSULIN, history: gaps })).find((x) => x.rule === "non-adherence")!;
    expect(h.severity).toBe("needs_review");
    expect(h.facts[0]!.text).toMatch(/\d+% of days covered/);
    const steady = [fill("Insulin glargine 100 U/mL · 5 pens", 85), fill("Insulin glargine 100 U/mL · 5 pens", 56), fill("Insulin glargine 100 U/mL · 5 pens", 28)];
    expect(rulesOf(input({ order: INSULIN, history: steady }))).not.toContain("non-adherence");
    const late = guardianHits(input({ order: ATORVA, history: [fill("Lisinopril 10 mg · 90 tab", 60, 30)] })).find((x) => x.rule === "late-refill")!;
    expect(late.severity).toBe("monitor");
  });

  it("a recalled or quarantined lot in the history", () => {
    const hist = [fill("Insulin glargine 100 U/mL · 5 pens", 52, 30, { lot: "GX4471C" })];
    const h = guardianHits(input({ order: INSULIN, history: hist, lotBlocked: (lot) => (lot === "GX4471C" ? { recallId: "D-0611-2026" } : null) })).find((x) => x.rule === "recalled-lot")!;
    expect(h.severity).toBe("needs_review");
    expect(h.facts[0]!.text).toContain("D-0611-2026");
    expect(rulesOf(input({ order: INSULIN, history: hist }))).not.toContain("recalled-lot");
  });

  it("controlled-substance pattern: several prescribers on Schedule II", () => {
    const o = order("Oxycodone HCl 5 mg · 100 tab", "Take 1 tablet every 6 hours as needed", 1, 25, "Dr. C");
    const many = [fill("Oxycodone HCl 5 mg · 100 tab", 80, 20, { prescriber: "Dr. A", status: "Completed" }), fill("Oxycodone HCl 5 mg · 100 tab", 40, 20, { prescriber: "Dr. B", status: "Completed" })];
    expect(rulesOf(input({ order: o, history: many }))).toContain("controlled-pattern");
    expect(rulesOf(input({ order: o, history: [fill("Oxycodone HCl 5 mg · 100 tab", 80, 20, { prescriber: "Dr. C", status: "Completed" })] }))).not.toContain("controlled-pattern");
  });

  it("a dose outside the age band (demo ceiling)", () => {
    const o = order("Oxycodone HCl 5 mg · 100 tab", "Take 2 tablets every 6 hours as needed", 1, 12);
    expect(rulesOf(input({ order: o, patient: { id: "S-0001", dob: "1938-01-01", allergies: "" } }))).toContain("dose-age-band");
    expect(rulesOf(input({ order: o, patient: { id: "S-0001", dob: "1975-01-01", allergies: "" } }))).not.toContain("dose-age-band");
  });

  it("never contradicts Rx Watcher: every non-pass rule finding has a Guardian hit with the same severity", () => {
    const i = input({ order: order("Insulin glargine 100 units/mL · 5 × 3 mL pens", "Inject 20 units under the skin every morning and at bedtime", 1, 90), history: [fill("Semaglutide 1 mg/dose pen", 12, 28), fill("Lisinopril 10 mg · 90 tab", 60, 30)], patient: { id: "S-0001", dob: "1975-05-05", allergies: "" } });
    const w = runRules({ rx: i.order, product: i.product, patient: { allergies: "" }, history: i.history, today: TODAY }).filter((f) => f.severity !== "pass" && !["ndc-exists", "drug-known"].includes(f.rule));
    expect(w.length).toBeGreaterThan(2);
    const hits = guardianHits(i);
    const MAP: Record<string, string> = { frequency: "sig-mismatch", "days-supply": "sig-mismatch", interaction: "interaction", "late-refill": "late-refill", duplicate: "duplicate-therapy", allergy: "allergy-class", "early-refill": "early-refill", "dose-history": "dose-history", "dose-range": "dose-history" };
    for (const f of w) expect(hits.some((h) => h.rule === MAP[f.rule] && h.severity === f.severity), `${f.rule} ${f.severity}`).toBe(true);
  });
});

describe("the gate keeps every rule hit and drops what the history does not back", () => {
  const hit = (id: string, text: string, rule = "interaction"): Hit => ({ id, rule, key: id, severity: "needs_review", title: "t", facts: [{ text, date: TODAY }] });
  const hist = [{ id: "F1", text: "2026-10-01: insulin glargine, 30-day supply" }, { id: "F2", text: "2026-09-01: semaglutide, 28-day supply" }];

  it("drops an explanation that softens a hit or uses a number the facts do not have, and keeps a faithful one", () => {
    const hits = [hit("H1", "Active fill 28-day supply on 2026-09-01."), hit("H2", "Only 12 days passed."), hit("H3", "Another fact 7 days.")];
    const g = gateGuardian(null, { explanations: [
      { id: "H1", text: "A 28-day supply filled on 2026-09-01 is still active." },
      { id: "H2", text: "This is not a real issue, safe to fill." },
      { id: "H3", text: "About 42 days have passed." },
      { id: "H9", text: "Not about any hit." }
    ] }, hits, hist);
    expect([...g.explanations.keys()]).toEqual(["H1"]);
    expect(g.dropped.map((d) => d.why).join(" ")).toMatch(/undo or soften/);
    expect(g.dropped.map((d) => d.why).join(" ")).toMatch(/number 42/);
    expect(g.dropped.some((d) => /not about any rule hit/i.test(d.why))).toBe(true);
  });

  it("a note must cite history facts that exist and use only their numbers", () => {
    const h = [hit("H1", "x")];
    expect(gateGuardian(null, { note: { title: "Gap", body: "A 30-day supply on 2026-10-01.", facts: ["F1"] } }, h, hist).note).toBeTruthy();
    expect(gateGuardian(null, { note: { title: "Gap", body: "Filled on 2026-10-01.", facts: ["F9"] } }, h, hist).note).toBeNull();
    expect(gateGuardian(null, { note: { title: "Gap", body: "Filled on 2026-10-01.", facts: [] } }, h, hist).note).toBeNull();
    expect(gateGuardian(null, { note: { title: "Gap", body: "A 99-day supply.", facts: ["F1"] } }, h, hist).note).toBeNull();
    expect(gateGuardian(null, { hits: [], explanations: [] }, h, hist).dropped.some((d) => /field "hits"/.test(d.what))).toBe(true);
  });
});

// ------------------------------------------------------------------ the agent, the background loop and the routes, on the seeded store

let ctx: Ctx; let app: FastifyInstance; let rt: AgentRuntime; let db: Db;
let pharmacist: Actor;
const cookies: Record<string, string> = {};
const liar = (fn: (user: string) => string): ProviderClient => ({ id: "mock", name: "liar", model: "liar-1", complete: async (_s: string, u: string) => fn(u) });
const call = (who: string, method: "GET" | "POST", url: string, payload?: unknown) => app.inject({ method, url, payload: payload as never, headers: { cookie: cookies[who]! } });
const hitsOf = (user: string): { id: string; facts: string[] }[] => JSON.parse(/<hits>([\s\S]*?)<\/hits>/.exec(user)?.[1] ?? "[]");
const snapshot = () => JSON.stringify(db.all("SELECT * FROM prescriptions ORDER BY id"));

beforeAll(async () => {
  const cfg = loadConfig({}, { sqlitePath: ":memory:", sandboxDelayMs: 20, today: TODAY, nightWatch: false, assetsDir: "/nonexistent", webDist: "/nonexistent" });
  db = new Db(":memory:");
  rt = new AgentRuntime({ LLM_PROVIDER: "mock" });
  ctx = { cfg, db, notify: new SandboxNotifier(db, cfg), now: () => NOW, agents: rt };
  seedDatabase(db, cfg, NOW);
  await ingestFaxInbox(ctx);
  await reviewPending(ctx);
  app = await buildApp(ctx);
  const u = db.get<any>("SELECT * FROM users WHERE role = 'pharmacist' ORDER BY id LIMIT 1")!;
  pharmacist = { id: u.id, name: u.name, role: u.role, storeId: u.store_id, workstation: "test" };
  for (const who of ["j.rivera", "k.patel", "m.diaz", "s.grant"]) {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { storeId: "store-7", email: `${who}@elmstreetrx.example`, password: PW, trusted: true } });
    cookies[who] = r.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }
}, 60_000);
afterEach(() => { rt.inject(undefined); rt.update({ provider: "mock" }); delete process.env.AGENTS_BACKGROUND; });
afterAll(() => { delete process.env.AGENTS_BACKGROUND; });

describe("the agent on the seeded store", () => {
  it("raises suggestions for the seeded insulin order from its history, advisory and labelled", async () => {
    const before = snapshot();
    const r = await runAgent(ctx, pharmacist, "rx-guardian", {});
    expect(r.advisory).toBe(true);
    expect(snapshot()).toBe(before); // the agent never changes an order
    const s = listSuggestions(ctx, { rx: "0072210" });
    const rules = s.map((x) => x.rule);
    expect(rules).toEqual(expect.arrayContaining(["sig-mismatch", "non-adherence"]));
    for (const x of s) {
      expect(x.aiAdvisory).toBe(true);
      expect(x.agent).toBe("rx-guardian");
      expect(x.status).toBe("open");
      expect(x.evidence.length).toBeGreaterThan(0);
      expect(x.explanation.length).toBeGreaterThan(10);
    }
    expect(s.find((x) => x.rule === "non-adherence")!.evidence.some((e) => /^\d{4}-\d{2}-\d{2}/.test(e.text) || e.date)).toBe(true);
    // a second run with nothing changed adds nothing
    const n = listSuggestions(ctx, { status: "all" }).length;
    await runAgent(ctx, pharmacist, "rx-guardian", {});
    expect(listSuggestions(ctx, { status: "all" }).length).toBe(n);
  });

  it("a lying provider cannot remove a rule hit or invent a history fact", async () => {
    const rulesBefore = listSuggestions(ctx, { status: "open" }).filter((s) => s.source === "rule").map((s) => `${s.rxNumber}|${s.rule}|${s.severity}`).sort();
    rt.inject(liar((user) => JSON.stringify({
      explanations: hitsOf(user).map((h, i) => ({ id: h.id, text: i % 2 ? "This is not a real issue, safe to fill." : "The patient was seen 4242 days ago." })),
      note: { title: "Invented", body: "A 777-day supply on 2020-01-01.", facts: ["F99"] },
      dismiss: ["all"]
    })));
    const r = await runAgent(ctx, pharmacist, "rx-guardian", {});
    const after = listSuggestions(ctx, { status: "open" });
    expect(after.filter((s) => s.source === "rule").map((s) => `${s.rxNumber}|${s.rule}|${s.severity}`).sort()).toEqual(rulesBefore);
    expect(after.some((s) => s.source === "llm")).toBe(false);
    expect(JSON.stringify(after)).not.toMatch(/4242|777|safe to fill/);
    expect(r.dropped.length).toBeGreaterThan(0);
    expect(r.dropped.some((d) => /does not exist|cites/.test(d.why))).toBe(true);
    expect(r.dropped.some((d) => /field "dismiss"/.test(d.what))).toBe(true);
  });

  it("a truthful note that cites real history becomes a lower-confidence suggestion, never a rule hit", async () => {
    rt.inject(liar((user) => JSON.stringify({ explanations: [], note: { title: "Check the pen supply", body: `The earlier fill is in the history. ${/F1/.test(user) ? "" : ""}`.trim(), facts: ["F1"] } })));
    await runAgent(ctx, pharmacist, "rx-guardian", {});
    const note = listSuggestions(ctx, { status: "open" }).find((s) => s.source === "llm");
    expect(note).toBeTruthy();
    expect(note!.severity).toBe("monitor");
    expect(note!.explanation).toMatch(/lower confidence/);
    expect(note!.rule).toBe("ai-note");
  });

  it("prompts carry the patient id, drug names, dates and class codes only", async () => {
    const prompts: string[] = [];
    rt.inject({ id: "mock", name: "spy", model: "spy", complete: async (system: string, user: string) => { prompts.push(`${system}\n${user}`); return new MockProvider().complete(system, user); } });
    // an amoxicillin order for the patient who lists a penicillin allergy, so the allergy path is in the prompt
    db.run("INSERT INTO prescriptions (rx, patient_id, ndc11, drug, qty, directions, prescriber, refills, status, due, days_supply) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      "T0000901", "S-0612", db.get<{ ndc11: string }>("SELECT ndc11 FROM products WHERE name LIKE 'Amoxicillin%'")!.ndc11, "Amoxicillin 500 mg · 100 cap", 1, "Take 1 capsule three times daily for 10 days", "Dr. A. Nwosu", 0, "to_fill", "waiting", 10);
    await runAgent(ctx, pharmacist, "rx-guardian", {});
    expect(listSuggestions(ctx, { rx: "T0000901" }).some((s) => s.rule === "allergy-class" && s.severity === "block")).toBe(true);
    const blob = prompts.join("\n").toLowerCase();
    expect(prompts.length).toBeGreaterThan(0);
    expect(blob).toMatch(/pcn/);
    expect(blob).not.toMatch(/penicillin/);
    expect(blob).toMatch(/s-0612/);
    expect(blob).toMatch(/age_band/);
    const pts = db.all<{ name: string; dob: string; phone: string; email: string }>("SELECT name, dob, phone, email FROM patients");
    for (const p of pts) {
      for (const part of p.name.toLowerCase().split(/\s+/).filter((x) => x.length >= 4)) expect(blob).not.toMatch(new RegExp(`\\b${part}\\b`));
      if (p.dob) expect(blob).not.toContain(p.dob);
      if (p.email) expect(blob).not.toContain(p.email.toLowerCase());
      if (p.phone) expect(blob.replace(/\D/g, "")).not.toContain(p.phone.replace(/\D/g, ""));
    }
    db.run("DELETE FROM prescriptions WHERE rx = 'T0000901'");
    await runAgent(ctx, pharmacist, "rx-guardian", {});
  });

  it("a provider that throws leaves rules-only output and every rule hit", async () => {
    const before = listSuggestions(ctx, { status: "open" }).filter((s) => s.source === "rule").length;
    rt.inject({ id: "mock", name: "broken", model: "b", complete: async () => { throw new Error("boom with key sk-live-1234567890abcdef"); } });
    const r = await runAgent(ctx, pharmacist, "rx-guardian", {});
    expect(r.mode).toBe("rules only");
    expect(r.error).toBeTruthy();
    expect(r.error).not.toContain("sk-live-1234567890abcdef");
    expect(listSuggestions(ctx, { status: "open" }).filter((s) => s.source === "rule").length).toBe(before);
  });

  it("suggestions are stored encrypted: title, evidence, explanation and the decision reason", async () => {
    const rows = db.raw.prepare("SELECT title, evidence, explanation FROM suggestions").all() as { title: string; evidence: string; explanation: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) for (const v of [r.title, r.evidence, r.explanation]) { expect(v.startsWith("enc:v1:")).toBe(true); expect(v).not.toMatch(/insulin|semaglutide|supply/i); }
    const s = listSuggestions(ctx, { rx: "0072210" })[0]!;
    const res = await call("j.rivera", "POST", `/api/suggestions/${s.id}/dismiss`, { reason: "Checked with the patient by phone." });
    expect(res.statusCode).toBe(200);
    const raw = db.raw.prepare("SELECT decision_reason FROM suggestions WHERE id = ?").get(s.id) as { decision_reason: string };
    expect(raw.decision_reason.startsWith("enc:v1:")).toBe(true);
    expect(raw.decision_reason).not.toContain("phone");
  });
});

describe("background mode", () => {
  it("runs an enabled agent, skips a disabled one, and runs the Guardian again when an order changes", async () => {
    const st = () => Object.fromEntries(backgroundStatus(ctx).map((s) => [s.id, s]));
    expect(st()["rx-guardian"]!.enabled).toBe(true); // the demo seed switches it on
    expect(st()["stock-advisor"]!.enabled).toBe(false);
    const ran = await backgroundTick(ctx);
    expect(ran).toContain("rx-guardian");
    expect(ran).not.toContain("stock-advisor");
    expect(st()["rx-guardian"]!.runsToday).toBeGreaterThan(0);
    expect(st()["rx-guardian"]!.lastRunAt).toBe(NOW);
    expect(st()["rx-guardian"]!.nextRunAt).toBe(NOW + 5 * 60_000);
    expect(st()["stock-advisor"]!.lastRunAt).toBeNull();
    expect(await backgroundTick(ctx)).toEqual([]); // nothing due, nothing changed
    db.run("INSERT INTO prescriptions (rx, patient_id, ndc11, drug, qty, directions, prescriber, refills, status, due, days_supply) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      "T0000902", "S-0448", db.get<{ ndc11: string }>("SELECT ndc11 FROM products WHERE name LIKE 'Lisinopril%'")!.ndc11, "Lisinopril 10 mg · 90 tab", 1, "Take 1 tablet by mouth daily", "Dr. L. Moreno", 0, "to_fill", "waiting", 90);
    expect(await backgroundTick(ctx)).toContain("rx-guardian"); // a new order triggers it before the interval is up
    db.run("DELETE FROM prescriptions WHERE rx = 'T0000902'");
  });

  it("survives an agent that throws and a provider that fails, and records the error", async () => {
    await call("j.rivera", "POST", "/api/agents/night-watch/enable");
    const nw = getAgent("night-watch")!;
    const orig = nw.run;
    nw.run = async () => { throw new Error("boom"); };
    try {
      const ran = await backgroundTick(ctx);
      expect(ran).toContain("night-watch");
      const s = backgroundStatus(ctx).find((x) => x.id === "night-watch")!;
      expect(s.lastStatus).toBe("error");
      expect(s.lastError).toBeTruthy();
    } finally { nw.run = orig; }
    await call("j.rivera", "POST", "/api/agents/night-watch/disable");
    rt.inject({ id: "mock", name: "broken", model: "b", complete: async () => { throw new Error("provider down"); } });
    await call("j.rivera", "POST", "/api/agents/stock-advisor/enable");
    const ran = await backgroundTick(ctx);
    expect(ran).toContain("stock-advisor");
    const s = backgroundStatus(ctx).find((x) => x.id === "stock-advisor")!;
    expect(s.lastStatus).toBe("ok");
    expect(s.lastMode).toBe("rules only");
    await call("j.rivera", "POST", "/api/agents/stock-advisor/disable");
  });

  it("AGENTS_BACKGROUND=0 stops the loop; Run now still works", async () => {
    process.env.AGENTS_BACKGROUND = "0";
    db.run("UPDATE agent_settings SET next_run_at = 0 WHERE agent = 'rx-guardian'");
    expect(await backgroundTick(ctx)).toEqual([]);
    expect(backgroundStatus(ctx).find((s) => s.id === "rx-guardian")!.nextRunAt).toBeNull();
    const r = await call("j.rivera", "POST", "/api/agents/rx-guardian/run-now");
    expect(r.statusCode).toBe(200);
    expect(r.json().status.lastStatus).toBe("ok");
  });
});

describe("routes and roles", () => {
  it("suggestion data: pharmacist and technician read, cashier and admin get 403, anonymous 401", async () => {
    expect((await call("j.rivera", "GET", "/api/suggestions")).statusCode).toBe(200);
    const t = await call("k.patel", "GET", "/api/suggestions");
    expect(t.statusCode).toBe(200);
    expect(t.json().canDecide).toBe(false);
    expect((await call("m.diaz", "GET", "/api/suggestions")).statusCode).toBe(403);
    expect((await call("s.grant", "GET", "/api/suggestions")).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/suggestions" })).statusCode).toBe(401);
    expect((await call("m.diaz", "GET", "/api/today")).json().suggestions).toBeNull();
    expect((await call("s.grant", "GET", "/api/today")).json().suggestions).toBeNull();
    expect((await call("k.patel", "GET", "/api/today")).json().suggestions.open).toBeGreaterThan(0);
    const q = (await call("m.diaz", "GET", "/api/rx")).json();
    expect(q.every((r: any) => r.suggestions === undefined)).toBe(true);
    expect((await call("k.patel", "GET", "/api/rx")).json().some((r: any) => r.suggestions > 0)).toBe(true);
  });

  it("decide, enable, disable and run-now role matrix", async () => {
    const id = listSuggestions(ctx, { status: "open" }).find((s) => s.source === "rule")!.id;
    for (const who of ["k.patel", "m.diaz", "s.grant"]) {
      expect((await call(who, "POST", `/api/suggestions/${id}/accept`, {})).statusCode, `accept ${who}`).toBe(403);
      expect((await call(who, "POST", `/api/suggestions/${id}/dismiss`, { reason: "no reason given here" })).statusCode, `dismiss ${who}`).toBe(403);
      expect((await call(who, "POST", `/api/suggestions/${id}/change-request`, {})).statusCode, `change ${who}`).toBe(403);
    }
    for (const who of ["k.patel", "m.diaz"]) {
      expect((await call(who, "POST", "/api/agents/rx-guardian/enable")).statusCode, `enable ${who}`).toBe(403);
      expect((await call(who, "POST", "/api/agents/rx-guardian/disable")).statusCode, `disable ${who}`).toBe(403);
    }
    for (const who of ["k.patel", "m.diaz", "s.grant"]) expect((await call(who, "POST", "/api/agents/rx-guardian/run-now")).statusCode, `run-now ${who}`).toBe(403);
    expect((await call("s.grant", "POST", "/api/agents/rx-guardian/disable")).statusCode).toBe(200);
    expect(backgroundStatus(ctx).find((s) => s.id === "rx-guardian")!.enabled).toBe(false);
    expect((await call("j.rivera", "POST", "/api/agents/rx-guardian/enable")).statusCode).toBe(200);
    expect(backgroundStatus(ctx).find((s) => s.id === "rx-guardian")!.enabled).toBe(true);
    expect((await call("j.rivera", "POST", "/api/agents/coroner/enable")).statusCode).toBe(422); // no background mode
    expect((await call("j.rivera", "GET", "/api/agents")).json().background.on).toBeGreaterThan(0);
    expect(ctx.db.get("SELECT 1 FROM audit WHERE action = 'agent.disable' AND entity_id = 'rx-guardian'")).toBeTruthy();
    expect(ctx.db.get("SELECT 1 FROM audit WHERE action = 'agent.enable' AND entity_id = 'rx-guardian'")).toBeTruthy();
    expect(ctx.db.get("SELECT 1 FROM audit WHERE action = 'agent.run_now'")).toBeTruthy();
    expect(setEnabled).toBeTypeOf("function");
  });

  it("accept puts the order on hold with the reason; the fill is refused; dismiss needs a reason; a change request uses the existing path", async () => {
    await runAgent(ctx, pharmacist, "rx-guardian", {});
    const open = listSuggestions(ctx, { rx: "0072210", status: "open" });
    expect(open.length).toBeGreaterThan(2);
    const a = open[0]!;
    const res = await call("j.rivera", "POST", `/api/suggestions/${a.id}/accept`, { note: "Hold until I speak to the prescriber." });
    expect(res.statusCode).toBe(200);
    expect(res.json().review).toBe("on_hold");
    const rx = db.get<any>("SELECT review, review_note, status FROM prescriptions WHERE rx = '0072210'")!;
    expect(rx.review).toBe("on_hold");
    expect(rx.review_note).toMatch(/Rx Guardian/);
    expect(rx.status).toBe("to_fill");
    const scan = await call("j.rivera", "POST", "/api/rx/0072210/scan", { raw: "x" });
    expect(scan.statusCode).toBe(409);
    expect(scan.json().code).toBe("needs_review");
    expect((await call("j.rivera", "POST", `/api/suggestions/${a.id}/accept`, {})).statusCode).toBe(409); // already decided

    const b = open[1]!;
    expect((await call("j.rivera", "POST", `/api/suggestions/${b.id}/dismiss`, { reason: "no" })).statusCode).toBe(422);
    expect((await call("j.rivera", "POST", `/api/suggestions/${b.id}/dismiss`, { reason: "Prescriber already confirmed the days supply." })).statusCode).toBe(200);
    expect(listSuggestions(ctx, { status: "dismissed" }).some((s) => s.id === b.id && s.decisionReason)).toBe(true);

    // a change request on a different order: the existing prescriber message path runs and the order goes on hold
    db.run("INSERT INTO suggestions (patient_id, rx, severity, rule, skey, fp, title, evidence, explanation, explained_by, status, agent, ai_advisory, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      "S-0448", "0072214", "needs_review", "sig-mismatch", "sig-mismatch|test", "fp-test", "Directions and days supply disagree", JSON.stringify([{ text: "2026-11-18: test fact", date: TODAY }]), "Test explanation.", "rules", "open", "rx-guardian", 1, "rule", NOW);
    const cid = db.get<{ id: number }>("SELECT id FROM suggestions WHERE skey = 'sig-mismatch|test'")!.id;
    const cr = await call("j.rivera", "POST", `/api/suggestions/${cid}/change-request`, {});
    expect(cr.statusCode).toBe(200);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM prescriber_messages WHERE rx = '0072214'")!.n).toBe(1);
    expect(db.get<any>("SELECT review FROM prescriptions WHERE rx = '0072214'")!.review).toBe("on_hold");
    expect(listSuggestions(ctx, { status: "accepted" }).find((s) => s.id === cid)!.decisionReason ?? null).toBeNull();
    expect(db.get<any>("SELECT decision FROM suggestions WHERE id = ?", cid)!.decision).toBe("change_request");

    for (const action of ["suggestion.accept", "suggestion.dismiss", "suggestion.change_request", "suggestion.raised"]) expect(db.get("SELECT 1 FROM audit WHERE action = ?", action), action).toBeTruthy();
    expect(verifyAuditChain(ctx).ok).toBe(true);
  });
});

// ------------------------------------------------------------------ the scenario

describe("scenario: Agent catches it", () => {
  it("the new insulin order gets a recalled-lot, an interaction and a non-adherence suggestion; Run now makes the Today card update", async () => {
    const cfg = loadConfig({}, { sqlitePath: ":memory:", sandboxDelayMs: 20, today: TODAY, nightWatch: false, assetsDir: "/nonexistent", webDist: "/nonexistent" });
    const db2 = new Db(":memory:");
    const rt2 = new AgentRuntime({ LLM_PROVIDER: "mock" });
    const c2: Ctx = { cfg, db: db2, notify: new SandboxNotifier(db2, cfg), now: () => NOW, agents: rt2 };
    seedDatabase(db2, cfg, NOW);
    await ingestFaxInbox(c2);
    const app2 = await buildApp(c2);
    const pharmacist = { id: "u-jrivera", name: "J. Rivera", role: "pharmacist" as const, storeId: "store-7", workstation: "test" };
    await resetDemo(c2, pharmacist, "agent-catches-it"); // in-process fixture; the product has no scenario route
    const ck2 = (await app2.inject({ method: "POST", url: "/api/auth/login", payload: { storeId: "store-7", email: "j.rivera@elmstreetrx.example", password: PW, trusted: true } })).cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const before = (await app2.inject({ url: "/api/today", headers: { cookie: ck2 } })).json();
    expect(before.agentsOn).toBeGreaterThan(0); // the Guardian is on after the reset (demo seed)
    expect(db2.get<any>("SELECT review FROM prescriptions WHERE rx = '0072301'")).toBeTruthy();
    expect(listSuggestions(c2, { rx: "0072301" })).toEqual([]); // not raised yet: the order has just arrived
    const run = await app2.inject({ method: "POST", url: "/api/agents/rx-guardian/run-now", headers: { cookie: ck2 } });
    expect(run.statusCode).toBe(200);
    const rules = listSuggestions(c2, { rx: "0072301" }).filter((s) => s.source === "rule").map((s) => s.rule);
    expect(rules).toEqual(expect.arrayContaining(["recalled-lot", "interaction", "non-adherence"]));
    const after = (await app2.inject({ url: "/api/today", headers: { cookie: ck2 } })).json();
    expect(after.suggestions.open).toBeGreaterThanOrEqual(3);
    expect(after.suggestions.top.length).toBe(3);
  }, 60_000);
});
