import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, Db, ingestFaxInbox, loadConfig, SandboxNotifier, seedDatabase, type Ctx } from "../src/index";
import { CODE_TTL_MS } from "../src/mfa";
import { RX_COPAY_CENTS } from "../src/register";

// Second factor (FR7), front-store register (FR3) and stock help (FR8).

const PW = "moonlight-rx-2026";
let nowMs = Date.parse("2026-11-18T18:00:00Z");

async function boot(over: Record<string, unknown> = {}) {
  process.env.OFFLINE = "1";
  const cfg = loadConfig({}, { sqlitePath: ":memory:", sandboxDelayMs: 20, today: "2026-11-18", nightWatch: false, assetsDir: "/nonexistent", webDist: "/nonexistent", ...over });
  const db = new Db(":memory:");
  const ctx: Ctx = { cfg, db, notify: new SandboxNotifier(db, cfg), now: () => nowMs };
  seedDatabase(db, cfg, ctx.now());
  await ingestFaxInbox(ctx);
  return { ctx, app: await buildApp(ctx) };
}
const cookieOf = (r: { cookies: { name: string; value: string }[] }) => r.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const login = (app: FastifyInstance, who: string, password = PW) => app.inject({ method: "POST", url: "/api/auth/login", payload: { storeId: "store-7", email: `${who}@elmstreetrx.example`, password } });

