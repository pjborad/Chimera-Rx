import type { Ctx } from "./core";
import { todayIso } from "./core";
import { DAY } from "./domain";
import { findDrug } from "./drugs";

/**
 * Recall-aware refills and adherence. Everything here is deterministic: no model is involved (rules before the LLM).
 *
 * The gap it fills: refill tools know the drug and the date, not the LOT the patient last received. Chimera Rx scans the
 * lot at fill, so a refill can be held back when the last fill came from a recalled lot, and that hold survives the recall
 * being closed (pharmacy-safety rule 8).
 *
 * PDC (proportion of days covered), per patient and drug:
 *   window  = the last 180 days up to and including today, but never earlier than the patient's first fill of that drug
 *   covered = days in the window that fall inside a supply. Fills are laid end to end: a fill picked up before the
 *             previous supply ran out starts on the day that supply ends (carry-forward), so early pickups are not wasted
 *             and cannot be counted twice.
 *   PDC     = covered days / days in the window, always between 0 and 1. Below 0.80 is flagged.
 * A drug with a single fill has no refill to measure, so it is shown as "not enough history" and is never flagged.
 */

export const PDC_WINDOW_DAYS = 180;
export const PDC_FLAG_BELOW = 0.8;
export const DEFAULT_LOOKAHEAD_DAYS = 7;
export const DEFAULT_GRACE_DAYS = 7;
export const SYNC_CYCLE_DAYS = 30;
/** A drug is left out of a sync when its short fill would be shorter than this: a trip for a few days of pills is not worth it. */
export const MIN_SHORT_FILL_DAYS = 7;

const dayNum = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
const isoOf = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => isoOf(dayNum(iso) + n);
const isoFromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The grace window comes from REFILL_GRACE_DAYS when set (0 to 60), else 7. A query parameter overrides both. */
export function defaultGraceDays(): number {
  const n = Number(process.env.REFILL_GRACE_DAYS);
  return Number.isInteger(n) && n >= 0 && n <= 60 ? n : DEFAULT_GRACE_DAYS;
}

// ------------------------------------------------------------------ PDC

export interface SupplyFill { filledOn: string; daysSupply: number }
export interface PdcResult { pdc: number; coveredDays: number; windowDays: number; windowStart: string; supplyEndsOn: string | null; fills: number }

export function pdc(fills: SupplyFill[], today: string, windowDays = PDC_WINDOW_DAYS): PdcResult {
  const t = dayNum(today);
  const usable = fills.filter((f) => dayNum(f.filledOn) <= t && f.daysSupply > 0).sort((a, b) => dayNum(a.filledOn) - dayNum(b.filledOn));
  if (!usable.length) return { pdc: 0, coveredDays: 0, windowDays: 0, windowStart: today, supplyEndsOn: null, fills: 0 };
  const start = Math.max(t - (windowDays - 1), dayNum(usable[0]!.filledOn));
  const days = t - start + 1;
  let covered = 0;
  let cursor = -Infinity; // first day not yet covered by the chain of supplies
  for (const f of usable) {
    const from = Math.max(dayNum(f.filledOn), cursor);
    const to = from + Math.floor(f.daysSupply); // exclusive
    const lo = Math.max(from, start), hi = Math.min(to, t + 1);
    if (hi > lo) covered += hi - lo;
    cursor = to;
  }
  const raw = covered / days;
  return { pdc: Math.min(1, Math.max(0, raw)), coveredDays: covered, windowDays: days, windowStart: isoOf(start), supplyEndsOn: isoOf(cursor), fills: usable.length };
}

// ------------------------------------------------------------------ which medicines are current (shared by Guardian, Rx Watcher, refills)

/** A supply that ran out up to this many days ago still counts as current: patients refill late, and the safety rules should not forget them overnight. */
export const SUPPLY_GRACE_DAYS = 30;
/** A fill with no days supply on record is assumed to last this long. */
export const DEFAULT_SUPPLY_DAYS = 30;

/** Statuses that mean "on the profile". "Sold here" (a sale made in this pharmacy) is the same as an imported "Active"; anything else
 *  (Completed, Replaced, Discontinued, Stopped...) is a finished or discontinued medicine and is never current. */
export const isOnProfile = (status: string | null | undefined) => /^(active|sold here)$/i.test((status ?? "").trim());

export interface DatedFill { filled_on: string; drug: string; days_supply: number | null; status: string }

