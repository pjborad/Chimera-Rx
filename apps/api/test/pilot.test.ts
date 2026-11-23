import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, Db, ingestFaxInbox, loadConfig, SandboxNotifier, seedDatabase, type Ctx } from "../src/index";
import { generateHistory, lotCaptureRate, TIMING_RECALL } from "../src/dataset";
import { resetDemo, SCENARIOS } from "./scenario-fixtures";

// Judge-ready pilot: scenario library (FR6, US1.1 to US1.3, US5.1 to US5.3) and the larger dataset (FR5, US2.4).

let app: FastifyInstance;
let ctx: Ctx;
const cookies: Record<string, string> = {};
const PW = "moonlight-rx-2026";

async function signIn(who: "j.rivera" | "k.patel" | "m.diaz") {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { storeId: "store-7", email: `${who}@elmstreetrx.example`, password: PW, trusted: true } });
  expect(r.statusCode).toBe(200);
  cookies[who] = r.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}
const call = (who: string, method: "GET" | "POST", url: string, payload?: unknown) => app.inject({ method, url, payload: payload as never, headers: { cookie: cookies[who]! } });
const json = async (who: string, method: "GET" | "POST", url: string, payload?: unknown) => (await call(who, method, url, payload)).json();
const startScenario = async (id: string) => {
  await resetDemo(ctx, null, id); // in-process fixture: the product has no scenario routes
  for (const w of ["j.rivera", "k.patel", "m.diaz"] as const) await signIn(w); // a reset clears sessions
};

beforeAll(async () => {
  process.env.OFFLINE = "1";
  const cfg = loadConfig({}, { sqlitePath: ":memory:", sandboxDelayMs: 20, today: "2026-11-18", nightWatch: false, assetsDir: "/nonexistent", webDist: "/nonexistent" });
  const db = new Db(":memory:");
  ctx = { cfg, db, notify: new SandboxNotifier(db, cfg), now: () => Date.parse("2026-11-18T18:00:00Z") };
  seedDatabase(db, cfg, ctx.now());
  await ingestFaxInbox(ctx);
  app = await buildApp(ctx);
  for (const w of ["j.rivera", "k.patel", "m.diaz"] as const) await signIn(w);
}, 60_000);

