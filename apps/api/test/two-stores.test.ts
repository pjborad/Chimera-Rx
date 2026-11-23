import { resetDemo } from "./scenario-fixtures";
import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, ingestFaxInbox, loadConfig, SandboxNotifier, seedDatabase, type Ctx } from "../src/index";
import { ledgerViolations } from "../src/inventory";
import { seedStore2 } from "../src/seed-store2";
import { createStores, STORE_1, STORE_2 } from "../src/stores";

// Two stores (FR4, US2.1 to US2.3, NFR3): each store has its own database; only transfers and mirrored recalls cross.

const PW = "moonlight-rx-2026";
let app: FastifyInstance;
let ctx: Ctx;
const cookies: Record<string, string> = {};
const EMAIL: Record<string, [string, string]> = {
  "j.rivera": [STORE_1, "j.rivera@elmstreetrx.example"], "k.patel": [STORE_1, "k.patel@elmstreetrx.example"], "m.diaz": [STORE_1, "m.diaz@elmstreetrx.example"],
  "s.okoro": [STORE_2, "s.okoro@birchavenuerx.example"], "t.lund": [STORE_2, "t.lund@birchavenuerx.example"], "c.reyes": [STORE_2, "c.reyes@birchavenuerx.example"]
};

async function boot() {
  process.env.OFFLINE = "1";
  const cfg = loadConfig({}, { sqlitePath: ":memory:", sandboxDelayMs: 20, today: "2026-11-18", nightWatch: false, assetsDir: "/nonexistent", webDist: "/nonexistent" });
  const { reg, db } = createStores(cfg);
  const now = Date.parse("2026-11-18T18:00:00Z");
  seedDatabase(reg.db(STORE_1), cfg, now);
  seedStore2(reg.db(STORE_2), now);
  ctx = { cfg, db, stores: reg, notify: new SandboxNotifier(db, cfg), now: () => now };
  await reg.each(() => ingestFaxInbox(ctx));
  app = await buildApp(ctx);
}
async function signInAll() {
  for (const [who, [store, email]] of Object.entries(EMAIL)) {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { storeId: store, email, password: PW, trusted: true } });
    expect(r.statusCode).toBe(200);
    cookies[who] = r.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }
}
const call = (who: string, method: "GET" | "POST", url: string, payload?: unknown) => app.inject({ method, url, payload: payload as never, headers: { cookie: cookies[who]! } });
const json = async (who: string, method: "GET" | "POST", url: string, payload?: unknown) => (await call(who, method, url, payload)).json();
const lotsOf = async (who: string, q: string) => (await json(who, "GET", `/api/lots?q=${encodeURIComponent(q)}`)).rows as any[];

beforeAll(async () => { await boot(); await signInAll(); }, 60_000);

describe("FR4.1 / FR4.2 each store has its own data", () => {
  it("lists both stores on the sign-in config", async () => {
    const c = (await app.inject({ url: "/api/auth/config" })).json();
    expect(c.stores.map((s: any) => s.id).sort()).toEqual([STORE_2, STORE_1].sort());
  });

  it("a signed-in user sees their own store's name and stock", async () => {
    expect((await json("s.okoro", "GET", "/api/me")).store.name).toMatch(/Store 2/);
    expect((await json("j.rivera", "GET", "/api/me")).store.name).toMatch(/Store 7/);
    expect((await lotsOf("s.okoro", "AMX0926B")).length).toBe(0); // a Store 7 lot
    expect((await lotsOf("j.rivera", "AMX0926B")).length).toBe(1);
    expect((await lotsOf("s.okoro", "AMX0626C")).length).toBe(1); // held by both
  });

  it("NFR3 Store 2 cannot read or change Store 7 patients, prescriptions, deliveries or sales through any staff route", async () => {
    const s7patient = "S-0612", s7rx = "0072210";
    for (const url of [`/api/patients/${s7patient}`, `/api/rx/${s7rx}`, `/api/deliveries/ASH-1105-08`, `/api/register/patients/${s7patient}`]) {
      const r = await call("s.okoro", "GET", url);
      expect([404, 403], url).toContain(r.statusCode);
    }
    expect((await json("s.okoro", "GET", `/api/patients?q=Brooks`)).length ?? 0).toBe(0);
    expect((await call("t.lund", "POST", `/api/deliveries/ASH-1105-08/scan`, { fields: { ndc: "70004-145-90", lot: "AM1107B", expiry: "2028-06-30", serial: "20001101" }, source: "typed" })).statusCode).toBe(404);
    expect((await call("c.reyes", "POST", "/api/register/sales", { patientId: s7patient, items: [], dispenseIds: [1], idChecked: true, counseled: true, signature: true })).statusCode).toBeGreaterThanOrEqual(404);
    // and the other way round
    expect((await call("j.rivera", "GET", "/api/patients/S-2001")).statusCode).toBe(404);
  });

  it("NFR3 a session cookie from one store does not work as the other store's", async () => {
    const token = /lg_session=([^;]+)/.exec(cookies["s.okoro"]!)![1]!;
    const forged = `lg_session=${STORE_1}~${token.split("~")[1]}`;
    expect((await app.inject({ url: "/api/today", headers: { cookie: forged } })).statusCode).toBe(401);
  });

  it("each store keeps its own audit chain", async () => {
    expect((await json("j.rivera", "GET", "/api/audit/verify")).ok).toBe(true);
    expect((await json("s.okoro", "GET", "/api/audit/verify")).ok).toBe(true);
    expect((await json("s.okoro", "GET", "/api/audit")).length ?? 0).toBeLessThan(40);
  });

  it("each store's ledger invariant holds", () => {
    for (const id of [STORE_1, STORE_2]) ctx.stores!.run(id, () => expect(ledgerViolations(ctx)).toEqual([]));
  });
});