/** Is this fill a current medicine today? On the profile, and the supply (filled_on + days supply + grace) has not run out. */
export function isCurrentMedicine(h: DatedFill, today: string, opts: { ignoreSupply?: boolean } = {}): boolean {
  if (!isOnProfile(h.status)) return false;
  if (opts.ignoreSupply) return true;
  const supply = h.days_supply && h.days_supply > 0 ? h.days_supply : DEFAULT_SUPPLY_DAYS;
  return dayNum(today) - dayNum(h.filled_on) <= supply + SUPPLY_GRACE_DAYS;
}

/**
 * One fill that appears twice (the imported history and our own sale record) is one fill. Same drug (the known drug, else the name
 * before the "·") and same date; the imported row wins because it carries the prescriber's own record. `local` says which row came from a sale made here.
 */
export function dedupeFills<T>(rows: T[], key: (r: T) => { on: string; drug: string; local: boolean }): T[] {
  const best = new Map<string, T>();
  const order: string[] = [];
  for (const r of rows) {
    const k = key(r);
    const id = `${findDrug(k.drug)?.id ?? k.drug.split("·")[0]!.trim().toLowerCase()}|${k.on}`;
    const had = best.get(id);
    if (!had) { best.set(id, r); order.push(id); } else if (key(had).local && !k.local) best.set(id, r);
  }
  return order.map((id) => best.get(id)!);
}

/** THE definition of "currently active medicine" for the interaction, duplicate-therapy and late-refill rules. */
export function currentMedicines<T extends DatedFill>(history: T[], today: string, opts: { ignoreSupply?: boolean } = {}): T[] {
  return dedupeFills(history, (h) => ({ on: h.filled_on, drug: h.drug, local: /^sold here$/i.test(h.status) })).filter((h) => isCurrentMedicine(h, today, opts));
}

// ------------------------------------------------------------------ fills, from the history and from fills made here

export interface Fill {
  patientId: string; groupKey: string; drug: string; ndc11: string; filledOn: string; daysSupply: number; lot: string; rx: string;
  refillsLeft: number | null; status: string; source: "history" | "fill"; autoRefill: boolean;
}

const drugBase = (d: string) => (d.split("·")[0] ?? d).trim();
const groupKeyOf = (ndc11: string, drug: string) => (ndc11 ? `ndc:${ndc11}` : `drug:${drugBase(drug).toLowerCase()}`);

/** Fill history: the imported medication history plus prescriptions sold here that carry a days supply. */
export function loadFills(ctx: Ctx): Fill[] {
  const out: Fill[] = [];
  for (const h of ctx.db.all<any>("SELECT patient_id, filled_on, ndc11, drug, lot, days_supply, status, auto_refill, refills_left FROM med_history")) {
    if (!h.filled_on || !h.days_supply) continue;
    out.push({ patientId: h.patient_id, groupKey: groupKeyOf(h.ndc11 ?? "", h.drug ?? ""), drug: drugBase(h.drug ?? ""), ndc11: h.ndc11 ?? "", filledOn: h.filled_on, daysSupply: Number(h.days_supply), lot: h.lot ?? "", rx: "", refillsLeft: h.refills_left ?? null, status: h.status ?? "Active", source: "history", autoRefill: !!h.auto_refill });
  }
  for (const d of ctx.db.all<any>(
    `SELECT r.patient_id, r.ndc11, r.drug, r.rx, r.refills, r.days_supply, d.sold_at, d.filled_at, l.lot
     FROM dispenses d JOIN prescriptions r ON r.id = d.rx_id JOIN packages k ON k.id = d.package_id JOIN lots l ON l.id = k.lot_id
     WHERE d.state = 'sold' AND r.days_supply IS NOT NULL AND r.days_supply > 0`)) {
    const at = d.sold_at ?? d.filled_at;
    if (!at) continue;
    out.push({ patientId: d.patient_id, groupKey: groupKeyOf(d.ndc11 ?? "", d.drug ?? ""), drug: drugBase(d.drug ?? ""), ndc11: d.ndc11 ?? "", filledOn: isoFromMs(at), daysSupply: Number(d.days_supply), lot: d.lot ?? "", rx: d.rx ?? "", refillsLeft: d.refills ?? null, status: "Active", source: "fill", autoRefill: false });
  }
  return out;
}

/** A patient's fill history as the safety rules read it: the imported history plus medicines sold here (status "Sold here"). */
export interface PatientFill { filled_on: string; ndc11: string; drug: string; sig: string; qty: number; days_supply: number; status: string; lot: string; prescriber: string }

