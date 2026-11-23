/** REV-F01 / REV-F04 and two Rx review wording defects (independent review of 30408a6). Synthetic in-memory databases only. */
import { afterEach, describe, expect, it } from "vitest";
import { Db, loadConfig, SandboxNotifier, seedDatabase, type Ctx } from "../src/index";
import { AgentRuntime, listSuggestions, MockProvider, runAgent } from "../src/agents";
import { guardianHits, loadHistory, type GuardInput, type Hist } from "../src/agents/guardian";
import { STORE_1 } from "../src/stores";
import { printLabel, scanFill, sell, verifyDispense } from "../src/fill";
import { type Actor } from "../src/core";
import { decide, respond } from "../src/prescriber";
import { reviewRx, runRules, modelSummaryAcceptable } from "../src/rxwatcher";
import { currentMedicines, refillReport, SUPPLY_GRACE_DAYS } from "../src/refills";

const NOW = Date.parse("2026-11-22T18:00:00Z");
const TODAY = "2026-11-22";
const actor: Actor = { id: "u-rivera", name: "J. Rivera, PharmD", role: "pharmacist", storeId: STORE_1, workstation: "review fix B" };
process.env.OFFLINE = "1";
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

function rig(provider: "none" | "mock" = "none") {
  const cfg = loadConfig({}, { sqlitePath: ":memory:", today: TODAY, nightWatch: false, sandboxDelayMs: 1, webDist: "/nonexistent", assetsDir: "/nonexistent" });
  const db = new Db(":memory:");
  const ctx: Ctx = { cfg, db, now: () => NOW, notify: new SandboxNotifier(db, cfg), agents: new AgentRuntime({ LLM_PROVIDER: provider }) };
  seedDatabase(db, cfg, NOW);
  cleanup.push(() => db.raw.close());
  return { ctx, db };
}

const SCAN_0072214 = { fields: { ndc: "70004-803-90", lot: "AT24K118", expiry: "2028-01-31" }, source: "typed" as const };
const reviewOf = (db: Db, rx = "0072214") => db.get<any>("SELECT review FROM prescriptions WHERE rx = ?", rx)!.review as string;
const dispenses = (db: Db, rx = "0072214") => db.get<any>("SELECT COUNT(*) AS n FROM dispenses d JOIN prescriptions r ON r.id = d.rx_id WHERE r.rx = ?", rx)!.n as number;
const auditCount = (db: Db, action: string) => db.get<any>("SELECT COUNT(*) AS n FROM audit WHERE action = ?", action)!.n as number;
const outcomeOf = (p: Promise<unknown>) => p.then(() => "filled", (e) => `blocked:${e.code}`);

/** A model that stays "thinking" until the test releases it; `entered` resolves when `count` calls are waiting. */
function barrier(ctx: Ctx, count = 1) {
  const waiting: ((s: string) => void)[] = [];
  let entered!: () => void;
  const reached = new Promise<void>((r) => (entered = r));
  ctx.llm = { name: "review-barrier", complete: () => new Promise<string>((res) => { waiting.push(res); if (waiting.length >= count) entered(); }) };
  return { reached, release: (s = "{}") => waiting.splice(0).forEach((r) => r(s)) };
}

