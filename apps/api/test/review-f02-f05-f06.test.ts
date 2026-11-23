import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, loadConfig, SandboxNotifier, seedDatabase, type Ctx } from "../src/index";
import { AgentRuntime, runAgent } from "../src/agents";
import { activeRecallFor, recallCheck, verifyAuditChain, type Actor } from "../src/core";
import { listTransfers, pendingPropagations, reconcileTransfers, retryPropagations, transferPackages } from "../src/crossstore";
import { ledgerViolations } from "../src/inventory";
import { closeRecall, confirmRecallLot, lookupRecall, quarantineRecalled } from "../src/recall";
import { seedStore2 } from "../src/seed-store2";
import { createStores, STORE_1, STORE_2 } from "../src/stores";

// REV-F02 recall propagation, REV-F05 durable transfers, REV-F06 per-store identity in outputs.

const NOW = Date.parse("2026-11-22T18:00:00Z");
const PW = "moonlight-rx-2026";
const rivera: Actor = { id: "u-rivera", name: "J. Rivera, PharmD", role: "pharmacist", storeId: STORE_1, workstation: "review" };
const okoro: Actor = { id: "u-okoro", name: "S. Okoro, PharmD", role: "pharmacist", storeId: STORE_2, workstation: "review" };
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

/** Two stores. With a `dir` the databases are files, so a test can close them and reopen them (a restart). */
function open(dir?: string) {
  process.env.OFFLINE = "1";
  const cfg = loadConfig({}, { sqlitePath: dir ? path.join(dir, "chimera-rx.sqlite") : ":memory:", dataDir: dir ?? "/nonexistent", today: "2026-11-22", nightWatch: false, sandboxDelayMs: 1, webDist: "/nonexistent", assetsDir: "/nonexistent" });
  const multi = createStores(cfg);
  seedDatabase(multi.reg.db(STORE_1), cfg, NOW);
  seedStore2(multi.reg.db(STORE_2), NOW);
  const ctx: Ctx = { cfg, db: multi.db, stores: multi.reg, now: () => NOW, notify: new SandboxNotifier(multi.db, cfg), agents: new AgentRuntime({ LLM_PROVIDER: "none" }) };
  const close = () => { for (const d of multi.reg.dbs.values()) d.raw.close(); };
  return { ctx, reg: multi.reg, close };
}
function rig(dir?: string) {
  const r = open(dir);
  let closed = false;
  cleanup.push(() => { if (!closed) r.close(); });
  return { ...r, close: () => { closed = true; r.close(); } };
}
const inStore = <T,>(ctx: Ctx, id: string, fn: () => T) => ctx.stores!.run(id, fn);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "chimera-fc-"));
const raw = (ctx: Ctx, id: string, sql: string) => ctx.stores!.db(id).raw.exec(sql);

const RECALL = "D-0611-2026";
const lotRow = (ctx: Ctx, store: string, lot: string) => inStore(ctx, store, () => ctx.db.get<any>("SELECT * FROM lots WHERE lot = ?", lot)!);
const shelf = (ctx: Ctx, store: string, lot: string) => inStore(ctx, store, () => ctx.db.get<any>("SELECT count(*) AS n FROM packages k JOIN lots l ON l.id = k.lot_id WHERE l.lot = ? AND k.status = 'on_shelf'", lot)!.n);
const rl = (ctx: Ctx, store: string, lot = "GX4471C") => inStore(ctx, store, () => ctx.db.get<any>("SELECT * FROM recall_lots WHERE recall_id = ? AND lot = ?", RECALL, lot));
const auditCount = (ctx: Ctx, store: string, action: string) => inStore(ctx, store, () => ctx.db.get<any>("SELECT count(*) AS n FROM audit WHERE action = ?", action)!.n);
const chains = (ctx: Ctx) => [STORE_1, STORE_2].map((s) => inStore(ctx, s, () => verifyAuditChain(ctx).ok));
const confirmAt1 = (ctx: Ctx) => inStore(ctx, STORE_1, () => lookupRecall(ctx, rivera, { number: RECALL }, { autoConfirm: true }));

