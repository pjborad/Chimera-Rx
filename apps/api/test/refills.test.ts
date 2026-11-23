import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { FastifyInstance } from "fastify";
import { buildApp, Db, ingestFaxInbox, loadConfig, SandboxNotifier, seedDatabase, type Ctx } from "../src/index";
import { resetDemo } from "./scenario-fixtures";
import { AgentRuntime, draftQueue, refillDraftProblem, runAgent, type ProviderClient } from "../src/agents";
import { addDays, pdc, refillReport, syncSuggestions, PDC_FLAG_BELOW } from "../src/refills";
import type { Actor } from "../src/core";

// Recall-aware refills and adherence: PDC, due dates, sync, the recalled-lot block, Schedule II, roles and the Refill Outreach agent.

const PW = "moonlight-rx-2026";
const TODAY = "2026-11-18";
const NOW = Date.parse("2026-11-18T18:00:00Z");
process.env.OFFLINE = "1";

interface Rig { ctx: Ctx; app: FastifyInstance; rt: AgentRuntime; call: (who: string, method: "GET" | "POST", url: string, payload?: unknown) => Promise<Awaited<ReturnType<FastifyInstance["inject"]>>>; pharmacist: Actor; technician: Actor }

async function rig(scenario: string | null): Promise<Rig> {
  const cfg = loadConfig({}, { sqlitePath: ":memory:", sandboxDelayMs: 20, today: TODAY, nightWatch: false, assetsDir: "/nonexistent", webDist: "/nonexistent" });
  const db = new Db(":memory:");
  const rt = new AgentRuntime({ LLM_PROVIDER: "mock" });
  const ctx: Ctx = { cfg, db, notify: new SandboxNotifier(db, cfg), now: () => NOW, agents: rt };
  seedDatabase(db, cfg, NOW);
  await ingestFaxInbox(ctx);
  if (scenario) await resetDemo(ctx, null, scenario);
  const app = await buildApp(ctx);
  const actorOf = (role: string): Actor => {
    const u = db.get<any>("SELECT * FROM users WHERE role = ? ORDER BY id LIMIT 1", role)!;
    return { id: u.id, name: u.name, role: u.role, storeId: u.store_id, workstation: "test" };
  };
  const cookies: Record<string, string> = {};
  for (const who of ["j.rivera", "k.patel", "m.diaz"]) {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { storeId: "store-7", email: `${who}@elmstreetrx.example`, password: PW, trusted: true } });
    cookies[who] = r.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }
  const call = (who: string, method: "GET" | "POST", url: string, payload?: unknown) => app.inject({ method, url, payload: payload as never, headers: { cookie: cookies[who]! } });
  return { ctx, app, rt, call, pharmacist: actorOf("pharmacist"), technician: actorOf("technician") };
}

const liar = (fn: (agent: string) => string): ProviderClient => ({ id: "mock", name: "liar", model: "liar-1", complete: async (system: string) => fn(/^AGENT:([\w-]+)/m.exec(system)?.[1] ?? "") });