describe("FR7 second sign-in factor", () => {
  let app: FastifyInstance, ctx: Ctx;
  beforeAll(async () => { ({ app, ctx } = await boot({ mfa: true })); });
  afterAll(() => { nowMs = Date.parse("2026-11-18T18:00:00Z"); });
  const code = (challenge: string) => /\b(\d{6})\b/.exec(ctx.db.get<{ body: string }>("SELECT body FROM outbox WHERE subject = 'Your Chimera Rx sign-in code' ORDER BY id DESC LIMIT 1")!.body)![1]!;

  it("FR7.1 a correct password alone gives no session; the code goes to the sandbox outbox only", async () => {
    const r = await login(app, "j.rivera");
    expect(r.statusCode).toBe(202);
    expect(r.json().mfaRequired).toBe(true);
    expect(r.cookies).toHaveLength(0);
    expect((await app.inject({ url: "/api/today" })).statusCode).toBe(401);
    const msg = ctx.db.get<any>("SELECT * FROM outbox WHERE subject = 'Your Chimera Rx sign-in code'");
    expect(msg.provider).toBe("sandbox");
    expect(msg.to_addr).toMatch(/@elmstreetrx\.example$/);
  });

  it("FR7.1 the right code signs in, and the sign-in is in the audit chain", async () => {
    const { challenge } = (await login(app, "j.rivera")).json();
    const v = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { challenge, code: code(challenge) } });
    expect(v.statusCode).toBe(200);
    expect((await app.inject({ url: "/api/today", headers: { cookie: cookieOf(v) } })).statusCode).toBe(200);
    expect(ctx.db.get("SELECT 1 FROM audit WHERE action = 'auth.login_mfa'")).toBeTruthy();
    expect((await app.inject({ url: "/api/audit/verify", headers: { cookie: cookieOf(v) } })).json().ok).toBe(true);
  });

  it("FR7.2 a code works once", async () => {
    const { challenge } = (await login(app, "k.patel")).json();
    const c = code(challenge);
    expect((await app.inject({ method: "POST", url: "/api/auth/verify", payload: { challenge, code: c } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/verify", payload: { challenge, code: c } })).statusCode).toBe(401);
  });

  it("FR7.2 a code expires after 5 minutes", async () => {
    const { challenge } = (await login(app, "k.patel")).json();
    const c = code(challenge);
    nowMs += CODE_TTL_MS + 1000;
    expect((await app.inject({ method: "POST", url: "/api/auth/verify", payload: { challenge, code: c } })).statusCode).toBe(401);
    nowMs = Date.parse("2026-11-18T18:00:00Z");
  });

  it("FR7.2 five wrong codes lock the account for 15 minutes", async () => {
    const { challenge } = (await login(app, "m.diaz")).json();
    const right = code(challenge);
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) expect((await app.inject({ method: "POST", url: "/api/auth/verify", payload: { challenge, code: wrong } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/verify", payload: { challenge, code: wrong } })).statusCode).toBe(423);
    // even the right password is refused while locked
    expect((await login(app, "m.diaz")).statusCode).toBe(423);
  });

  it("FR7.3 the sandbox code hint works without a session; there is no badge/SSO stand-in", async () => {
    const { challenge } = (await login(app, "j.rivera")).json();
    expect((await app.inject({ url: `/api/auth/demo-code/${challenge}` })).json().code).toMatch(/^\d{6}$/);
    expect([401, 404]).toContain((await app.inject({ method: "POST", url: "/api/auth/sso" })).statusCode);
  });

  it("without MFA, sign-in is unchanged", async () => {
    const plain = await boot();
    expect((await login(plain.app, "j.rivera")).statusCode).toBe(200);
  });
});

describe("FR3 front-store register", () => {
  let app: FastifyInstance, ctx: Ctx;
  const cookies: Record<string, string> = {};
  const call = (who: string, method: "GET" | "POST", url: string, payload?: unknown) => app.inject({ method, url, payload: payload as never, headers: { cookie: cookies[who]! } });
  /** a verified fill, ready for pickup, from an on-shelf package of `ndc11` */
  const verifiedFill = (patient: string, rx: string, ndc11: string, lot?: string) => {
    const pkg = ctx.db.get<any>(`SELECT k.id, l.id AS lot_id FROM packages k JOIN lots l ON l.id = k.lot_id WHERE l.ndc11 = ? AND k.status = 'on_shelf' ${lot ? "AND l.lot = ?" : ""} ORDER BY k.id LIMIT 1`, ...(lot ? [ndc11, lot] : [ndc11]))!;
    const rxId = Number(ctx.db.run("INSERT INTO prescriptions (rx, patient_id, ndc11, drug, qty, directions, prescriber, refills, status, due) VALUES (?,?,?,?,?,?,?,?,?,?)", rx, patient, ndc11, "Test drug", 1, "x", "Dr. T", 0, "ready", "2026-11-18").lastInsertRowid);
    ctx.db.run("UPDATE packages SET status = 'dispensed' WHERE id = ?", pkg.id);
    return Number(ctx.db.run("INSERT INTO dispenses (rx_id, package_id, state, filled_by, filled_at, verified_by, verified_at) VALUES (?,?,?,?,?,?,?)", rxId, pkg.id, "verified", "K. Patel, CPhT", nowMs, "J. Rivera, PharmD", nowMs).lastInsertRowid);
  };
  beforeAll(async () => {
    ({ app, ctx } = await boot());
    for (const w of ["j.rivera", "k.patel", "m.diaz"]) cookies[w] = cookieOf(await login(app, w));
  });

  it("US4.1 finds an item by its retail barcode and by name", async () => {
    const byUpc = (await call("m.diaz", "GET", "/api/register/items?q=036000291452")).json();
    expect(byUpc.map((i: any) => i.name)).toEqual(["Acetaminophen 500 mg · 100 ct"]);
    const byName = (await call("m.diaz", "GET", "/api/register/items?q=ibuprofen")).json();
    expect(byName[0].upc).toBe("036000291469");
  });

  it("US4.2 a technician cannot use the register (Q5)", async () => {
    expect((await call("k.patel", "GET", "/api/register/items")).statusCode).toBe(403);
    expect((await call("k.patel", "POST", "/api/register/sales", { items: [{ upc: "036000291452", qty: 1 }], dispenseIds: [] })).statusCode).toBe(403);
  });

  it("US4.1 and Q3: an over-the-counter sale is recorded and does not touch prescription stock", async () => {
    const before = ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM packages WHERE status = 'on_shelf'")!.n;
    const r = await call("m.diaz", "POST", "/api/register/sales", { items: [{ upc: "036000291452", qty: 2 }, { upc: "036000291520", qty: 1 }], dispenseIds: [] });
    expect(r.statusCode).toBe(200);
    const rc = r.json();
    expect(rc.status).toBe("paid");
    expect(rc.totalCents).toBe(2 * 899 + 349);
    expect(ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM packages WHERE status = 'on_shelf'")!.n).toBe(before);
    expect(ctx.db.get("SELECT 1 FROM audit WHERE action = 'register.sale'")).toBeTruthy();
  });

  it("US4.2 the patient view carries no allergies or date of birth", async () => {
    const r = (await call("m.diaz", "GET", "/api/register/patients/S-0612")).json();
    expect(JSON.stringify(r)).not.toMatch(/allerg|dob|penicillin|1968/i);
  });

  it("US4.2 prescriptions need photo ID, counseling and signature", async () => {
    const id = verifiedFill("S-0612", "T000001", "70004080390");
    const r = await call("m.diaz", "POST", "/api/register/sales", { patientId: "S-0612", items: [], dispenseIds: [id], idChecked: true, counseled: false, signature: true });
    expect(r.statusCode).toBe(422);
    expect(ctx.db.get<any>("SELECT state FROM dispenses WHERE id = ?", id).state).toBe("verified");
  });

  it("US4.3 a mixed sale completes: lot and serial on the receipt, the fill marked sold, the audit chain intact", async () => {
    const id = verifiedFill("S-0612", "T000002", "70004080390");
    const r = await call("m.diaz", "POST", "/api/register/sales", { patientId: "S-0612", items: [{ upc: "036000291469", qty: 1 }], dispenseIds: [id], idChecked: true, counseled: true, signature: true });
    expect(r.statusCode).toBe(200);
    const rc = r.json();
    const rxLine = rc.lines.find((l: any) => l.kind === "rx");
    expect(rxLine.rx).toBe("T000002");
    expect(rxLine.lot).toBeTruthy();
    expect(rxLine.serial).toBeTruthy();
    expect(rc.totalCents).toBe(949 + RX_COPAY_CENTS);
    expect(ctx.db.get<any>("SELECT state FROM dispenses WHERE id = ?", id).state).toBe("sold");
    expect((await call("j.rivera", "GET", "/api/audit/verify")).json().ok).toBe(true);
  });

  it("FR3.5 a prescription that is not verified is blocked, by name, and nothing is sold", async () => {
    const id = verifiedFill("S-0612", "T000003", "70004080390");
    ctx.db.run("UPDATE dispenses SET state = 'filled' WHERE id = ?", id);
    const salesBefore = ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM sales")!.n;
    const r = await call("m.diaz", "POST", "/api/register/sales", { patientId: "S-0612", items: [{ upc: "036000291452", qty: 1 }], dispenseIds: [id], idChecked: true, counseled: true, signature: true });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/T000003/);
    expect(ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM sales")!.n).toBe(salesBefore);
  });

  it("FR3.5 a package from a recalled lot is blocked at the register", async () => {
    const id = verifiedFill("S-0612", "T000004", "70004080390", "AT24K118");
    ctx.db.run("UPDATE lots SET status = 'recalled' WHERE lot = 'AT24K118'");
    const r = await call("m.diaz", "POST", "/api/register/sales", { patientId: "S-0612", items: [], dispenseIds: [id], idChecked: true, counseled: true, signature: true });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/recalled lot/);
  });

  it("an empty sale and an unknown item are refused", async () => {
    expect((await call("m.diaz", "POST", "/api/register/sales", { items: [], dispenseIds: [] })).statusCode).toBe(422);
    expect((await call("m.diaz", "POST", "/api/register/sales", { items: [{ upc: "000", qty: 1 }], dispenseIds: [] })).statusCode).toBe(422);
  });
});

describe("FR8 AI stock help", () => {
  let app: FastifyInstance, ctx: Ctx;
  const cookies: Record<string, string> = {};
  const call = (who: string, method: "GET" | "POST", url: string, payload?: unknown) => app.inject({ method, url, payload: payload as never, headers: { cookie: cookies[who]! } });
  beforeAll(async () => {
    ({ app, ctx } = await boot());
    for (const w of ["j.rivera", "k.patel", "m.diaz"]) cookies[w] = cookieOf(await login(app, w));
  });

  it("only a technician or pharmacist sees suggestions; only a pharmacist can act (Q5)", async () => {
    expect((await call("m.diaz", "GET", "/api/stock-help")).statusCode).toBe(403);
    const t = (await call("k.patel", "GET", "/api/stock-help")).json();
    expect(t.canAct).toBe(false);
    expect((await call("k.patel", "POST", "/api/stock-help/decision", { kind: "reorder", key: "x", decision: "accepted" })).statusCode).toBe(403);
    expect((await call("j.rivera", "GET", "/api/stock-help")).json().canAct).toBe(true);
  });

  it("FR8.1 a reorder suggestion shows the numbers it used", async () => {
    const s = (await call("j.rivera", "GET", "/api/stock-help")).json();
    expect(s.reorder.length).toBeGreaterThan(0);
    for (const r of s.reorder) {
      expect(r.suggestedQty).toBe(r.target - r.onHand);
      expect(r.reason).toContain(`${r.onHand} on hand`);
      expect(r.reason).toContain(`${r.fills4w} fills`);
    }
  });

  it("FR8.2 flags a lot that will not be used before it expires", async () => {
    const s = (await call("j.rivera", "GET", "/api/stock-help")).json();
    expect(s.expiry.length).toBeGreaterThan(0);
    for (const e of s.expiry) { expect(e.daysToExpiry).toBeGreaterThanOrEqual(0); expect(e.reason).toMatch(/Dispense this lot first/); }
  });

  it("FR8.3 flags products on the shortage list, from the cached copy offline, and says so", async () => {
    const s = (await call("j.rivera", "GET", "/api/stock-help")).json();
    const hit = s.shortages.find((x: any) => x.ndc11 === "70004080390");
    expect(hit).toBeTruthy();
    expect(hit.source).toBe("cached");
    expect(hit.reason).toMatch(/cached copy/);
  });

  it("FR8 accepting is recorded in the audit log and changes nothing in the ledger", async () => {
    const onShelf = () => ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM packages WHERE status = 'on_shelf'")!.n;
    const before = onShelf();
    const first = (await call("j.rivera", "GET", "/api/stock-help")).json().reorder[0];
    expect((await call("j.rivera", "POST", "/api/stock-help/decision", { kind: "reorder", key: first.key, decision: "accepted" })).statusCode).toBe(200);
    expect(ctx.db.get("SELECT 1 FROM audit WHERE action = 'stock.accepted'")).toBeTruthy();
    expect((await call("j.rivera", "GET", "/api/stock-help")).json().reorder.find((r: any) => r.key === first.key).decision).toBe("accepted");
    expect(onShelf()).toBe(before);
  });

  it("FR8.4 an LLM only explains: the numbers are unchanged, and a failing LLM falls back to the rule's reason", async () => {
    const plain = (await call("j.rivera", "GET", "/api/stock-help")).json();
    ctx.llm = { name: "fake", complete: async () => "Stock is low and sells quickly. Order 999 units." };
    const withLlm = (await call("j.rivera", "GET", "/api/stock-help")).json();
    expect(withLlm.reorder.map((r: any) => [r.key, r.suggestedQty])).toEqual(plain.reorder.map((r: any) => [r.key, r.suggestedQty]));
    expect(withLlm.reorder[0].explanation).toMatch(/Stock is low/);
    ctx.llm = { name: "broken", complete: async () => { throw new Error("down"); } };
    const broken = (await call("j.rivera", "GET", "/api/stock-help")).json();
    expect(broken.reorder[0].explanation).toBeUndefined();
    expect(broken.reorder[0].reason.length).toBeGreaterThan(20);
    ctx.llm = null;
  });
});