describe("FR6 scenario library", () => {
  it("the fixture library has its scenarios, each with a brief, and the product exposes no demo routes", async () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(5);
    for (const s of SCENARIOS) expect(s.brief.length).toBeGreaterThan(80);
    for (const [m, u] of [["GET", "/api/demo/scenarios"], ["POST", "/api/demo/reset"], ["GET", "/api/demo/labels"]] as const) {
      expect([403, 404], u).toContain((await call("j.rivera", m, u)).statusCode); // default-deny or not found: never served
    }
  });

  it("US5.1 a Class I recall quarantines shelf units and lists the patients who took one home", async () => {
    await startScenario("class1-recall");
    const r = await json("j.rivera", "POST", "/api/recalls/lookup", { number: "D-0611-2026" });
    expect(r.recall.classification).toBe("Class I");
    expect(r.recall.lots.map((l: any) => [l.lot, l.confirmed])).toEqual([["GX4471C", true]]);
    expect(r.impact.unitsHeld).toBeGreaterThan(0);
    expect(r.impact.patientCount).toBeGreaterThan(0);
    const audit = await json("j.rivera", "GET", "/api/audit/verify");
    expect(audit.ok).toBe(true);
  });

  it("US5.2 a recall for lots never received touches no stock and no patients", async () => {
    await startScenario("not-received");
    const r = await json("j.rivera", "POST", "/api/recalls/lookup", { number: "D-0603-2026" });
    expect(r.impact.unitsHeld).toBe(0);
    expect(r.impact.patientCount).toBe(0);
  });

  it("US5.3 a misread fax lot is kept apart, unconfirmed, with no stock, until the pharmacist decides", async () => {
    await startScenario("misread-fax");
    const r = await json("j.rivera", "GET", "/api/recalls/D-0417-2026");
    const misread = r.recall.lots.find((l: any) => l.lot === "PRORX05O925-1");
    expect(misread).toBeTruthy();
    expect(misread.confirmed).toBe(false);
    expect(misread.confidence).toBeLessThan(0.95);
    expect(misread.received).toBe(0);
    // the real lots are still there, from the FDA record
    expect(r.recall.lots.map((l: any) => l.lot)).toEqual(expect.arrayContaining(["PRORX050925-1", "PRORX050925-3"]));
  });

  it("US1.2 receiving problems: warm shipment, extra Schedule II package and an expired package all fail checks", async () => {
    await startScenario("receiving-problems");
    const insulin = await json("k.patel", "POST", "/api/deliveries/ASH-1105-07/scan", { fields: { ndc: "70004-623-15", lot: "GX4471C", expiry: "2027-08-31", serial: "0000932" }, source: "typed" });
    expect(insulin.checks.find((c: any) => c.id === "temp")?.state).toBe("fail");
    const oxy1 = await json("k.patel", "POST", "/api/deliveries/ASH-1105-07/scan", { fields: { ndc: "70004-310-10", lot: "OX25L072", expiry: "2028-03-31", serial: "55020417" }, source: "typed" });
    expect(oxy1.canConfirm).toBe(true);
    const oxy2 = await json("k.patel", "POST", "/api/deliveries/ASH-1105-07/scan", { fields: { ndc: "70004-310-10", lot: "OX25L072", expiry: "2028-03-31", serial: "55020418" }, source: "typed" });
    expect(oxy2.checks.find((c: any) => c.id === "invoice")?.state).toBe("fail");
    const expired = await json("k.patel", "POST", "/api/deliveries/ASH-1105-07/scan", { fields: { ndc: "70004-226-01", lot: "AMX0326Z", expiry: "2026-10-31", serial: "10443899" }, source: "typed" });
    expect(expired.canConfirm).toBe(false);
  });

  it("US1.3 a serial missing from the supplier's records fails the TI/TS check", async () => {
    await startScenario("suspect-product");
    const r = await json("k.patel", "POST", "/api/deliveries/ASH-1105-08/scan", { fields: { ndc: "70004-145-90", lot: "AM1107B", expiry: "2028-06-30", serial: "20001199" }, source: "typed" });
    expect(r.checks.find((c: any) => c.id === "tits")?.state).toBe("fail");
    expect(r.canConfirm).toBe(false);
  });
});

describe("FR5 larger synthetic dataset", () => {
  const build = () => { const db = new Db(":memory:"); const s = generateHistory(db, { seed: 7, patients: 80, fills: 600, products: 30 }); return { db, s }; };
  const dump = (db: Db) => JSON.stringify([
    db.all("SELECT ndc11, name FROM products ORDER BY ndc11"),
    db.all("SELECT id, phone, email FROM patients ORDER BY id"),
    db.all("SELECT r.rx, r.patient_id, d.package_id, d.filled_at FROM dispenses d JOIN prescriptions r ON r.id = d.rx_id ORDER BY r.rx")
  ]);

  it("FR5.2 the same seed gives identical data", () => {
    const a = build(), b = build();
    expect(a.s).toEqual(b.s);
    expect(dump(a.db)).toBe(dump(b.db));
  });

  it("FR5.1 creates the requested volume and the timing lot", () => {
    const { db, s } = build();
    expect(s).toMatchObject({ patients: 80, fills: 600, products: 30 });
    expect(db.get("SELECT 1 FROM lots WHERE lot = ?", TIMING_RECALL.lot)).toBeTruthy();
  });

  it("FR5.3 uses only synthetic identifiers", () => {
    const { db } = build();
    for (const p of db.all<any>("SELECT id, phone, email FROM patients")) {
      expect(p.id).toMatch(/^S-\d{4}$/);
      expect(p.phone).toMatch(/^\(555\) 010-01\d\d$/);
      if (p.email) expect(p.email).toMatch(/@example\.com$/);
    }
  });

  it("FR2.3 reports the lot-capture rate", () => {
    const { db } = build();
    const r = lotCaptureRate(db);
    expect(r.total).toBe(600);
    expect(r.rate).toBeGreaterThan(0.8);
    expect(r.rate).toBeLessThan(1);
  });
});