describe("PDC (proportion of days covered)", () => {
  it("is exact on a worked example", () => {
    // Window starts at the first fill (Aug 20, 91 days to Nov 18). 30-day supplies on Aug 20, Sep 19 and Oct 19 cover Aug 20 to Nov 17: 90 days. Nov 18 is uncovered.
    const m = pdc([{ filledOn: "2026-08-20", daysSupply: 30 }, { filledOn: "2026-09-19", daysSupply: 30 }, { filledOn: "2026-10-19", daysSupply: 30 }], TODAY);
    expect(m.windowDays).toBe(91);
    expect(m.coveredDays).toBe(90);
    expect(m.pdc).toBeCloseTo(90 / 91, 10);
    expect(m.supplyEndsOn).toBe("2026-11-18");
  });

  it("carries an early pickup forward instead of counting the same day twice", () => {
    const m = pdc([{ filledOn: "2026-10-01", daysSupply: 30 }, { filledOn: "2026-10-10", daysSupply: 30 }], TODAY);
    expect(m.supplyEndsOn).toBe("2026-11-30"); // second supply starts Oct 31, not Oct 10
    expect(m.coveredDays).toBe(m.windowDays);
    expect(m.pdc).toBe(1);
  });

  it("a gap lowers it, and below 0.80 is the flag line", () => {
    const m = pdc([{ filledOn: "2026-05-22", daysSupply: 30 }, { filledOn: "2026-07-01", daysSupply: 30 }, { filledOn: "2026-09-19", daysSupply: 30 }], TODAY);
    expect(m.windowDays).toBe(180);
    expect(m.coveredDays).toBe(89);
    expect(m.pdc).toBeLessThan(PDC_FLAG_BELOW);
  });

  const fills = fc.array(fc.record({ ago: fc.integer({ min: 0, max: 400 }), days: fc.integer({ min: 1, max: 120 }) }), { minLength: 1, maxLength: 12 });
  const asFills = (xs: { ago: number; days: number }[]) => xs.map((x) => ({ filledOn: addDays(TODAY, -x.ago), daysSupply: x.days }));

  it("property: always between 0 and 1, and covered days never exceed the window", () => {
    fc.assert(fc.property(fills, (xs) => {
      const m = pdc(asFills(xs), TODAY);
      return m.pdc >= 0 && m.pdc <= 1 && m.coveredDays <= m.windowDays && m.coveredDays >= 0;
    }), { numRuns: 300 });
  });

  it("property: more days of supply never lowers it", () => {
    fc.assert(fc.property(fills, fc.nat(11), fc.integer({ min: 1, max: 60 }), (xs, i, extra) => {
      const idx = i % xs.length;
      const more = xs.map((x, k) => (k === idx ? { ...x, days: x.days + extra } : x));
      return pdc(asFills(more), TODAY).pdc >= pdc(asFills(xs), TODAY).pdc - 1e-12;
    }), { numRuns: 300 });
  });

  it("property: adding a fill on or after the first fill never lowers it", () => {
    fc.assert(fc.property(fills, fc.nat(400), fc.integer({ min: 1, max: 90 }), (xs, pick, days) => {
      const oldest = Math.max(...xs.map((x) => x.ago));
      const ago = pick % (oldest + 1);
      return pdc([...asFills(xs), { filledOn: addDays(TODAY, -ago), daysSupply: days }], TODAY).pdc >= pdc(asFills(xs), TODAY).pdc - 1e-12;
    }), { numRuns: 300 });
  });

  it("ignores fills dated in the future", () => {
    expect(pdc([{ filledOn: "2026-12-30", daysSupply: 30 }], TODAY).fills).toBe(0);
  });
});

