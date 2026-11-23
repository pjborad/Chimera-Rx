import { activeRecallFor, audit, ensureLot, HttpError, lotEvent, type Actor, type Ctx } from "./core";
import crypto from "node:crypto";
import type { Db } from "./db";
import { suggestLocation } from "./domain";

/**
 * What crosses between the two stores, and nothing else (FR4.3, Q4):
 *  - a pharmacist can move on-shelf packages to the other store; each package keeps its lot and serial;
 *  - a recall confirmed in one store is mirrored to the other, so the lot is blocked at receiving, fill, the register
 *    and transfers in both. Each store still lists only its own units and patients.
 *
 * Two SQLite files cannot share a transaction, so both flows are durable state machines that can be finished or undone
 * after a crash (REV-F02, REV-F05):
 *  - transfers (source store): reserved -> received -> completed, or cancelled. `reconcileTransfers` finishes or rolls back
 *    whatever is left; at most one store offers a serial at any point.
 *  - recall_propagation (source store): pending/failed -> done. `retryPropagations` repeats what did not reach the other store.
 */

const tables = new WeakSet<Db>();
/** Create the cross-store bookkeeping tables in a store's own database (idempotent). */
function ensureCrossTables(ctx: Ctx) {
  const db = ctx.stores ? ctx.stores.db(ctx.stores.current) : ctx.db;
  if (tables.has(db)) return;
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY, to_store TEXT, to_name TEXT, from_name TEXT, state TEXT, lot_id INTEGER, ndc11 TEXT, lot TEXT, expiry TEXT,
      product TEXT, storage TEXT, qty INTEGER, items TEXT, by_id TEXT, by_name TEXT, by_workstation TEXT, error TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS transfer_receipts (transfer_id TEXT PRIMARY KEY, from_store TEXT, units INTEGER, received_at INTEGER);
    CREATE TABLE IF NOT EXISTS recall_propagation (
      recall_id TEXT, dest_store TEXT, state TEXT, attempts INTEGER DEFAULT 0, last_error TEXT, updated_at INTEGER, PRIMARY KEY (recall_id, dest_store)
    );
  `);
  tables.add(db);
}


export function otherStores(ctx: Ctx, actor: Actor): { id: string; name: string }[] {
  const reg = ctx.stores;
  if (!reg) return [];
  return reg.others(actor.storeId).map((id) => reg.run(id, () => ctx.db.get<{ id: string; name: string }>("SELECT id, name FROM stores")!));
}


export interface TransferInput { toStore: string; lotId: number; qty: number; /** optional client-chosen id; repeating a transfer with the same id is safe */ transferId?: string }

interface TransferRow {
  id: string; to_store: string; to_name: string; from_name: string; state: string; lot_id: number; ndc11: string; lot: string; expiry: string;
  product: string; storage: string; qty: number; items: string; by_id: string; by_name: string; by_workstation: string; error: string | null; created_at: number; updated_at: number;
}
interface Item { id: number; gtin: string; serial: string; expiry: string }

const OPEN_STATES = ["reserved", "received"];
const asActor = (t: TransferRow, storeId: string): Actor => ({ id: t.by_id, name: t.by_name, role: "pharmacist", storeId, workstation: t.by_workstation });
const setState = (ctx: Ctx, id: string, state: string, error: string | null = null) =>
  ctx.db.run("UPDATE transfers SET state = ?, error = ?, updated_at = ? WHERE id = ?", state, error, ctx.now(), id);
const result = (t: TransferRow) => {
  const items = JSON.parse(t.items) as Item[];
  return { transferId: t.id, state: t.state, moved: items.length, lot: t.lot, product: t.product, from: t.from_name, to: t.to_name, serials: items.map((k) => k.serial), summary: `To ${t.to_name} · ${items.length} units` };
};

/** Step 2, run inside the DESTINATION store: idempotent receipt keyed by the transfer id. Refusals are HttpErrors and change nothing. */
function receiveTransfer(ctx: Ctx, t: TransferRow, fromStore: string) {
  const storeId = t.to_store;
  ensureCrossTables(ctx);
  if (ctx.db.get("SELECT 1 FROM transfer_receipts WHERE transfer_id = ?", t.id)) return; // a second attempt does nothing
  if (activeRecallFor(ctx, t.ndc11, t.lot)) throw new HttpError(409, `Lot ${t.lot} is in a recall at ${t.to_name}, so it cannot be moved there.`, "recalled");
  if (!ctx.db.get("SELECT 1 FROM products WHERE ndc11 = ?", t.ndc11)) throw new HttpError(409, `${t.to_name} does not stock ${t.product}.`, "no_product");
  const items = JSON.parse(t.items) as Item[];
  ctx.db.tx(() => {
    const lotId = ensureLot(ctx, t.ndc11, t.lot, t.expiry);
    const loc = suggestLocation({ ndc11: t.ndc11, name: t.product, storage: t.storage as any });
    for (const k of items) {
      const have = ctx.db.get<{ id: number }>("SELECT id FROM packages WHERE gtin = ? AND serial = ?", k.gtin, k.serial);
      let id: number;
      if (have) { id = have.id; ctx.db.run("UPDATE packages SET status = 'on_shelf', lot_id = ?, location = ?, zone = ?, note = ? WHERE id = ?", lotId, loc.location, loc.zone, `Transferred from ${t.from_name} (transfer ${t.id})`, id); }
      else id = Number(ctx.db.run("INSERT INTO packages (serial, lot_id, gtin, expiry, location, zone, status, delivery_id, received_at, received_by, note) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        k.serial, lotId, k.gtin, k.expiry, loc.location, loc.zone, "on_shelf", null, ctx.now(), t.by_name, `Transferred from ${t.from_name} (transfer ${t.id})`).lastInsertRowid);
      lotEvent(ctx, "Transfer in", lotId, t.by_name, `From ${t.from_name}`, id);
    }
    audit(ctx, asActor(t, storeId), "stock.transfer_in", "lot", lotId, undefined, { lot: t.lot, units: items.length, from: t.from_name, transferId: t.id });
    ctx.db.run("INSERT INTO transfer_receipts (transfer_id, from_store, units, received_at) VALUES (?,?,?,?)", t.id, fromStore, items.length, ctx.now());
  });
}

/** Step 3, in the SOURCE store: the reserved packages leave for good and the transfer is completed. One transaction. */
function completeTransfer(ctx: Ctx, t: TransferRow, by: Actor) {
  const items = JSON.parse(t.items) as Item[];
  ctx.db.tx(() => {
    for (const k of items) {
      const n = ctx.db.run("UPDATE packages SET status = 'adjusted', note = ? WHERE id = ? AND status = 'in_transit'", `Transferred to ${t.to_name} (transfer ${t.id})`, k.id);
      if (n.changes) lotEvent(ctx, "Transfer out", t.lot_id, by.name, `To ${t.to_name}`, k.id);
    }
    audit(ctx, by, "stock.transfer_out", "lot", t.lot_id, undefined, { lot: t.lot, units: items.length, to: t.to_name, transferId: t.id });
    setState(ctx, t.id, "completed");
  });
}

/** Undo step 1: the packages go back to the shelf (or to quarantine when their lot has been recalled meanwhile). One transaction. */
function releaseTransfer(ctx: Ctx, t: TransferRow, by: Actor, why: string) {
  const items = JSON.parse(t.items) as Item[];
  const recalled = !!activeRecallFor(ctx, t.ndc11, t.lot);
  ctx.db.tx(() => {
    for (const k of items) {
      const n = recalled
        ? ctx.db.run("UPDATE packages SET status = 'quarantined', location = 'Quarantine Q-1', zone = 'quarantine', note = ? WHERE id = ? AND status = 'in_transit'", `Transfer ${t.id} cancelled: ${why}`, k.id)
        : ctx.db.run("UPDATE packages SET status = 'on_shelf', note = ? WHERE id = ? AND status = 'in_transit'", `Transfer ${t.id} cancelled: ${why}`, k.id);
      if (n.changes) lotEvent(ctx, "Released", t.lot_id, by.name, `Transfer to ${t.to_name} cancelled: ${why}`, k.id);
    }
    audit(ctx, by, "stock.transfer_cancelled", "lot", t.lot_id, undefined, { lot: t.lot, units: items.length, to: t.to_name, transferId: t.id, why });
    setState(ctx, t.id, "cancelled", why);
  });
}

const getTransfer = (ctx: Ctx, id: string) => ctx.db.get<TransferRow>("SELECT * FROM transfers WHERE id = ?", id);

/** Carry a reserved or received transfer through steps 2 and 3. Errors that leave the destination untouched and final cancel the transfer. */
function advance(ctx: Ctx, reg: NonNullable<Ctx["stores"]>, t: TransferRow, by: Actor) {
  const source = reg.current;
  if (t.state === "reserved") {
    try { reg.run(t.to_store, () => receiveTransfer(ctx, t, source)); }
    catch (e) {
      if (e instanceof HttpError) { releaseTransfer(ctx, t, by, e.message); throw e; } // the destination refused; nothing was written there
      setState(ctx, t.id, "reserved", (e as Error).message); // unknown failure: stays visible and recoverable
      throw e;
    }
    setState(ctx, t.id, "received");
    t = { ...t, state: "received" };
  }
  completeTransfer(ctx, t, by);
}

export function transferPackages(ctx: Ctx, actor: Actor, input: TransferInput) {
  const reg = ctx.stores;
  if (!reg) throw new HttpError(501, "Only one store is set up.", "single_store");
  if (actor.role !== "pharmacist") throw new HttpError(403, "Only a pharmacist can move stock between stores.", "forbidden");
  if (!reg.others(actor.storeId).includes(input.toStore)) throw new HttpError(422, "Choose the other store.", "bad_store");
  if (!Number.isInteger(input.qty) || input.qty < 1 || input.qty > 100) throw new HttpError(422, "Move 1 to 100 packages.", "bad_qty");
  if (input.transferId !== undefined && !/^[0-9a-f-]{36}$/i.test(input.transferId)) throw new HttpError(422, "The transfer id must be a UUID.", "bad_transfer_id");
  ensureCrossTables(ctx);

  // A repeat of the same transfer id: finish what is left, never start a second move.
  const prior = input.transferId ? getTransfer(ctx, input.transferId) : undefined;
  if (prior) {
    if (prior.to_store !== input.toStore || prior.lot_id !== input.lotId) throw new HttpError(409, "That transfer id belongs to a different move.", "transfer_id_reused");
    if (prior.state === "cancelled") throw new HttpError(409, `That transfer was cancelled: ${prior.error ?? "it did not complete"}. Start a new one.`, "transfer_cancelled");
    if (OPEN_STATES.includes(prior.state)) advance(ctx, reg, prior, actor);
    return result(getTransfer(ctx, prior.id)!);
  }

  const lot = ctx.db.get<any>("SELECT l.*, p.ndc10, p.name, p.storage FROM lots l JOIN products p ON p.ndc11 = l.ndc11 WHERE l.id = ?", input.lotId);
  if (!lot) throw new HttpError(404, "Unknown lot.");
  // Recalled or quarantined stock never leaves (FR4.3); the same rule blocks a lot recalled in either store.
  if (lot.status === "recalled" || activeRecallFor(ctx, lot.ndc11, lot.lot)) throw new HttpError(409, `Lot ${lot.lot} is in a recall and cannot be moved.`, "recalled");
  const pkgs = ctx.db.all<any>("SELECT * FROM packages WHERE lot_id = ? AND status = 'on_shelf' ORDER BY id LIMIT ?", lot.id, input.qty);
  if (pkgs.length < input.qty) throw new HttpError(409, `Only ${pkgs.length} package${pkgs.length === 1 ? "" : "s"} of lot ${lot.lot} are on the shelf.`, "not_enough");
  const dest = reg.db(input.toStore).get<{ name: string }>("SELECT name FROM stores");
  const from = ctx.db.get<{ name: string }>("SELECT name FROM stores WHERE id = ?", actor.storeId)?.name ?? actor.storeId;

  // Check the destination first, so a refusal there leaves the source untouched.
  reg.run(input.toStore, () => {
    if (activeRecallFor(ctx, lot.ndc11, lot.lot)) throw new HttpError(409, `Lot ${lot.lot} is in a recall at ${dest?.name}, so it cannot be moved there.`, "recalled");
    if (!ctx.db.get("SELECT 1 FROM products WHERE ndc11 = ?", lot.ndc11)) throw new HttpError(409, `${dest?.name} does not stock ${lot.name}.`, "no_product");
  });

  // Step 1, one transaction in the source: the packages stop being sellable, fillable or transferable and the transfer is recorded.
  const id = input.transferId ?? crypto.randomUUID();
  const items: Item[] = pkgs.map((k) => ({ id: k.id, gtin: k.gtin, serial: k.serial, expiry: k.expiry }));
  ctx.db.tx(() => {
    ctx.db.run("INSERT INTO transfers (id, to_store, to_name, from_name, state, lot_id, ndc11, lot, expiry, product, storage, qty, items, by_id, by_name, by_workstation, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id, input.toStore, dest?.name ?? input.toStore, from, "reserved", lot.id, lot.ndc11, lot.lot, lot.expiry, lot.name, lot.storage, items.length, JSON.stringify(items), actor.id, actor.name, actor.workstation, ctx.now(), ctx.now());
    for (const k of items) ctx.db.run("UPDATE packages SET status = 'in_transit', note = ? WHERE id = ? AND status = 'on_shelf'", `In transit to ${dest?.name} (transfer ${id})`, k.id);
    audit(ctx, actor, "stock.transfer_reserved", "lot", lot.id, undefined, { lot: lot.lot, units: items.length, to: dest?.name, transferId: id });
  });
  advance(ctx, reg, getTransfer(ctx, id)!, actor);
  return result(getTransfer(ctx, id)!);
}

/** The current store's transfers, newest first, with the ones that are not finished marked. */
export function listTransfers(ctx: Ctx) {
  ensureCrossTables(ctx);
  return ctx.db.all<TransferRow>("SELECT * FROM transfers ORDER BY created_at DESC, rowid DESC LIMIT 50").map((t) => ({
    id: t.id, state: t.state, to: t.to_name, product: t.product, lot: t.lot, units: t.qty, by: t.by_name, at: t.created_at, updatedAt: t.updated_at, error: t.error, incomplete: OPEN_STATES.includes(t.state)
  }));
}

/**
 * Finish or undo every unfinished transfer of the current store, deterministically: if the destination holds the receipt the
 * transfer completes; if not, the source packages go back to the shelf. Safe to run at any time and as often as you like.
 */
export function reconcileTransfers(ctx: Ctx, by?: Actor | null): { completed: string[]; cancelled: string[]; failed: { id: string; error: string }[] } {
  const out = { completed: [] as string[], cancelled: [] as string[], failed: [] as { id: string; error: string }[] };
  const reg = ctx.stores;
  if (!reg) return out;
  ensureCrossTables(ctx);
  for (const t of ctx.db.all<TransferRow>(`SELECT * FROM transfers WHERE state IN ('reserved','received') ORDER BY created_at, rowid`)) {
    const who = by ?? asActor(t, reg.current);
    const actor: Actor = { ...who, id: by?.id ?? "system", name: by ? by.name : "System · transfer recovery" };
    try {
      const received = reg.run(t.to_store, () => { ensureCrossTables(ctx); return !!ctx.db.get("SELECT 1 FROM transfer_receipts WHERE transfer_id = ?", t.id); });
      if (received) { completeTransfer(ctx, t, actor); out.completed.push(t.id); }
      else { releaseTransfer(ctx, t, actor, "the other store never received it"); out.cancelled.push(t.id); }
    } catch (e) {
      out.failed.push({ id: t.id, error: (e as Error).message });
    }
  }
  return out;
}

/** Mirror a recall confirmed here into the other store(s), then quarantine what that store holds of the lots. Repeatable and resumable. */
export function propagateRecall(ctx: Ctx, recallId: string, quarantine: (ctx: Ctx, actor: Actor | null, recallId: string) => number) {
  const reg = ctx.stores;
  if (!reg) return;
  const me = reg.current;
  const r = ctx.db.get<any>("SELECT * FROM recalls WHERE id = ?", recallId);
  if (!r || r.source === "other-store") return;
  if (!localConfirmedLots(ctx, recallId).length) return;
  ensureCrossTables(ctx);
  for (const other of reg.others(me)) {
    // Always back to pending: a lot confirmed later has to cross too. The row is what a restart or the next tick retries from.
    ctx.db.run("INSERT INTO recall_propagation (recall_id, dest_store, state, attempts, updated_at) VALUES (?,?,'pending',0,?) ON CONFLICT(recall_id, dest_store) DO UPDATE SET state = 'pending', updated_at = excluded.updated_at", recallId, other, ctx.now());
    applyPropagation(ctx, reg, recallId, other, quarantine);
  }
}

/** Lots this store confirmed itself, as opposed to lots that arrived from the other store (those carry the "Confirmed at" mark). */
const MIRROR_MARK = "Confirmed at ";
const localConfirmedLots = (ctx: Ctx, recallId: string) =>
  ctx.db.all<any>("SELECT * FROM recall_lots WHERE recall_id = ? AND confirmed_at IS NOT NULL AND (confirmed_by IS NULL OR confirmed_by NOT LIKE ?)", recallId, `${MIRROR_MARK}%`);

function applyPropagation(ctx: Ctx, reg: NonNullable<Ctx["stores"]>, recallId: string, dest: string, quarantine: (ctx: Ctx, actor: Actor | null, recallId: string) => number) {
  const me = reg.current;
  const r = ctx.db.get<any>("SELECT * FROM recalls WHERE id = ?", recallId);
  const lots = localConfirmedLots(ctx, recallId);
  const fromName = ctx.db.get<{ name: string }>("SELECT name FROM stores WHERE id = ?", me)?.name ?? me;
  try {
    reg.run(dest, () => {
      const now = ctx.now();
      const day = new Date(now).toISOString().slice(0, 10);
      const note = `${MIRROR_MARK}${fromName} on ${day}`;
      let changed = 0;
      ctx.db.tx(() => {
        if (!ctx.db.get("SELECT 1 FROM recalls WHERE id = ?", recallId)) {
          ctx.db.run(
            `INSERT INTO recalls (id, step, status, classification, level, reason, firm, initiated, product, code_info, product_description, raw_json, source, fax_text, created_at, created_by, cached)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            recallId, "impact", "reviewing", r.classification, r.level, r.reason, r.firm, r.initiated, r.product, r.code_info, r.product_description, r.raw_json, "other-store", null, now, `Confirmed at ${fromName}`, r.cached);
          changed++;
        }
        for (const l of lots) {
          const have = ctx.db.get<any>("SELECT * FROM recall_lots WHERE recall_id = ? AND upper(lot) = upper(?)", recallId, l.lot);
          if (!have) {
            ctx.db.run("INSERT INTO recall_lots (recall_id, lot, ndc11, expiry, confidence, source, confirmed_by, confirmed_at) VALUES (?,?,?,?,?,?,?,?)", recallId, l.lot, l.ndc11, l.expiry, l.confidence, "other-store", note, now);
            changed++;
          } else if (!have.confirmed_at) {
            // a lot this store already looked up but never confirmed: confirm it, and fill in what it lacked. A confirmed row is never touched.
            ctx.db.run("UPDATE recall_lots SET confirmed_by = ?, confirmed_at = ?, ndc11 = CASE WHEN ndc11 IS NULL OR ndc11 = '' THEN ? ELSE ndc11 END, expiry = CASE WHEN expiry IS NULL OR expiry = '' THEN ? ELSE expiry END WHERE id = ? AND confirmed_at IS NULL", note, now, l.ndc11, l.expiry, have.id);
            changed++;
          }
        }
        if (changed) audit(ctx, null, "recall.mirrored", "recall", recallId, undefined, { from: fromName, lots: lots.map((l) => l.lot) });
      });
      quarantine(ctx, null, recallId); // idempotent: moves nothing it has already moved
    });
    ctx.db.run("UPDATE recall_propagation SET state = 'done', last_error = NULL, updated_at = ? WHERE recall_id = ? AND dest_store = ?", ctx.now(), recallId, dest);
  } catch (e) {
    ctx.db.run("UPDATE recall_propagation SET state = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE recall_id = ? AND dest_store = ?", (e as Error).message.slice(0, 300), ctx.now(), recallId, dest);
    audit(ctx, null, "recall.propagation_failed", "recall", recallId, undefined, { to: dest, error: (e as Error).message.slice(0, 200) });
  }
}

/** Run at start-up and every minute, once per store: repeat every propagation that did not reach its destination. */
export function retryPropagations(ctx: Ctx, quarantine: (ctx: Ctx, actor: Actor | null, recallId: string) => number): number {
  const reg = ctx.stores;
  if (!reg) return 0;
  ensureCrossTables(ctx);
  let n = 0;
  for (const p of ctx.db.all<{ recall_id: string; dest_store: string }>("SELECT recall_id, dest_store FROM recall_propagation WHERE state <> 'done' ORDER BY updated_at")) {
    if (!reg.has(p.dest_store)) continue;
    applyPropagation(ctx, reg, p.recall_id, p.dest_store, quarantine);
    n++;
  }
  return n;
}

/** What has not yet crossed to the other store, for the recall screen and the tests. */
export function pendingPropagations(ctx: Ctx) {
  ensureCrossTables(ctx);
  return ctx.db.all<{ recall_id: string; dest_store: string; state: string; attempts: number; last_error: string | null }>("SELECT recall_id, dest_store, state, attempts, last_error FROM recall_propagation WHERE state <> 'done'");
}