export function loadPatientHistory(ctx: Ctx, patientId: string): PatientFill[] {
  const out: PatientFill[] = ctx.db.all<any>("SELECT filled_on, ndc11, drug, sig, qty, days_supply, status, lot, prescriber FROM med_history WHERE patient_id = ? ORDER BY filled_on DESC", patientId)
    .map((h) => ({ filled_on: h.filled_on, ndc11: h.ndc11 ?? "", drug: h.drug ?? "", sig: h.sig ?? "", qty: h.qty ?? 0, days_supply: Number(h.days_supply ?? 0), status: h.status ?? "", lot: h.lot ?? "", prescriber: h.prescriber ?? "" }));
  for (const d of ctx.db.all<any>(
    `SELECT r.ndc11, r.drug, r.qty, r.directions, r.prescriber, r.days_supply, d.sold_at, d.filled_at, l.lot
     FROM dispenses d JOIN prescriptions r ON r.id = d.rx_id LEFT JOIN packages k ON k.id = d.package_id LEFT JOIN lots l ON l.id = k.lot_id
     WHERE r.patient_id = ? AND d.state = 'sold'`, patientId)) {
    const at = d.sold_at ?? d.filled_at;
    if (!at) continue;
    out.push({ filled_on: isoFromMs(at), ndc11: d.ndc11 ?? "", drug: d.drug ?? "", sig: d.directions ?? "", qty: d.qty ?? 0, days_supply: Number(d.days_supply ?? 0), status: "Sold here", lot: d.lot ?? "", prescriber: d.prescriber ?? "" });
  }
  return out.sort((a, b) => b.filled_on.localeCompare(a.filled_on));
}

// ------------------------------------------------------------------ Schedule II and lot blocks

const C2_NAMES = /oxycodone|hydrocodone|morphine|hydromorphone|fentanyl|methadone|oxymorphone|tapentadol|methylphenidate|amphetamine|dextroamphetamine|lisdexamfetamine|cocaine|codeine/i;

/** Schedule II drugs are never auto-refillable: the product is stored in the controlled safe, or the name is a known C-II drug. */
export function isScheduleII(ctx: Ctx, ndc11: string, drug: string): boolean {
  if (ndc11 && ctx.db.get<{ storage: string }>("SELECT storage FROM products WHERE ndc11 = ?", ndc11)?.storage === "c2") return true;
  return C2_NAMES.test(drug);
}

export interface LotBlock { blocked: boolean; lot: string; recallId: string | null; reason: string }

/**
 * Is this lot recalled or quarantined? The lot row stays 'recalled' after a recall is closed (rule 8), and a confirmed recall lot
 * counts even for a lot this store never received into its own ledger (history imported from elsewhere).
 */
export function lotBlock(ctx: Ctx, lot: string, ndc11: string): LotBlock {
  const none: LotBlock = { blocked: false, lot, recallId: null, reason: "" };
  if (!lot) return none;
  const rl = ctx.db.get<{ recall_id: string }>(
    "SELECT recall_id FROM recall_lots WHERE upper(lot) = upper(?) AND confirmed_at IS NOT NULL AND (ndc11 = '' OR ndc11 IS NULL OR ? = '' OR ndc11 = ?) ORDER BY recall_id LIMIT 1", lot, ndc11, ndc11);
  const row = ctx.db.get<{ status: string }>(
    "SELECT status FROM lots WHERE upper(lot) = upper(?) AND (? = '' OR ndc11 = ?) AND status IN ('recalled','quarantined') LIMIT 1", lot, ndc11, ndc11);
  if (!rl && !row) return none;
  const recallId = rl?.recall_id ?? null;
  return { blocked: true, lot, recallId, reason: `Last fill came from lot ${lot}, which is ${recallId ? `part of recall ${recallId}` : "recalled"}. The refill is not offered for that lot.` };
}

// ------------------------------------------------------------------ the worklist

export type DueState = "upcoming" | "due" | "overdue" | "ok";
export type RowAction = "offer" | "blocked_recall" | "needs_new_rx" | "no_refills";

export interface RefillRow {
  patientId: string; patientName: string; drug: string; ndc11: string; lastFilledOn: string; daysSupply: number; lot: string; rx: string;
  dueOn: string; daysUntilDue: number; state: DueState; refillsLeft: number | null; autoRefill: boolean;
  pdc: number; pdcPercent: number; adherenceFlag: boolean; enoughHistory: boolean;
  scheduleII: boolean; action: RowAction; actionText: string; eligible: boolean;
  block: LotBlock | null;
}