describe("worklist, adherence and sync (scenario data, today is 2026-11-18)", () => {
  let r: Rig;
  beforeAll(async () => { r = await rig("recall-aware-refill"); }, 60_000);
  const row = (rep: ReturnType<typeof refillReport>, patientId: string, drug: string) => rep.worklist.find((w) => w.patientId === patientId && w.drug.startsWith(drug));

  it("computes due dates from the last fill, days supply and the grace window", () => {
    const rep = refillReport(r.ctx);
    const lis = row(rep, "S-0423", "Lisinopril")!; // 2026-10-14 + 30 = 2026-11-13: 5 days ago, inside the 7-day grace
    expect(lis.dueOn).toBe("2026-11-13");
    expect(lis.daysUntilDue).toBe(-5);
    expect(lis.state).toBe("due");
    expect(refillReport(r.ctx, { graceDays: 3 }).worklist.find((w) => w.patientId === "S-0423" && w.drug.startsWith("Lisinopril"))!.state).toBe("overdue");
    const atv = row(rep, "S-0519", "Atorvastatin")!; // supply ended 30 days ago
    expect(atv.state).toBe("overdue");
    // a fill that still has plenty of supply is not on the worklist; one that runs out inside the lookahead is "upcoming"
    expect(row(rep, "S-0502", "Sertraline")).toBeUndefined();
    const wide = refillReport(r.ctx, { lookaheadDays: 20 });
    expect(wide.worklist.find((w) => w.patientId === "S-0502" && w.drug.startsWith("Sertraline"))!.state).toBe("upcoming");
  });

  it("flags low adherence below 80 percent and says when there is too little history", () => {
    const rep = refillReport(r.ctx);
    const t = rep.adherence.find((a) => a.patientId === "S-0519")!;
    expect(t.pdc).toBeLessThan(0.8);
    expect(t.flagged).toBe(true);
    const single = rep.adherence.find((a) => a.patientId === "S-0423" && a.drug.startsWith("Oxycodone"))!;
    expect(single.enoughHistory).toBe(false);
    expect(single.flagged).toBe(false);
    expect(rep.counts.lowAdherence).toBeGreaterThanOrEqual(1);
  });

  it("suggests one pickup day with short fills for the drugs that run out later", () => {
    const g = refillReport(r.ctx).sync.find((s) => s.patientId === "S-0502")!;
    expect(g.pickupOn).toBe(TODAY); // lisinopril ran out Nov 15, so pickup is today
    const byDrug = Object.fromEntries(g.items.map((i) => [i.drug, i]));
    expect(byDrug["Lisinopril 10 mg"]).toMatchObject({ kind: "full", fillDays: 30 });
    expect(byDrug["Amlodipine 5 mg"]).toMatchObject({ kind: "short", fillDays: 20 }); // runs out Nov 28; common end is Dec 18
    expect(byDrug["Sertraline 50 mg"]).toMatchObject({ kind: "short", fillDays: 14 }); // runs out Dec 4
    expect(g.note).toContain("short fill");
  });

  it("sync maths on a plain example", () => {
    const s = syncSuggestions([
      { patientId: "S-1", patientName: "A", drug: "X", dueOn: "2026-11-20" }, { patientId: "S-1", patientName: "A", drug: "Y", dueOn: "2026-11-28" },
      { patientId: "S-2", patientName: "B", drug: "Z", dueOn: "2026-11-28" }
    ], TODAY);
    expect(s).toHaveLength(1); // a patient with one drug needs no sync
    expect(s[0]!.pickupOn).toBe("2026-11-20");
    expect(s[0]!.items.find((i) => i.drug === "Y")).toMatchObject({ kind: "short", fillDays: 22 }); // Nov 20 + 30 = Dec 20; Y runs out Nov 28
  });

  it("Schedule II is never offered: it shows as needing a new prescription", () => {
    const o = row(refillReport(r.ctx, { lookaheadDays: 10 }), "S-0423", "Oxycodone")!;
    expect(o.scheduleII).toBe(true);
    expect(o.action).toBe("needs_new_rx");
    expect(o.eligible).toBe(false);
    expect(o.actionText).toMatch(/new prescription/i);
    expect(refillReport(r.ctx).sync.flatMap((s) => s.items).some((i) => /Oxycodone/.test(i.drug))).toBe(false);
  });
});