describe("FR4.3 moving stock between stores", () => {
  const lot = async (who: string, q: string) => (await lotsOf(who, q))[0];

  it("a technician cannot move stock (Q5)", async () => {
    const l = await lot("t.lund", "AMX0626C");
    expect((await call("t.lund", "POST", "/api/transfers", { toStore: STORE_1, lotId: l.id, qty: 1 })).statusCode).toBe(403);
  });

  it("a pharmacist moves packages: lot and serial kept, events and audit rows on both sides", async () => {
    const src = await lot("j.rivera", "AMX0626C");
    const dst = await lot("s.okoro", "AMX0626C");
    const serials = ctx.stores!.run(STORE_1, () => ctx.db.all<{ serial: string }>("SELECT serial FROM packages WHERE lot_id = ? AND status = 'on_shelf' ORDER BY id LIMIT 3", src.id)).map((x) => x.serial);
    const r = await json("j.rivera", "POST", "/api/transfers", { toStore: STORE_2, lotId: src.id, qty: 3 });
    expect(r.moved).toBe(3);
    expect(r.serials).toEqual(serials);
    expect((await lot("j.rivera", "AMX0626C")).onHand).toBe(src.onHand - 3);
    expect((await lot("s.okoro", "AMX0626C")).onHand).toBe(dst.onHand + 3);
    ctx.stores!.run(STORE_2, () => {
      expect(ctx.db.get("SELECT 1 FROM packages WHERE serial = ? AND status = 'on_shelf'", serials[0])).toBeTruthy();
      expect(ctx.db.get("SELECT 1 FROM lot_events WHERE kind = 'Transfer in'")).toBeTruthy();
      expect(ctx.db.get("SELECT 1 FROM audit WHERE action = 'stock.transfer_in'")).toBeTruthy();
    });
    ctx.stores!.run(STORE_1, () => {
      expect(ctx.db.get("SELECT 1 FROM lot_events WHERE kind = 'Transfer out'")).toBeTruthy();
      expect(ctx.db.get("SELECT 1 FROM audit WHERE action = 'stock.transfer_out'")).toBeTruthy();
    });
    expect((await json("j.rivera", "GET", "/api/audit/verify")).ok).toBe(true);
    expect((await json("s.okoro", "GET", "/api/audit/verify")).ok).toBe(true);
    for (const id of [STORE_1, STORE_2]) ctx.stores!.run(id, () => expect(ledgerViolations(ctx)).toEqual([]));
  });

  it("a package can be moved back", async () => {
    const l = await lot("s.okoro", "AMX0626C");
    expect((await call("s.okoro", "POST", "/api/transfers", { toStore: STORE_1, lotId: l.id, qty: 3 })).statusCode).toBe(200);
  });

  it("refuses more than the shelf holds, and moving to your own store", async () => {
    const l = await lot("j.rivera", "AMX0626C");
    expect((await call("j.rivera", "POST", "/api/transfers", { toStore: STORE_2, lotId: l.id, qty: 99 })).statusCode).toBe(409);
    expect((await call("j.rivera", "POST", "/api/transfers", { toStore: STORE_1, lotId: l.id, qty: 1 })).statusCode).toBe(422);
  });
});