describe("REV-F01 a human review decision always beats an automatic review", () => {
  it("a slow automatic review cannot overwrite a pharmacist change request, and nothing is filled", async () => {
    const { ctx, db } = rig();
    const m = barrier(ctx);
    db.run("UPDATE prescriptions SET review='none' WHERE rx='0072214'");
    const pending = outcomeOf(scanFill(ctx, actor, "0072214", SCAN_0072214));
    await m.reached;
    decide(ctx, actor, "0072214", { action: "change", message: "Please review this order before filling." });
    expect(reviewOf(db)).toBe("on_hold");
    m.release();
    expect(await pending).toBe("blocked:needs_review");
    expect(reviewOf(db)).toBe("on_hold");
    expect(db.get<any>("SELECT review_note FROM prescriptions WHERE rx='0072214'")!.review_note).toMatch(/Change requested/);
    expect(dispenses(db)).toBe(0);
    expect(db.get<any>("SELECT status FROM prescriptions WHERE rx='0072214'")!.status).toBe("to_fill");
    expect(auditCount(db, "rxwatcher.kept_human_decision")).toBe(1);
    expect(auditCount(db, "fill.refused")).toBe(1);
  });

  it("a rejection during the model wait stays rejected and nothing is filled", async () => {
    const { ctx, db } = rig();
    const m = barrier(ctx);
    db.run("UPDATE prescriptions SET review='none' WHERE rx='0072214'");
    const pending = outcomeOf(scanFill(ctx, actor, "0072214", SCAN_0072214));
    await m.reached;
    decide(ctx, actor, "0072214", { action: "reject", reason: "Prescriber called: wrong patient." });
    m.release();
    expect(await pending).toBe("blocked:needs_review");
    expect(reviewOf(db)).toBe("rejected");
    expect(dispenses(db)).toBe(0);
  });

  it("an approval during the model wait is kept (not turned into clear) and the scan may fill", async () => {
    const { ctx, db } = rig();
    const m = barrier(ctx);
    db.run("UPDATE prescriptions SET review='none' WHERE rx='0072214'");
    const pending = outcomeOf(scanFill(ctx, actor, "0072214", SCAN_0072214));
    await m.reached;
    decide(ctx, actor, "0072214", { action: "approve", reason: "Checked with the prescriber by phone." });
    m.release();
    expect(await pending).toBe("filled");
    expect(reviewOf(db)).toBe("approved");
    expect(dispenses(db)).toBe(1);
  });

  it("two overlapping reviews of one order both lose to a hold that lands while they wait", async () => {
    const { ctx, db } = rig();
    const m = barrier(ctx, 2);
    db.run("UPDATE prescriptions SET review='none' WHERE rx='0072214'");
    const a = reviewRx(ctx, actor, "0072214");
    const b = reviewRx(ctx, actor, "0072214");
    await m.reached;
    decide(ctx, actor, "0072214", { action: "change", message: "Please confirm this order before filling." });
    m.release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.review).toBe("on_hold");
    expect(rb.review).toBe("on_hold");
    expect(reviewOf(db)).toBe("on_hold");
    expect(auditCount(db, "rxwatcher.kept_human_decision")).toBe(2);
  });

  it("two overlapping reviews with no human decision agree and leave one findings set", async () => {
    const { ctx, db } = rig();
    const m = barrier(ctx, 2);
    db.run("UPDATE prescriptions SET review='none' WHERE rx='0072214'");
    const a = reviewRx(ctx, actor, "0072214");
    const b = reviewRx(ctx, actor, "0072214");
    await m.reached;
    m.release();
    await Promise.all([a, b]);
    expect(reviewOf(db)).toBe("clear");
    const n = db.get<any>("SELECT COUNT(DISTINCT run_id) AS n FROM rx_findings WHERE rx='0072214'")!.n;
    expect(n).toBe(1);
  });

  it("an order edited during the wait is refused with review_changed, no dispense, and the refusal is audited", async () => {
    const { ctx, db } = rig();
    const m = barrier(ctx);
    db.run("UPDATE prescriptions SET review='none' WHERE rx='0072214'");
    const pending = outcomeOf(scanFill(ctx, actor, "0072214", SCAN_0072214));
    await m.reached;
    db.run("UPDATE prescriptions SET directions = 'Take 2 tablets by mouth daily' WHERE rx='0072214'");
    m.release();
    expect(await pending).toBe("blocked:review_changed");
    expect(dispenses(db)).toBe(0);
    expect(auditCount(db, "fill.refused")).toBe(1);
  });

  it("an order replaced by a new version during the wait is not filled", async () => {
    const { ctx, db } = rig();
    const m = barrier(ctx);
    db.run("UPDATE prescriptions SET review='none' WHERE rx='0072214'");
    const pending = outcomeOf(scanFill(ctx, actor, "0072214", SCAN_0072214));
    await m.reached;
    db.run("UPDATE prescriptions SET status='replaced', review='replaced' WHERE rx='0072214'");
    m.release();
    expect(await pending).toMatch(/^blocked:/);
    expect(dispenses(db)).toBe(0);
    expect(reviewOf(db)).toBe("replaced");
  });

  it("a hold that lands while the scan itself is parsed (after the review) is caught inside the fill transaction", async () => {
    const { ctx, db } = rig();
    db.run("UPDATE prescriptions SET review='clear' WHERE rx='0072214'");
    const pending = outcomeOf(scanFill(ctx, actor, "0072214", SCAN_0072214)); // runs to its first await, then yields
    decide(ctx, actor, "0072214", { action: "change", message: "Please confirm this order before filling." });
    expect(await pending).toBe("blocked:review_changed");
    expect(reviewOf(db)).toBe("on_hold");
    expect(dispenses(db)).toBe(0);
    expect(auditCount(db, "fill.refused")).toBe(1);
  });

  it("without any human decision the same scan still fills", async () => {
    const { ctx, db } = rig();
    expect(await outcomeOf(scanFill(ctx, actor, "0072214", SCAN_0072214))).toBe("filled");
    expect(dispenses(db)).toBe(1);
  });
});