describe("a recalled lot blocks the refill and stays blocked", () => {
  let r: Rig;
  beforeAll(async () => { r = await rig("recall-aware-refill"); }, 60_000);
  const insulin = () => refillReport(r.ctx).worklist.find((w) => w.patientId === "S-0490" && w.drug.startsWith("Insulin"))!;

  it("offers the refill before any recall", () => {
    expect(insulin().action).toBe("offer");
    expect(insulin().block).toBeNull();
  });

  it("blocks it, with a link to the recall, once the lot is confirmed recalled", async () => {
    const l = await r.call("j.rivera", "POST", "/api/recalls/lookup", { number: "D-0611-2026" });
    expect(l.statusCode).toBe(200);
    const i = insulin();
    expect(i.action).toBe("blocked_recall");
    expect(i.eligible).toBe(false);
    expect(i.block).toMatchObject({ blocked: true, lot: "GX4471C", recallId: "D-0611-2026" });
    expect(i.actionText).toContain("D-0611-2026");
    expect(refillReport(r.ctx).sync.flatMap((s) => s.items).some((x) => /Insulin/.test(x.drug))).toBe(false);
    expect(refillReport(r.ctx).counts.blocked).toBeGreaterThanOrEqual(1);
  });

  it("stays blocked after the recall is closed (rule 8)", async () => {
    expect((await r.call("j.rivera", "POST", "/api/recalls/D-0611-2026/close")).statusCode).toBe(200);
    expect(r.ctx.db.get<{ status: string }>("SELECT status FROM recalls WHERE id = 'D-0611-2026'")!.status).toBe("closed");
    expect(insulin().action).toBe("blocked_recall");
  });

  it("gets no reminder drafted, and a draft made earlier is refused at send time", async () => {
    const x = await rig("recall-aware-refill");
    x.ctx.db.run("DELETE FROM med_history WHERE patient_id = 'S-0490' AND drug LIKE 'Metformin%'"); // leave her with the insulin only
    const first = await x.call("j.rivera", "POST", "/api/refills/draft", {});
    expect(first.statusCode).toBe(200);
    expect(first.json().drafts.some((d: any) => d.patientId === "S-0490")).toBe(true); // offered before the recall
    await x.call("j.rivera", "POST", "/api/recalls/lookup", { number: "D-0611-2026" });
    const sent = await x.call("j.rivera", "POST", "/api/refills/send", { attest: true });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().skipped.some((s: any) => s.patientId === "S-0490")).toBe(true);
    expect(x.ctx.db.all("SELECT 1 FROM notifications WHERE recall_id = 'REFILL' AND patient_id = 'S-0490'")).toHaveLength(0);
    const again = await x.call("j.rivera", "POST", "/api/refills/draft", {});
    expect(again.json().drafts.some((d: any) => d.patientId === "S-0490")).toBe(false);
  }, 60_000);
});

describe("routes and roles", () => {
  let r: Rig;
  beforeAll(async () => { r = await rig("recall-aware-refill"); }, 60_000);

  it("a cashier gets 403 everywhere; a technician sees and drafts but cannot send", async () => {
    for (const [m, u] of [["GET", "/api/refills"], ["GET", "/api/refills/drafts"], ["POST", "/api/refills/draft"], ["POST", "/api/refills/send"]] as const) {
      expect((await r.call("m.diaz", m, u, m === "POST" ? { attest: true } : undefined)).statusCode).toBe(403);
    }
    const list = await r.call("k.patel", "GET", "/api/refills");
    expect(list.statusCode).toBe(200);
    expect(list.json().canSend).toBe(false);
    expect((await r.call("k.patel", "POST", "/api/refills/draft", {})).statusCode).toBe(200);
    expect((await r.call("k.patel", "POST", "/api/refills/send", { attest: true })).statusCode).toBe(403);
  });

  it("GET /api/refills returns the worklist, adherence and sync", async () => {
    const j = (await r.call("j.rivera", "GET", "/api/refills?grace=10&lookahead=3")).json();
    expect(j).toMatchObject({ today: TODAY, graceDays: 10, lookaheadDays: 3 });
    expect(j.worklist.length).toBeGreaterThan(0);
    expect(j.adherence.length).toBeGreaterThan(0);
    expect(Array.isArray(j.sync)).toBe(true);
    expect((await r.call("j.rivera", "GET", "/api/refills?grace=999")).statusCode).toBe(422);
  });

  it("audits every draft and every send a person starts", async () => {
    await r.call("j.rivera", "POST", "/api/refills/draft", {});
    expect(r.ctx.db.all("SELECT 1 FROM audit WHERE action = 'refill.draft'").length).toBeGreaterThan(0);
    const send = await r.call("j.rivera", "POST", "/api/refills/send", { attest: true });
    expect(send.statusCode).toBe(200);
    expect(r.ctx.db.all("SELECT 1 FROM audit WHERE action = 'refill.send'")).toHaveLength(1);
  });
});