describe("Q4 / FR4.4 a recall confirmed in one store blocks the lot in both, with each store seeing only its own", () => {
  it("looking up and confirming the recall in Store 7 mirrors it to Store 2", async () => {
    const r = await json("j.rivera", "POST", "/api/recalls/lookup", { number: "D-0611-2026" });
    expect(r.recall.lots.map((l: any) => [l.lot, l.confirmed])).toEqual([["GX4471C", true]]);
    expect(r.impact.patients.every((p: any) => /^S-0|^S-1/.test(p.id))).toBe(true); // Store 7 patients only
    expect(r.impact.patients.some((p: any) => p.id.startsWith("S-2"))).toBe(false);

    // Store 2 now has the recall, its lot is recalled, its shelf units are quarantined
    const mine = await json("s.okoro", "GET", "/api/recalls/D-0611-2026");
    expect(mine.recall.lots[0].lot).toBe("GX4471C");
    expect(mine.recall.lots[0].confirmed).toBe(true);
    expect(mine.recall.lots[0].onShelf).toBeGreaterThan(0);
    expect(mine.impact.unitsHeld).toBeGreaterThan(0);
    // ...and lists only Store 2's patients
    expect(mine.impact.patientCount).toBe(4);
    expect(mine.impact.patients.every((p: any) => p.id.startsWith("S-2"))).toBe(true);
    ctx.stores!.run(STORE_2, () => {
      expect(ctx.db.get<any>("SELECT status FROM lots WHERE lot = 'GX4471C'")!.status).toBe("recalled");
      expect(ctx.db.get<any>("SELECT count(*) AS n FROM packages WHERE status = 'on_shelf' AND lot_id = (SELECT id FROM lots WHERE lot = 'GX4471C')")!.n).toBe(0);
      expect(ctx.db.get("SELECT 1 FROM audit WHERE action = 'recall.mirrored'")).toBeTruthy();
    });
  });

  it("the recalled lot cannot be moved from either store", async () => {
    const l2 = (await lotsOf("s.okoro", "GX4471C"))[0];
    expect((await call("s.okoro", "POST", "/api/transfers", { toStore: STORE_1, lotId: l2.id, qty: 1 })).statusCode).toBe(409);
    const l1 = (await lotsOf("j.rivera", "GX4471C"))[0];
    expect((await call("j.rivera", "POST", "/api/transfers", { toStore: STORE_2, lotId: l1.id, qty: 1 })).statusCode).toBe(409);
  });

  it("a prescription from the recalled lot is blocked at Store 2's register", async () => {
    ctx.stores!.run(STORE_2, () => {
      const pkg = ctx.db.get<any>("SELECT k.id FROM packages k JOIN lots l ON l.id = k.lot_id WHERE l.lot = 'GX4471C' AND k.status = 'quarantined' LIMIT 1")!;
      const rxId = Number(ctx.db.run("INSERT INTO prescriptions (rx, patient_id, ndc11, drug, qty, directions, prescriber, refills, status, due) VALUES (?,?,?,?,?,?,?,?,?,?)", "B299999", "S-2001", "70004062315", "Insulin", 1, "x", "Dr. T", 0, "ready", "2026-11-18").lastInsertRowid);
      ctx.db.run("INSERT INTO dispenses (rx_id, package_id, state, filled_by, filled_at, verified_by, verified_at) VALUES (?,?,?,?,?,?,?)", rxId, pkg.id, "verified", "T", 1, "S", 1);
    });
    const ready = (await json("c.reyes", "GET", "/api/register/patients/S-2001")).prescriptions.find((p: any) => p.rx === "B299999");
    expect(ready.blocked).toMatch(/recalled/);
  });
});

describe("synthetic reseed", () => {
  it("rebuilds both stores", async () => {
    await resetDemo(ctx, null);
    ctx.stores!.run(STORE_2, () => expect(ctx.db.get<any>("SELECT count(*) AS n FROM recalls")!.n).toBe(0));
    ctx.stores!.run(STORE_2, () => expect(ctx.db.get<any>("SELECT count(*) AS n FROM patients")!.n).toBe(12));
    await signInAll();
    expect((await json("s.okoro", "GET", "/api/me")).store.name).toMatch(/Store 2/);
  });
});