// ------------------------------------------------------------------------------------------------ F02

describe("REV-F02 recall propagation", () => {
  it("a destination that never heard of the recall gets the recall, the confirmed lot and a quarantine", async () => {
    const { ctx } = rig();
    expect(shelf(ctx, STORE_2, "GX4471C")).toBeGreaterThan(0);
    await confirmAt1(ctx);
    expect(rl(ctx, STORE_2).confirmed_at).toBeTruthy();
    expect(rl(ctx, STORE_2).confirmed_by).toMatch(/^Confirmed at Elm Street Pharmacy · Store 7 on 2026-11-22$/);
    expect(shelf(ctx, STORE_2, "GX4471C")).toBe(0);
    expect(chains(ctx)).toEqual([true, true]);
    expect(inStore(ctx, STORE_1, () => pendingPropagations(ctx))).toEqual([]);
  });

  it("a destination with a pending (unconfirmed) row is upgraded and quarantined", async () => {
    const { ctx } = rig();
    await inStore(ctx, STORE_2, () => lookupRecall(ctx, null, { number: RECALL }, { autoConfirm: false }));
    expect(rl(ctx, STORE_2).confirmed_at).toBeNull();
    await confirmAt1(ctx);
    expect(rl(ctx, STORE_2).confirmed_at).toBeTruthy();
    expect(rl(ctx, STORE_2).confirmed_by).toContain("Confirmed at Elm Street Pharmacy");
    expect(shelf(ctx, STORE_2, "GX4471C")).toBe(0);
    expect(auditCount(ctx, STORE_2, "recall.mirrored")).toBe(1);
    expect(chains(ctx)).toEqual([true, true]);
  });

  it("a destination that already confirmed the lot itself is left exactly as it was", async () => {
    const { ctx } = rig();
    await inStore(ctx, STORE_1, () => lookupRecall(ctx, null, { number: RECALL }, { autoConfirm: false }));
    await inStore(ctx, STORE_2, () => lookupRecall(ctx, null, { number: RECALL }, { autoConfirm: false }));
    // Store 2 confirms first, but its message to Store 7 is lost (a failing write there).
    raw(ctx, STORE_1, "CREATE TRIGGER f02_block BEFORE UPDATE ON recall_lots BEGIN SELECT RAISE(ABORT, 'store 7 unavailable'); END");
    inStore(ctx, STORE_2, () => confirmRecallLot(ctx, okoro, RECALL, "GX4471C"));
    expect(inStore(ctx, STORE_2, () => pendingPropagations(ctx)).map((p) => p.state)).toEqual(["failed"]);
    raw(ctx, STORE_1, "DROP TRIGGER f02_block");
    inStore(ctx, STORE_1, () => confirmRecallLot(ctx, rivera, RECALL, "GX4471C")); // Store 7 confirms by itself
    const before = rl(ctx, STORE_2);
    expect(before.confirmed_by).toBe("S. Okoro, PharmD");
    inStore(ctx, STORE_1, () => quarantineRecalled(ctx, rivera, RECALL)); // propagate again
    expect(rl(ctx, STORE_2)).toEqual(before); // confirmed row: not touched, not downgraded
    expect(rl(ctx, STORE_1).confirmed_by).toBe("J. Rivera, PharmD");
    expect(chains(ctx)).toEqual([true, true]);
  });

  it("a repeat confirmation does nothing twice and keeps the audit chain valid", async () => {
    const { ctx } = rig();
    await confirmAt1(ctx);
    const mirrored = auditCount(ctx, STORE_2, "recall.mirrored");
    const rows = inStore(ctx, STORE_2, () => ctx.db.get<any>("SELECT count(*) AS n FROM audit")!.n);
    expect(inStore(ctx, STORE_1, () => quarantineRecalled(ctx, rivera, RECALL))).toBe(0);
    await confirmAt1(ctx);
    expect(auditCount(ctx, STORE_2, "recall.mirrored")).toBe(mirrored);
    expect(inStore(ctx, STORE_2, () => ctx.db.get<any>("SELECT count(*) AS n FROM audit")!.n)).toBe(rows);
    expect(inStore(ctx, STORE_2, () => ctx.db.get<any>("SELECT count(*) AS n FROM recall_lots WHERE recall_id = ?", RECALL)!.n)).toBe(inStore(ctx, STORE_1, () => ctx.db.get<any>("SELECT count(*) AS n FROM recall_lots WHERE recall_id = ?", RECALL)!.n));
    expect(chains(ctx)).toEqual([true, true]);
  });

  it("a failure in the destination is recorded, does not lose the recall, and is retried after a restart", async () => {
    const dir = tmp();
    const a = rig(dir);
    raw(a.ctx, STORE_2, "CREATE TRIGGER f02_fail BEFORE INSERT ON recall_lots BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    await confirmAt1(a.ctx);
    expect(shelf(a.ctx, STORE_1, "GX4471C")).toBe(0); // the source is blocked regardless
    expect(shelf(a.ctx, STORE_2, "GX4471C")).toBeGreaterThan(0); // the destination is not yet
    const pend = inStore(a.ctx, STORE_1, () => pendingPropagations(a.ctx));
    expect(pend).toHaveLength(1);
    expect(pend[0]).toMatchObject({ recall_id: RECALL, dest_store: STORE_2, state: "failed" });
    expect(pend[0]!.last_error).toMatch(/disk full/);
    raw(a.ctx, STORE_2, "DROP TRIGGER f02_fail");
    a.close();

    const b = rig(dir); // restart: new connections, same files
    expect(inStore(b.ctx, STORE_1, () => pendingPropagations(b.ctx))).toHaveLength(1);
    expect(inStore(b.ctx, STORE_1, () => retryPropagations(b.ctx, quarantineRecalled))).toBe(1);
    expect(rl(b.ctx, STORE_2).confirmed_at).toBeTruthy();
    expect(shelf(b.ctx, STORE_2, "GX4471C")).toBe(0);
    expect(inStore(b.ctx, STORE_1, () => pendingPropagations(b.ctx))).toEqual([]);
    expect(inStore(b.ctx, STORE_1, () => retryPropagations(b.ctx, quarantineRecalled))).toBe(0); // nothing left to repeat
    expect(chains(b.ctx)).toEqual([true, true]);
  });

  it("after propagation the destination blocks the lot everywhere, also after the recall is closed", async () => {
    const { ctx } = rig();
    await confirmAt1(ctx);
    const check = () => inStore(ctx, STORE_2, () => ({
      active: !!activeRecallFor(ctx, lotRow(ctx, STORE_2, "GX4471C").ndc11, "GX4471C"),
      receiving: recallCheck(ctx, lotRow(ctx, STORE_2, "GX4471C").ndc11, "GX4471C").state,
      lot: lotRow(ctx, STORE_2, "GX4471C").status,
      shelf: shelf(ctx, STORE_2, "GX4471C")
    }));
    expect(check()).toEqual({ active: true, receiving: "fail", lot: "recalled", shelf: 0 });
    // transfer out of the destination is refused
    const out = () => inStore(ctx, STORE_2, () => transferPackages(ctx, okoro, { toStore: STORE_1, lotId: lotRow(ctx, STORE_2, "GX4471C").id, qty: 1 }));
    expect(out).toThrow(/recall/i);
    inStore(ctx, STORE_2, () => closeRecall(ctx, okoro, RECALL));
    expect(check()).toEqual({ active: true, receiving: "fail", lot: "recalled", shelf: 0 });
    expect(out).toThrow(/recall/i);
  });
});

// ------------------------------------------------------------------------------------------------ F05

const serialOf = (ctx: Ctx, lot: string) => inStore(ctx, STORE_1, () => ctx.db.get<any>("SELECT k.* FROM packages k JOIN lots l ON l.id = k.lot_id WHERE l.lot = ? AND k.status = 'on_shelf' ORDER BY k.id LIMIT 1", lot)!);
const statuses = (ctx: Ctx, k: { gtin: string; serial: string }) => [STORE_1, STORE_2].map((s) => inStore(ctx, s, () => ctx.db.get<any>("SELECT status FROM packages WHERE gtin = ? AND serial = ?", k.gtin, k.serial)?.status ?? "absent"));
const onShelf = (ctx: Ctx, k: { gtin: string; serial: string }) => statuses(ctx, k).filter((s) => s === "on_shelf").length;
const ledger = (ctx: Ctx) => [STORE_1, STORE_2].map((s) => inStore(ctx, s, () => ledgerViolations(ctx)));
const transferState = (ctx: Ctx, id: string) => inStore(ctx, STORE_1, () => ctx.db.get<any>("SELECT state FROM transfers WHERE id = ?", id)?.state);

describe("REV-F05 durable transfers", () => {
  const go = (ctx: Ctx, id?: string, qty = 1) => transferPackages(ctx, rivera, { toStore: STORE_2, lotId: lotRow(ctx, STORE_1, "AMX0626C").id, qty, transferId: id });

  it("happy path: reserved, received, completed; one store offers the serial, ledgers and chains hold", () => {
    const { ctx } = rig();
    const k = serialOf(ctx, "AMX0626C");
    const r = go(ctx, crypto.randomUUID());
    expect(r.state).toBe("completed");
    expect(statuses(ctx, k)).toEqual(["adjusted", "on_shelf"]);
    expect(ledger(ctx)).toEqual([[], []]);
    expect(chains(ctx)).toEqual([true, true]);
    expect(inStore(ctx, STORE_1, () => listTransfers(ctx))[0]).toMatchObject({ state: "completed", units: 1, incomplete: false });
  });

  it("a failure before the first write changes nothing", () => {
    const { ctx } = rig();
    const k = serialOf(ctx, "AMX0626C");
    raw(ctx, STORE_1, "CREATE TRIGGER f05_a BEFORE UPDATE ON packages WHEN NEW.status = 'in_transit' BEGIN SELECT RAISE(ABORT, 'reserve failed'); END");
    expect(() => go(ctx)).toThrow(/reserve failed/);
    expect(statuses(ctx, k)).toEqual(["on_shelf", "absent"]);
    expect(inStore(ctx, STORE_1, () => listTransfers(ctx))).toEqual([]);
    expect(ledger(ctx)).toEqual([[], []]);
  });

  it("a failure after the reservation and before the destination write: never two shelves, retry with the same id finishes", () => {
    const { ctx } = rig();
    const k = serialOf(ctx, "AMX0626C");
    const id = crypto.randomUUID();
    raw(ctx, STORE_2, "CREATE TRIGGER f05_b BEFORE INSERT ON packages BEGIN SELECT RAISE(ABORT, 'destination write failed'); END");
    expect(() => go(ctx, id)).toThrow(/destination write failed/);
    expect(statuses(ctx, k)).toEqual(["in_transit", "absent"]);
    expect(onShelf(ctx, k)).toBe(0);
    expect(transferState(ctx, id)).toBe("reserved");
    expect(inStore(ctx, STORE_1, () => listTransfers(ctx))[0]).toMatchObject({ state: "reserved", incomplete: true });
    expect(ledger(ctx)).toEqual([[], []]);
    // the in-transit unit cannot be moved again, sold or filled: it is not on the shelf
    const left = shelf(ctx, STORE_1, "AMX0626C");
    expect(() => go(ctx, undefined, left + 1)).toThrow(new RegExp(`Only ${left} package`));
    raw(ctx, STORE_2, "DROP TRIGGER f05_b");
    expect(go(ctx, id).state).toBe("completed");
    expect(statuses(ctx, k)).toEqual(["adjusted", "on_shelf"]);
    // retrying a finished transfer again is a no-op
    expect(go(ctx, id).state).toBe("completed");
    expect(inStore(ctx, STORE_2, () => ctx.db.get<any>("SELECT count(*) AS n FROM packages WHERE serial = ?", k.serial)!.n)).toBe(1);
    expect(inStore(ctx, STORE_2, () => ctx.db.get<any>("SELECT count(*) AS n FROM transfer_receipts")!.n)).toBe(1);
    expect(ledger(ctx)).toEqual([[], []]);
    expect(chains(ctx)).toEqual([true, true]);
  });

  it("a failure after the destination committed and before the source completes: one shelf, reconcile completes", () => {
    const { ctx } = rig();
    const k = serialOf(ctx, "AMX0626C");
    const id = crypto.randomUUID();
    raw(ctx, STORE_1, "CREATE TRIGGER f05_c BEFORE UPDATE ON packages WHEN NEW.status = 'adjusted' BEGIN SELECT RAISE(ABORT, 'source complete failed'); END");
    expect(() => go(ctx, id)).toThrow(/source complete failed/);
    expect(statuses(ctx, k)).toEqual(["in_transit", "on_shelf"]);
    expect(onShelf(ctx, k)).toBe(1);
    expect(transferState(ctx, id)).toBe("received");
    expect(ledger(ctx)).toEqual([[], []]);
    // reconcile while the fault is still there: stays visible, still one shelf
    expect(inStore(ctx, STORE_1, () => reconcileTransfers(ctx)).failed).toHaveLength(1);
    expect(onShelf(ctx, k)).toBe(1);
    raw(ctx, STORE_1, "DROP TRIGGER f05_c");
    expect(inStore(ctx, STORE_1, () => reconcileTransfers(ctx, rivera))).toEqual({ completed: [id], cancelled: [], failed: [] });
    expect(statuses(ctx, k)).toEqual(["adjusted", "on_shelf"]);
    expect(inStore(ctx, STORE_1, () => reconcileTransfers(ctx, rivera))).toEqual({ completed: [], cancelled: [], failed: [] });
    expect(ledger(ctx)).toEqual([[], []]);
    expect(chains(ctx)).toEqual([true, true]);
    expect(auditCount(ctx, STORE_1, "stock.transfer_out")).toBe(1);
  });

  it("a transfer the destination never received is rolled back to the shelf by reconcile", () => {
    const { ctx } = rig();
    const k = serialOf(ctx, "AMX0626C");
    const id = crypto.randomUUID();
    raw(ctx, STORE_2, "CREATE TRIGGER f05_d BEFORE INSERT ON packages BEGIN SELECT RAISE(ABORT, 'destination write failed'); END");
    expect(() => go(ctx, id)).toThrow();
    raw(ctx, STORE_2, "DROP TRIGGER f05_d");
    expect(inStore(ctx, STORE_1, () => reconcileTransfers(ctx, rivera))).toEqual({ completed: [], cancelled: [id], failed: [] });
    expect(statuses(ctx, k)).toEqual(["on_shelf", "absent"]);
    expect(transferState(ctx, id)).toBe("cancelled");
    expect(() => go(ctx, id)).toThrow(/cancelled/); // the same id cannot be revived by a retry
    expect(auditCount(ctx, STORE_1, "stock.transfer_cancelled")).toBe(1);
    expect(ledger(ctx)).toEqual([[], []]);
    expect(chains(ctx)).toEqual([true, true]);
  });

  it("restart: files reopened, recovery at start-up leaves at most one shelf in every interrupted case", () => {
    const dir = tmp();
    const a = rig(dir);
    const k1 = serialOf(a.ctx, "AMX0626C");
    const idBefore = crypto.randomUUID(), idAfter = crypto.randomUUID();
    raw(a.ctx, STORE_2, "CREATE TRIGGER f05_e BEFORE INSERT ON packages BEGIN SELECT RAISE(ABORT, 'x'); END");
    expect(() => transferPackages(a.ctx, rivera, { toStore: STORE_2, lotId: lotRow(a.ctx, STORE_1, "AMX0626C").id, qty: 1, transferId: idBefore })).toThrow();
    raw(a.ctx, STORE_2, "DROP TRIGGER f05_e");
    raw(a.ctx, STORE_1, "CREATE TRIGGER f05_f BEFORE UPDATE ON packages WHEN NEW.status = 'adjusted' BEGIN SELECT RAISE(ABORT, 'y'); END");
    // idBefore holds serial 1 in transit; idAfter takes the next serial through the destination and then fails at the source
    expect(() => transferPackages(a.ctx, rivera, { toStore: STORE_2, lotId: lotRow(a.ctx, STORE_1, "AMX0626C").id, qty: 1, transferId: idAfter })).toThrow();
    raw(a.ctx, STORE_1, "DROP TRIGGER f05_f");
    const k2 = inStore(a.ctx, STORE_1, () => a.ctx.db.get<any>("SELECT k.* FROM packages k JOIN transfers t ON t.items LIKE '%' || k.serial || '%' WHERE t.id = ?", idAfter)!);
    expect(onShelf(a.ctx, k1)).toBe(0);
    expect(onShelf(a.ctx, k2)).toBe(1);
    a.close();

    const b = rig(dir);
    const rec = inStore(b.ctx, STORE_1, () => reconcileTransfers(b.ctx));
    expect(rec.completed).toEqual([idAfter]);
    expect(rec.cancelled).toEqual([idBefore]);
    expect(statuses(b.ctx, k1)).toEqual(["on_shelf", "absent"]);
    expect(statuses(b.ctx, k2)).toEqual(["adjusted", "on_shelf"]);
    expect(ledger(b.ctx)).toEqual([[], []]);
    expect(chains(b.ctx)).toEqual([true, true]);
    expect(inStore(b.ctx, STORE_1, () => listTransfers(b.ctx)).every((t) => !t.incomplete)).toBe(true);
  });

  it("stock whose lot is recalled while it is in transit goes to quarantine, not back on the shelf", async () => {
    const { ctx } = rig();
    const lot = "GX4471C";
    const k = serialOf(ctx, lot);
    const id = crypto.randomUUID();
    raw(ctx, STORE_2, "CREATE TRIGGER f05_g BEFORE INSERT ON packages BEGIN SELECT RAISE(ABORT, 'x'); END");
    expect(() => transferPackages(ctx, rivera, { toStore: STORE_2, lotId: lotRow(ctx, STORE_1, lot).id, qty: 1, transferId: id })).toThrow();
    raw(ctx, STORE_2, "DROP TRIGGER f05_g");
    await confirmAt1(ctx);
    inStore(ctx, STORE_1, () => reconcileTransfers(ctx));
    expect(statuses(ctx, k)[0]).toBe("quarantined");
    expect(onShelf(ctx, k)).toBe(0);
  });

  it("a transfer id of another move is refused", () => {
    const { ctx } = rig();
    const id = crypto.randomUUID();
    go(ctx, id);
    expect(() => transferPackages(ctx, rivera, { toStore: STORE_2, lotId: lotRow(ctx, STORE_1, "GX4471C").id, qty: 1, transferId: id })).toThrow(/different move/);
  });
});

// ------------------------------------------------------------------------------------------------ F06

async function webRig() {
  const r = rig();
  await confirmAt1(r.ctx); // Store 2 now holds the recall with its own patients on the sold lot
  const app = await buildApp(r.ctx);
  cleanup.push(() => app.close());
  const login = async (storeId: string, email: string) => {
    const l = await app.inject({ method: "POST", url: "/api/auth/login", payload: { storeId, email, password: PW } });
    return l.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  };
  return { ...r, app, c2: await login(STORE_2, "s.okoro@birchavenuerx.example"), c7: await login(STORE_1, "j.rivera@elmstreetrx.example") };
}

/** The text of a pdfkit document: inflate each stream and decode the hex strings of the show-text operators. */
function pdfText(buf: Buffer): string {
  const s = buf.toString("latin1");
  let out = "";
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body: string;
    try { body = zlib.inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1"); } catch { continue; }
    for (const h of body.matchAll(/<([0-9a-fA-F]+)>/g)) out += Buffer.from(h[1]!, "hex").toString("latin1");
    out += "\n";
  }
  return out;
}
const STORE7_IDENTITY = /Elm Street|\(555\) 010-2200|555, 0 1 0, 2 2 0 0|J\. Rivera|Rivera/;

describe("REV-F06 per-store identity in outputs", () => {
  it("Store 2 draft, preview and sent texts carry Birch Avenue and its phone, never Store 7's", async () => {
    const { app, c2, ctx } = await webRig();
    const draft = (await app.inject({ url: `/api/recalls/${RECALL}/messages`, headers: { cookie: c2 } })).json();
    const all = JSON.stringify(draft);
    expect(draft.smsPreview).toContain("Birch Avenue Pharmacy");
    expect(draft.smsPreview).toContain("(555) 010-2300");
    expect(all).not.toMatch(STORE7_IDENTITY);
    const prev = (await app.inject({ method: "POST", url: `/api/recalls/${RECALL}/preview`, headers: { cookie: c2 }, payload: { sms: draft.sms, emailSubject: draft.emailSubject, emailBody: draft.emailBody } })).json();
    expect(prev.emailBody).toContain("Birch Avenue Pharmacy");
    expect(prev.emailBody).toContain("(555) 010-2300");
    expect(prev.emailBody).toContain("S. Okoro, PharmD");
    expect(JSON.stringify(prev)).not.toMatch(STORE7_IDENTITY);
    const sent = await app.inject({ method: "POST", url: `/api/recalls/${RECALL}/notifications`, headers: { cookie: c2 }, payload: { sms: draft.sms, emailSubject: draft.emailSubject, emailBody: draft.emailBody, attest: true } });
    expect(sent.statusCode).toBe(200);
    const bodies = inStore(ctx, STORE_2, () => ctx.db.all<any>("SELECT body FROM outbox").map((o) => o.body as string));
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) { expect(b).toContain("(555) 010-2300"); expect(b).not.toMatch(STORE7_IDENTITY); }
    expect(bodies.some((b) => b.startsWith("Birch Avenue Pharmacy:"))).toBe(true);
    // rule 9: STOP on every text, one patient per message
    for (const t of inStore(ctx, STORE_2, () => ctx.db.all<any>("SELECT merged_text FROM notifications WHERE channel = 'sms'"))) expect(t.merged_text).toMatch(/Reply STOP/);
  });

  it("a text that names Store 7 is refused in Store 2, and a text without this store's phone too", async () => {
    const { app, c2 } = await webRig();
    const base = { emailSubject: "Important notice", emailBody: "Dear {first_name}, please call {pharmacy_phone}. {pharmacist}", attest: true };
    const stale = await app.inject({ method: "POST", url: `/api/recalls/${RECALL}/notifications`, headers: { cookie: c2 }, payload: { ...base, sms: "Elm Street Pharmacy: Hi {first_name}, call (555) 010-2300 about a recall." } });
    expect(stale.statusCode).toBe(422);
    const wrongPhone = await app.inject({ method: "POST", url: `/api/recalls/${RECALL}/notifications`, headers: { cookie: c2 }, payload: { ...base, sms: "Hi {first_name}, call (555) 010-2200 about a recall please." } });
    expect(wrongPhone.statusCode).toBe(422);
  });

  it("the voicemail script and its preview speak Birch Avenue, its phone and its pharmacist", async () => {
    const { app, c2, c7 } = await webRig();
    const d = (await app.inject({ url: `/api/recalls/${RECALL}/voicemail`, headers: { cookie: c2 } })).json();
    expect(d.sampleText).toContain("Birch Avenue Pharmacy");
    expect(d.sampleText).toContain("5 5 5, 0 1 0, 2 3 0 0");
    expect(d.sampleText).toContain("Sam Okoro");
    expect(JSON.stringify(d)).not.toMatch(STORE7_IDENTITY);
    const p = (await app.inject({ method: "POST", url: `/api/recalls/${RECALL}/voicemail/preview`, headers: { cookie: c2 }, payload: { script: d.script } })).json();
    expect(p.text).toContain("Birch Avenue Pharmacy");
    expect(p.text).not.toMatch(STORE7_IDENTITY);
    expect(p.problems).toEqual([]);
    // rule 9: no medicine, no recall reason in a voicemail
    expect(p.text.toLowerCase()).not.toMatch(/insulin|recall|sterile/);
    // Store 7 is still itself
    const d7 = (await app.inject({ url: `/api/recalls/${RECALL}/voicemail`, headers: { cookie: c7 } })).json();
    expect(d7.sampleText).toContain("Elm Street Pharmacy");
    expect(d7.sampleText).toContain("5 5 5, 0 1 0, 2 2 0 0");
    expect(d7.sampleText).toContain("Jordan Rivera");
    expect(d7.sampleText).not.toMatch(/Birch|2 3 0 0/);
    // a script that names the other store is a problem
    const bad = (await app.inject({ method: "POST", url: `/api/recalls/${RECALL}/voicemail/preview`, headers: { cookie: c2 }, payload: { script: d.script.replace("{pharmacy_name}", "Elm Street Pharmacy") } })).json();
    expect(bad.problems.join(" ")).toMatch(/another store/);
  });

  it("the exported PDF heading and body carry the store of the person who exports it", async () => {
    const { app, c2, c7 } = await webRig();
    const t2 = pdfText((await app.inject({ url: `/api/recalls/${RECALL}/report.pdf`, headers: { cookie: c2 } })).rawPayload);
    expect(t2).toContain("Birch Avenue Pharmacy · Store 2");
    expect(t2).toContain("(555) 010-2300");
    expect(t2).not.toMatch(/Elm Street|Store 7|010-2200/);
    const t7 = pdfText((await app.inject({ url: `/api/recalls/${RECALL}/report.pdf`, headers: { cookie: c7 } })).rawPayload);
    expect(t7).toContain("Elm Street Pharmacy · Store 7");
    expect(t7).toContain("(555) 010-2200");
    expect(t7).not.toMatch(/Birch|010-2300/);
  });

  it("the AI drafters in Store 2 use Store 2's identity and gate on Store 2's phone", async () => {
    const { ctx } = await webRig();
    const rec = await inStore(ctx, STORE_2, () => runAgent(ctx, okoro, "outreach-drafter", { recallId: RECALL }));
    const drafts = (rec.extra as any).drafts as { text: string; channel: string }[];
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) { expect(d.text).not.toMatch(STORE7_IDENTITY); }
    expect(drafts.filter((d) => d.channel === "sms").every((d) => d.text.includes("Birch Avenue Pharmacy") && d.text.includes("(555) 010-2300") && /STOP/.test(d.text))).toBe(true);
    const refill = await inStore(ctx, STORE_2, () => runAgent(ctx, okoro, "refill-outreach", {}));
    for (const d of ((refill.extra as any).drafts ?? []) as { text: string }[]) expect(d.text).not.toMatch(STORE7_IDENTITY);
    // the gate checks the CURRENT store's phone: Store 7's phone does not pass in Store 2, Store 2's does
    const { pieceProblem } = await import("../src/agents/outreach");
    const sms = (phone: string) => inStore(ctx, STORE_2, () => pieceProblem(ctx, "sms", `Hi {first_name}, call ${phone} please. Reply STOP to opt out.`));
    expect(sms("(555) 010-2200")).toMatch(/phone number|Contains/);
    expect(sms("(555) 010-2300")).toBeNull();
  });
});