describe("Refill Outreach agent", () => {
  let r: Rig;
  beforeAll(async () => { r = await rig("recall-aware-refill"); }, 60_000);
  afterEach(() => { r.rt.inject(undefined); r.rt.update({ provider: "mock" }); });
  const run = (provider?: string) => { if (provider) r.rt.update({ provider: provider as any }); return runAgent(r.ctx, r.pharmacist, "refill-outreach", {}); };

  it("works under mock: AI wording passes the gate, drafts are queued and nothing is sent", async () => {
    const rec = await run("mock");
    expect(rec.mode).toBe("ai");
    expect((rec.gatedOutput as any).source.sms).toBe("ai");
    expect((rec.extra as any).sent).toBe(false);
    expect(r.ctx.db.all("SELECT 1 FROM outbox")).toHaveLength(0);
    expect(r.ctx.db.all("SELECT 1 FROM notifications WHERE recall_id = 'REFILL'")).toHaveLength(0);
    const q = draftQueue(r.ctx, "REFILL");
    expect(q.length).toBeGreaterThan(0);
    for (const d of q.filter((x) => x.channel === "sms")) {
      expect(d.text).toContain("(555) 010-2200");
      expect(d.text).toMatch(/STOP/);
      expect(d.text).not.toMatch(/\{\w+\}/);
    }
    expect(q.some((d) => d.patientId === "S-0423" && /Oxycodone/i.test(d.text))).toBe(false);
  });

  it("works under none: the approved templates are used and the run says rules only", async () => {
    const rec = await run("none");
    expect(rec.mode).toBe("rules only");
    expect((rec.gatedOutput as any).source).toEqual({ sms: "rules", emailSubject: "rules", emailBody: "rules", voicemail: "rules" });
    expect(draftQueue(r.ctx, "REFILL").length).toBeGreaterThan(0);
  });

  it("the prompt carries patient ids and counts only", async () => {
    const rec = await run("mock");
    expect(rec.input).toMatch(/S-0\d{3}/);
    expect(rec.input).not.toMatch(/Priya|Natarajan|Okafor|example\.com|\(555\)|Lisinopril|Metformin|Atorvastatin/i);
  });

  it("a lying provider cannot make a draft name another patient, a voicemail name the medicine, or a text drop the phone and STOP", async () => {
    r.rt.inject(liar(() => JSON.stringify({
      sms: "Hi {first_name}, Maria Alvarez and Priya also need a refill. Call us.",
      emailSubject: "Refill for Okafor",
      emailBody: "Dear {first_name}, James Okafor's refill is due. Call {pharmacy_phone}.",
      voicemail: "Hello {first_name}, your Lisinopril refill is ready. Please call {pharmacy_phone}, again {pharmacy_phone}. It is not an emergency, thank you for choosing us."
    })));
    const rec = await runAgent(r.ctx, r.pharmacist, "refill-outreach", {});
    const g = rec.gatedOutput as any;
    expect(g.source).toEqual({ sms: "rules", emailSubject: "rules", emailBody: "rules", voicemail: "rules" });
    expect(rec.dropped.map((d) => d.what)).toEqual(expect.arrayContaining(["sms", "emailBody", "voicemail"]));
    const everyone = r.ctx.db.all<{ name: string }>("SELECT name FROM patients").flatMap((p) => p.name.split(" "));
    for (const d of draftQueue(r.ctx, "REFILL")) {
      const own = r.ctx.db.get<{ name: string }>("SELECT name FROM patients WHERE id = ?", d.patientId)!.name.split(" ");
      for (const part of everyone.filter((x) => x.length >= 4 && !own.includes(x))) expect(`${d.subject ?? ""} ${d.text}`).not.toContain(part);
      if (d.channel === "voicemail") expect(d.text).not.toMatch(/lisinopril|metformin|atorvastatin|insulin|sertraline|amlodipine/i);
      if (d.channel === "sms") { expect(d.text).toContain("(555) 010-2200"); expect(d.text).toMatch(/\bSTOP\b/); }
    }
  });

  it("the final per-draft gate drops each kind of bad draft", () => {
    const ok = { patientId: "S-0502", channel: "sms" as const, subject: null, text: "Elm Street Pharmacy: your refill is due. Call (555) 010-2200. Reply STOP to opt out." };
    expect(refillDraftProblem(r.ctx, ok, ["Lisinopril 10 mg"])).toBeNull();
    expect(refillDraftProblem(r.ctx, { ...ok, text: "Hi, Priya's refill is due. Call (555) 010-2200. Reply STOP." }, [])).toMatch(/another patient/i);
    expect(refillDraftProblem(r.ctx, { ...ok, text: "Your refill is due. Reply STOP to opt out." }, [])).toMatch(/phone/i);
    expect(refillDraftProblem(r.ctx, { ...ok, text: "Your refill is due. Call (555) 010-2200." }, [])).toMatch(/STOP/);
    const vm = { patientId: "S-0502", channel: "voicemail" as const, subject: null, text: "Hello, your Lisinopril is ready. Call 5 5 5, 0 1 0, 2 2 0 0." };
    expect(refillDraftProblem(r.ctx, vm, ["Lisinopril 10 mg"])).toMatch(/medicine/i);
  });

  it("sends only after attestation, and checks consent at send time", async () => {
    await run("mock");
    const no = await r.call("j.rivera", "POST", "/api/refills/send", { attest: false });
    expect(no.statusCode).toBe(422);
    expect(no.json().code).toBe("attest");
    expect(r.ctx.db.all("SELECT 1 FROM outbox")).toHaveLength(0);
    // Grace Miller (email only) withdraws email consent after the draft was made
    r.ctx.db.run("UPDATE patients SET email_consent = 0 WHERE id = 'S-0502'");
    const yes = await r.call("j.rivera", "POST", "/api/refills/send", { attest: true });
    expect(yes.statusCode).toBe(200);
    const j = yes.json();
    expect(j.sent).toBeGreaterThan(0);
    expect(j.skipped.some((s: any) => s.patientId === "S-0502" && /consent/i.test(s.why))).toBe(true);
    const out = r.ctx.db.all<{ to_addr: string; provider: string }>("SELECT to_addr, provider FROM outbox");
    expect(out.length).toBe(j.sent);
    expect(out.every((o) => o.provider === "sandbox")).toBe(true);
    expect(out.some((o) => /s-0502|grace/i.test(o.to_addr))).toBe(false);
    // sending twice does not send twice
    expect((await r.call("j.rivera", "POST", "/api/refills/send", { attest: true })).statusCode).toBe(409);
  });
});