export interface AdherenceRow { patientId: string; patientName: string; drug: string; pdc: number; pdcPercent: number; coveredDays: number; windowDays: number; flagged: boolean; enoughHistory: boolean; fills: number }
export interface SyncItem { drug: string; dueOn: string; fillDays: number; kind: "full" | "short" }
export interface SyncSuggestion { patientId: string; patientName: string; pickupOn: string; cycleDays: number; items: SyncItem[]; note: string }

export interface RefillOptions { graceDays?: number; lookaheadDays?: number; today?: string }

const stateOf = (daysUntilDue: number, grace: number, lookahead: number): DueState =>
  daysUntilDue > lookahead ? "ok" : daysUntilDue > 0 ? "upcoming" : daysUntilDue >= -grace ? "due" : "overdue";

export interface RefillReport {
  today: string; graceDays: number; lookaheadDays: number; pdcWindowDays: number; flagBelow: number;
  worklist: RefillRow[]; adherence: AdherenceRow[]; sync: SyncSuggestion[];
  counts: { due: number; blocked: number; needsNewRx: number; lowAdherence: number; offer: number };
}

export function refillReport(ctx: Ctx, opts: RefillOptions = {}): RefillReport {
  const today = opts.today ?? todayIso(ctx);
  const grace = opts.graceDays ?? defaultGraceDays();
  const lookahead = opts.lookaheadDays ?? DEFAULT_LOOKAHEAD_DAYS;
  const groups = new Map<string, Fill[]>();
  for (const f of loadFills(ctx)) {
    if (/^replaced$/i.test(f.status)) continue; // a replaced fill never counts as supply (it was swapped for another fill)
    const k = `${f.patientId}|${f.groupKey}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(f);
  }
  const nameOf = new Map<string, string>(ctx.db.all<{ id: string; name: string }>("SELECT id, name FROM patients").map((p) => [p.id, p.name]));
  const rows: RefillRow[] = [];
  const adherence: AdherenceRow[] = [];
  for (const fills of groups.values()) {
    fills.sort((a, b) => dayNum(a.filledOn) - dayNum(b.filledOn) || a.daysSupply - b.daysSupply);
    // the same fill seen twice (imported history and our own sale) is counted once
    fills.splice(0, fills.length, ...dedupeFills(fills, (f) => ({ on: f.filledOn, drug: f.drug, local: f.source === "fill" })));
    const last = fills[fills.length - 1]!;
    if (dayNum(last.filledOn) > dayNum(today)) continue;
    if (!isOnProfile(last.status)) continue; // a finished short course is not a refill candidate
    const m = pdc(fills, today);
    const enough = fills.filter((f) => dayNum(f.filledOn) <= dayNum(today)).length >= 2;
    const flagged = enough && m.pdc < PDC_FLAG_BELOW;
    const patientName = nameOf.get(last.patientId) ?? last.patientId;
    adherence.push({ patientId: last.patientId, patientName, drug: last.drug, pdc: m.pdc, pdcPercent: Math.round(m.pdc * 1000) / 10, coveredDays: m.coveredDays, windowDays: m.windowDays, flagged, enoughHistory: enough, fills: m.fills });

    const dueOn = m.supplyEndsOn ?? addDays(last.filledOn, last.daysSupply);
    const daysUntilDue = dayNum(dueOn) - dayNum(today);
    const state = stateOf(daysUntilDue, grace, lookahead);
    const c2 = isScheduleII(ctx, last.ndc11, last.drug);
    const block = lotBlock(ctx, last.lot, last.ndc11);
    let action: RowAction = "offer";
    let actionText = "Offer the refill.";
    if (block.blocked) { action = "blocked_recall"; actionText = `Blocked. ${block.reason}${block.recallId ? ` See recall ${block.recallId}.` : ""}`; }
    else if (c2) { action = "needs_new_rx"; actionText = "Needs a new prescription. Schedule II is never refilled automatically."; }
    else if (last.refillsLeft === 0) { action = "no_refills"; actionText = "No refills left. Ask the prescriber for a renewal."; }
    rows.push({
      patientId: last.patientId, patientName, drug: last.drug, ndc11: last.ndc11, lastFilledOn: last.filledOn, daysSupply: last.daysSupply, lot: last.lot, rx: last.rx,
      dueOn, daysUntilDue, state, refillsLeft: last.refillsLeft, autoRefill: last.autoRefill, pdc: m.pdc, pdcPercent: Math.round(m.pdc * 1000) / 10, adherenceFlag: flagged, enoughHistory: enough,
      scheduleII: c2, action, actionText, eligible: action === "offer", block: block.blocked ? block : null
    });
  }
  const order: Record<DueState, number> = { overdue: 0, due: 1, upcoming: 2, ok: 3 };
  rows.sort((a, b) => (a.action === "blocked_recall" ? -1 : 0) - (b.action === "blocked_recall" ? -1 : 0) || order[a.state] - order[b.state] || a.daysUntilDue - b.daysUntilDue || a.patientId.localeCompare(b.patientId));
  const worklist = rows.filter((r) => r.state !== "ok");
  adherence.sort((a, b) => a.pdc - b.pdc || a.patientId.localeCompare(b.patientId));
  const sync = syncSuggestions(rows.filter((r) => r.eligible && r.daysUntilDue <= SYNC_CYCLE_DAYS), today);
  return {
    today, graceDays: grace, lookaheadDays: lookahead, pdcWindowDays: PDC_WINDOW_DAYS, flagBelow: PDC_FLAG_BELOW, worklist, adherence, sync,
    counts: {
      due: worklist.length, blocked: worklist.filter((r) => r.action === "blocked_recall").length, needsNewRx: worklist.filter((r) => r.action === "needs_new_rx" || r.action === "no_refills").length,
      lowAdherence: adherence.filter((a) => a.flagged).length, offer: worklist.filter((r) => r.eligible).length
    }
  };
}

/**
 * Medication synchronisation. Pick ONE pickup day, the earliest run-out date (today if one has already run out). Everything the patient
 * takes is filled that day. A drug that runs out later is filled with a short supply that starts when its current supply ends and stops
 * on the common end date (pickup day + cycle), so from then on every drug is due together. A drug already due gets a full cycle.
 * Only refills that are offered count: a recalled, Schedule II or no-refill row is left out of a suggestion. A drug whose short fill
 * would be under MIN_SHORT_FILL_DAYS is left for the next cycle.
 */
export function syncSuggestions(eligible: { patientId: string; patientName: string; drug: string; dueOn: string }[], today: string, cycle = SYNC_CYCLE_DAYS): SyncSuggestion[] {
  const byPatient = new Map<string, typeof eligible>();
  for (const r of eligible) (byPatient.get(r.patientId) ?? byPatient.set(r.patientId, []).get(r.patientId)!).push(r);
  const out: SyncSuggestion[] = [];
  for (const [patientId, list] of byPatient) {
    if (list.length < 2) continue;
    const earliest = list.map((r) => dayNum(r.dueOn)).reduce((a, b) => Math.min(a, b));
    const pickup = Math.max(dayNum(today), earliest);
    const endDay = pickup + cycle;
    const items: SyncItem[] = list.map((r) => {
      const due = dayNum(r.dueOn);
      if (due <= pickup) return { drug: r.drug, dueOn: r.dueOn, fillDays: cycle, kind: "full" as const };
      const days = endDay - due;
      return { drug: r.drug, dueOn: r.dueOn, fillDays: Math.max(0, Math.min(cycle, days)), kind: days >= cycle ? "full" as const : "short" as const };
    }).filter((i) => i.fillDays >= MIN_SHORT_FILL_DAYS).sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.drug.localeCompare(b.drug));
    if (items.length < 2) continue;
    const shorts = items.filter((i) => i.kind === "short");
    out.push({
      patientId, patientName: list[0]!.patientName, pickupOn: isoOf(pickup), cycleDays: cycle, items,
      note: shorts.length ? `One trip on ${isoOf(pickup)}. ${shorts.map((s) => `${s.drug} is a ${s.fillDays}-day short fill`).join("; ")}, then everything is due together on ${isoOf(endDay)}.` : `One trip on ${isoOf(pickup)}. Everything is already due together.`
    });
  }
  return out.sort((a, b) => a.pickupOn.localeCompare(b.pickupOn) || a.patientId.localeCompare(b.patientId));
}

/** Per-recipient merge fields for a refill message: first name, and the drugs due. Read at send time, never stored. */
export function refillFields(ctx: Ctx, patientId: string, pharmacist = "your pharmacist", report?: RefillReport) {
  const rep = report ?? refillReport(ctx);
  const mine = rep.worklist.filter((r) => r.patientId === patientId && r.eligible);
  const name = ctx.db.get<{ name: string }>("SELECT name FROM patients WHERE id = ?", patientId)?.name ?? "";
  return { first_name: name.split(" ")[0] ?? "", drug_name: mine.map((r) => r.drug).join(" and ") || "your prescription", pharmacist, due: mine.length };
}