// ------------------------------------------------------------------ F04

const ago = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const hist = (drug: string, daysAgo: number, days: number, status: string, o: Partial<Hist> = {}): Hist => ({ filled_on: ago(daysAgo), ndc11: "", drug, sig: "As directed", qty: 1, days_supply: days, status, lot: "", prescriber: "Dr. A", ...o });
const CIPRO = { rx: "T1", drug: "Ciprofloxacin 500 mg · 14 tab", ndc11: "", qty: 1, directions: "Take 1 tablet twice daily for 7 days", days_supply: 7, prescriber: "Dr. A" };
const guardInput = (history: Hist[]): GuardInput => ({ today: TODAY, order: CIPRO, product: null, patient: { id: "S-0001", dob: "1975-05-05", allergies: "" }, history, lotBlocked: () => null, priorFlags: { total: 0, accepted: 0 } });
const INSULIN = "Insulin glargine 100 U/mL · 5 pens";

describe("REV-F04 one definition of a current medicine", () => {
  for (const status of ["Active", "Sold here"]) it(`the Guardian interaction rule includes a current "${status}" medicine`, () => {
    expect(guardianHits(guardInput([hist(INSULIN, 2, 68, status)])).map((h) => h.rule)).toContain("interaction");
  });

  for (const status of ["Active", "Sold here"]) it(`the Rx Watcher interaction rule includes a current "${status}" medicine`, () => {
    const f = runRules({
      rx: { rx: "T2", drug: "Semaglutide 1 mg/dose pen", ndc11: "70004071201", qty: 1, directions: "Inject 1 mg once weekly", days_supply: 28 },
      product: { name: "Semaglutide 1 mg/dose pen", pack_size: "1 pen" }, patient: { allergies: "" },
      history: [hist(INSULIN, 2, 68, status)], today: TODAY
    });
    expect(f.some((x) => x.rule === "interaction" && x.severity === "needs_review")).toBe(true);
  });

  it("an expired supply does not count (past the documented grace window), a supply inside the grace window does", () => {
    expect(guardianHits(guardInput([hist(INSULIN, 200, 30, "Sold here")])).map((h) => h.rule)).not.toContain("interaction");
    expect(guardianHits(guardInput([hist(INSULIN, 30 + SUPPLY_GRACE_DAYS + 1, 30, "Active")])).map((h) => h.rule)).not.toContain("interaction");
    expect(guardianHits(guardInput([hist(INSULIN, 30 + SUPPLY_GRACE_DAYS, 30, "Active")])).map((h) => h.rule)).toContain("interaction");
  });

  it("a discontinued, completed or replaced medicine never counts, however recent", () => {
    for (const status of ["Discontinued", "Completed", "Replaced", "Stopped"]) {
      expect(guardianHits(guardInput([hist(INSULIN, 2, 68, status)])).map((h) => h.rule), status).not.toContain("interaction");
    }
  });

  it("the same fill in the imported history and in the sale record counts once", () => {
    const both = [hist(INSULIN, 2, 68, "Active", { lot: "L1" }), hist(INSULIN, 2, 68, "Sold here", { lot: "L1" })];
    expect(currentMedicines(both, TODAY)).toHaveLength(1);
    expect(guardianHits(guardInput(both)).filter((h) => h.rule === "interaction")).toHaveLength(1);
    // an unrelated second fill on another day is still its own fill
    expect(currentMedicines([...both, hist(INSULIN, 40, 68, "Active")], TODAY)).toHaveLength(2);
  });

  it("an unknown days supply is assumed 30 days, for Active and Sold here alike", () => {
    for (const status of ["Active", "Sold here"]) {
      expect(currentMedicines([hist(INSULIN, 10, 0, status)], TODAY), status).toHaveLength(1);
      expect(currentMedicines([hist(INSULIN, 100, 0, status)], TODAY), status).toHaveLength(0);
    }
  });

  /** Receive-free end to end: fill, verify and sell an unseeded medicine here, then write the next order. */
  const addPatient = (db: Db) => db.run("INSERT INTO patients (id, name, dob, phone, email, preferred, allergies) VALUES ('S-9001','Test Patient','1970-01-01','','','sms','')");
  const ndc11 = (db: Db, ndc10: string) => db.get<any>("SELECT ndc11 FROM products WHERE ndc10 = ?", ndc10)!.ndc11 as string;
  const addOrder = (db: Db, rx: string, drug: string, ndc: string, directions: string, days: number, review = "none") =>
    db.run("INSERT INTO prescriptions (rx, patient_id, ndc11, drug, qty, directions, prescriber, refills, status, due, days_supply, review) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rx, "S-9001", ndc, drug, 1, directions, "Dr. A. Nwosu", 1, "to_fill", "today", days, review);
  async function sellInsulin(ctx: Ctx, db: Db, rx: string) {
    const out = await scanFill(ctx, actor, rx, { fields: { ndc: "70004-623-15", lot: "GX4471C", expiry: "2027-08-31" }, source: "typed" });
    printLabel(ctx, actor, out.dispenseId);
    verifyDispense(ctx, actor, out.dispenseId, [true, true, true, true]);
    sell(ctx, actor, out.dispenseId, { idChecked: true, counseled: true, signature: true });
    expect(db.get<any>("SELECT state FROM dispenses WHERE id = ?", out.dispenseId)!.state).toBe("sold");
  }
  const INSULIN_SIG = "Inject 20 units under the skin once daily at bedtime";

  it("end to end: a medicine sold here is current for the next order (Guardian demo table and Rx Watcher)", async () => {
    const { ctx, db } = rig();
    addPatient(db);
    addOrder(db, "T-INS", "Insulin glargine 100 units/mL · 5 × 3 mL pens", ndc11(db, "70004-623-15"), INSULIN_SIG, 68);
    await sellInsulin(ctx, db, "T-INS");
    expect(loadHistory(ctx, "S-9001").map((h) => h.status)).toEqual(["Sold here"]);

    addOrder(db, "T-CIP", "Ciprofloxacin 500 mg · 14 tab", "", "Take 1 tablet twice daily for 7 days", 7, "pending");
    await runAgent(ctx, actor, "rx-guardian", { rx: "T-CIP" });
    const demo = listSuggestions(ctx, { rx: "T-CIP", status: "all" }).find((s) => s.rule === "interaction");
    expect(demo?.title).toMatch(/demo table/);

    addOrder(db, "T-SEMA", "Semaglutide 1 mg/dose pen", ndc11(db, "70004-712-01"), "Inject 1 mg under the skin once weekly", 28);
    const r = await reviewRx(ctx, actor, "T-SEMA");
    expect(r.findings.some((f) => f.rule === "interaction" && f.severity === "needs_review")).toBe(true);
    expect(r.review).toBe("pending");
  });

  it("end to end: a sale whose supply has long run out does not raise the interaction", async () => {
    const { ctx, db } = rig();
    addPatient(db);
    addOrder(db, "T-INS", "Insulin glargine 100 units/mL · 5 × 3 mL pens", ndc11(db, "70004-623-15"), INSULIN_SIG, 68);
    await sellInsulin(ctx, db, "T-INS");
    ctx.now = () => NOW + (68 + SUPPLY_GRACE_DAYS + 2) * 86_400_000;
    (ctx.cfg as any).today = new Date(ctx.now()).toISOString().slice(0, 10);
    addOrder(db, "T-SEMA", "Semaglutide 1 mg/dose pen", ndc11(db, "70004-712-01"), "Inject 1 mg under the skin once weekly", 28);
    const r = await reviewRx(ctx, actor, "T-SEMA");
    expect(r.findings.some((f) => f.rule === "interaction")).toBe(false);
  });

  it("end to end: a corrected order (prescriber change) that is sold counts once, and the replaced original does not count", async () => {
    const { ctx, db } = rig();
    addPatient(db);
    addOrder(db, "T-INS", "Insulin glargine 100 units/mL · 5 × 3 mL pens", ndc11(db, "70004-623-15"), "Inject 20 units under the skin every morning and at bedtime", 68);
    const d = decide(ctx, actor, "T-INS", { action: "change", message: "Please confirm the frequency on this order." });
    const out = await respond(ctx, "prescriber sandbox", actor, (d as any).message.id, { response: "approved", directions: INSULIN_SIG, daysSupply: 68 });
    expect(out.newRx).toBe("T-INS-R1");
    expect(db.get<any>("SELECT status FROM prescriptions WHERE rx='T-INS'")!.status).toBe("replaced");
    await sellInsulin(ctx, db, "T-INS-R1");
    const h = loadHistory(ctx, "S-9001");
    expect(h).toHaveLength(1);
    expect(currentMedicines(h, TODAY)).toHaveLength(1);
    addOrder(db, "T-SEMA", "Semaglutide 1 mg/dose pen", ndc11(db, "70004-712-01"), "Inject 1 mg under the skin once weekly", 28);
    const r = await reviewRx(ctx, actor, "T-SEMA");
    expect(r.findings.filter((f) => f.rule === "interaction")).toHaveLength(1);
  });

  it("refills: a medicine sold here that is also in the imported history is one fill and still on the worklist", async () => {
    const { ctx, db } = rig();
    addPatient(db);
    addOrder(db, "T-INS", "Insulin glargine 100 units/mL · 5 × 3 mL pens", ndc11(db, "70004-623-15"), INSULIN_SIG, 68);
    await sellInsulin(ctx, db, "T-INS");
    const key = (r: any) => r.patientId === "S-9001";
    const before = refillReport(ctx, { today: TODAY }).adherence.filter(key);
    expect(before).toHaveLength(1);
    db.run("INSERT INTO med_history (patient_id, filled_on, ndc11, drug, sig, lot, prescriber, qty, days_supply, status, auto_refill, refills_left) VALUES ('S-9001',?,?,?,?,?,?,?,?,?,0,1)", TODAY, ndc11(db, "70004-623-15"), INSULIN, INSULIN_SIG, "GX4471C", "Dr. A", 1, 68, "Active");
    const after = refillReport(ctx, { today: TODAY }).adherence.filter(key);
    expect(after).toHaveLength(1);
    expect(after[0]!.fills).toBe(1);
  });
});

// ------------------------------------------------------------------ wording defects

/** A frequency the label does not allow: one rule hit that needs review. */
const FLAGGED_SIG = "Inject 20 units under the skin three times daily";

describe("Rx Watcher summary never contradicts a rule hit", () => {
  function flaggedOrder(db: Db) {
    db.run("INSERT INTO patients (id, name, dob, phone, email, preferred, allergies) VALUES ('S-9002','Test Patient Two','1970-01-01','','','sms','')");
    const ndc = db.get<any>("SELECT ndc11 FROM products WHERE ndc10 = '70004-623-15'")!.ndc11;
    db.run("INSERT INTO prescriptions (rx, patient_id, ndc11, drug, qty, directions, prescriber, refills, status, due, days_supply, review) VALUES ('T-FLAG','S-9002',?,?,1,?,'Dr. A. Nwosu',1,'to_fill','today',68,'none')", ndc, "Insulin glargine 100 units/mL · 5 × 3 mL pens", FLAGGED_SIG);
  }

  it("the mock provider's 'nothing needs review' sentence is replaced by the rule summary", async () => {
    const { ctx, db } = rig();
    flaggedOrder(db);
    ctx.llm = new MockProvider();
    const r = await reviewRx(ctx, actor, "T-FLAG");
    expect(r.flags).toBeGreaterThan(0);
    expect(r.summary).not.toMatch(/nothing/i);
    expect(r.summary).toMatch(new RegExp(`^${r.flags} items? need review`));
    expect(auditCount(db, "rxwatcher.summary_dropped")).toBe(1);
  });

  it("a lying provider cannot replace the summary with 'all clear' or 'safe to fill'", async () => {
    for (const lie of ["Nothing needs review here.", "All checks clear. Safe to fill.", "There are no concerns with this order.", "Looks like a routine order."]) {
      const { ctx, db } = rig();
      flaggedOrder(db);
      ctx.llm = { name: "liar", complete: async () => JSON.stringify({ summary: lie, possible: [] }) };
      const r = await reviewRx(ctx, actor, "T-FLAG");
      expect(r.summary, lie).toMatch(/need review/);
      expect(r.summary, lie).not.toBe(lie);
      cleanup.shift()?.();
    }
  });

  it("a model summary that names the hit count may add detail and is kept", async () => {
    const { ctx, db } = rig();
    flaggedOrder(db);
    let text = "";
    ctx.llm = { name: "honest", complete: async (_s, user) => {
      const n = (JSON.parse(/<rule_findings>(.*)<\/rule_findings>/.exec(user)![1]!) as { severity: string }[]).filter((f) => f.severity !== "monitor").length;
      text = `${n} items need a pharmacist: the directions say three times a day for a once-daily pen.`;
      return JSON.stringify({ summary: text, possible: [] });
    } };
    const r = await reviewRx(ctx, actor, "T-FLAG");
    expect(r.flags).toBeGreaterThan(0);
    expect(r.summary).toBe(text);
  });

  it("with no rule hit a model summary is kept as before", async () => {
    const { ctx } = rig();
    ctx.llm = { name: "plain", complete: async () => JSON.stringify({ summary: "Routine refill, nothing unusual.", possible: [] }) };
    const r = await reviewRx(ctx, actor, "0072214");
    expect(r.flags).toBe(0);
    expect(r.summary).toBe("Routine refill, nothing unusual.");
  });

  it("the shared check: dismissing wording and a missing count are refused only when a hit exists", () => {
    expect(modelSummaryAcceptable("The rules found nothing that needs review.", 1)).toBe(false);
    expect(modelSummaryAcceptable("Please look at this order.", 2)).toBe(false);
    expect(modelSummaryAcceptable("Two items need a pharmacist.", 2)).toBe(true);
    expect(modelSummaryAcceptable("The rules found nothing that needs review.", 0)).toBe(true);
  });
});

describe("Guardian cards show a human title, a separate rule id and history-only evidence", () => {
  it("with the mock provider the explanation has no raw rule id prefix and the evidence never repeats the explanation", async () => {
    const { ctx, db } = rig("mock");
    db.run("INSERT INTO patients (id, name, dob, phone, email, preferred, allergies) VALUES ('S-9003','Test Patient Three','1970-01-01','','','sms','')");
    db.run("INSERT INTO med_history (patient_id, filled_on, ndc11, drug, sig, lot, prescriber, qty, days_supply, status, auto_refill, refills_left) VALUES ('S-9003',?,?,?,?,?,?,?,?,?,0,1)", ago(3), "70004062315", INSULIN, "Inject 20 units daily", "GX4471C", "Dr. A", 1, 68, "Active");
    db.run("INSERT INTO prescriptions (rx, patient_id, ndc11, drug, qty, directions, prescriber, refills, status, due, days_supply, review) VALUES ('T-CIP2','S-9003','','Ciprofloxacin 500 mg · 14 tab',1,'Take 1 tablet twice daily for 7 days','Dr. A',0,'to_fill','today',7,'pending')");
    await runAgent(ctx, actor, "rx-guardian", { rx: "T-CIP2" });
    const list = listSuggestions(ctx, { rx: "T-CIP2", status: "all" });
    expect(list.length).toBeGreaterThan(0);
    for (const s of list) {
      expect(s.explanation, s.rule).not.toMatch(/^(interaction|non[- ]adherence|duplicate[- ]therapy|early[- ]refill|late[- ]refill|allergy[- ]class)\s*:/i);
      expect(s.rule).toMatch(/^[a-z-]+$/);
      expect(s.title).not.toBe(s.rule);
      for (const e of s.evidence) {
        expect(e.date, `${s.rule}: ${e.text}`).toBeTruthy();
        expect(s.explanation).not.toContain(e.text);
      }
    }
    const ix = list.find((s) => s.rule === "interaction")!;
    expect(ix.evidence.length).toBeGreaterThan(0);
    expect(ix.evidence[0]!.text).toMatch(/active fill/);
  });

  it("the pure hit keeps its explanation facts out of the evidence list", () => {
    const h = guardianHits(guardInput([hist(INSULIN, 3, 68, "Active")])).find((x) => x.rule === "interaction")!;
    expect(h.facts.some((f) => f.order)).toBe(true);
    expect(h.facts.some((f) => !f.order && f.date === ago(3))).toBe(true);
  });
});