describe("AI draft in the recall send flow", () => {
  it("the Recall Outreach Drafter's templates can be loaded, and the send flow still requires attestation", async () => {
    const r = await rig("class1-recall");
    expect((await r.call("j.rivera", "POST", "/api/recalls/lookup", { number: "D-0611-2026" })).statusCode).toBe(200);
    const run = (await r.call("j.rivera", "POST", "/api/agents/outreach-drafter/run", { input: { recallId: "D-0611-2026" } })).json().run;
    const t = run.gatedOutput.templates;
    const tpl = { sms: t.sms.replace(/\{pharmacy_phone\}/g, "(555) 010-2200"), emailSubject: t.emailSubject, emailBody: t.emailBody.replace(/\{pharmacy_phone\}/g, "(555) 010-2200") };
    const msgs = (await r.call("j.rivera", "GET", "/api/recalls/D-0611-2026/messages")).json();
    expect(msgs.fields.pharmacy_phone).toBe("(555) 010-2200"); // the screen substitutes this into the AI draft before it is shown
    const no = await r.call("j.rivera", "POST", "/api/recalls/D-0611-2026/notifications", { ...tpl, attest: false });
    expect(no.statusCode).toBe(422);
    expect(no.json().code).toBe("attest");
    expect(r.ctx.db.all("SELECT 1 FROM outbox")).toHaveLength(0);
    expect(r.ctx.db.get<{ status: string }>("SELECT status FROM recalls WHERE id = 'D-0611-2026'")!.status).not.toBe("notified");
    expect((await r.call("k.patel", "POST", "/api/recalls/D-0611-2026/notifications", { ...tpl, attest: true })).statusCode).toBe(403);
    const yes = await r.call("j.rivera", "POST", "/api/recalls/D-0611-2026/notifications", { ...tpl, attest: true });
    expect(yes.statusCode).toBe(200);
    expect(r.ctx.db.all("SELECT 1 FROM outbox").length).toBeGreaterThan(0);
  }, 60_000);
});
