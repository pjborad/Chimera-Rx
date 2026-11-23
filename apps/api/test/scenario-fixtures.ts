import { audit, HttpError, todayIso, type Actor, type Ctx } from "../src/core";
import { gtinOf, ndc11Digits } from "../src/domain";
import { seedPartners } from "../src/integrations";
import { reviewPending } from "../src/rxwatcher";
import { expectedPackages, FILL_PACKAGES, PRODUCTS, seedDatabase } from "../src/seed";
import { ingestFaxInbox } from "../src/today";
import { lookupRecall } from "../src/recall";
import { seedStore2 } from "../src/seed-store2";
import { STORE_1, STORE_2 } from "../src/stores";

/**
 * Scenario fixtures for tests and the e2e harness (scripts/e2e/harness.ts). Each scenario reseeds the synthetic data
 * to a known state, then applies a small, synthetic change. The product UI and API do not expose these.
 */

export interface ScenarioLabel { group: string; ndc10: string; lot: string; expiry: string; serial: string; note: string }

export interface Scenario {
  id: string;
  title: string;
  brief: string;
  /** where the brief sends the judge first */
  start: string;
  /** extra printable labels (printableLabels below) */
  labels?: ScenarioLabel[];
  apply?: (ctx: Ctx) => void;
}

const META_SCENARIO = "scenario";
const META_LABELS = "scenario_labels";

export const SCENARIOS: Scenario[] = [
  {
    id: "class1-recall",
    title: "Class I recall with patients to reach",
    start: "/recalls",
    brief:
      "Nightjar Biologics recalls insulin glargine lot GX4471C (D-0611-2026, Class I, synthetic). Open Recalls, enter D-0611-2026 and look it up. " +
      "The lot has an expiry and high confidence, so it is confirmed for you and every on-shelf pen moves to quarantine. The impact list shows the patients " +
      "who took a pen home, because the lot was scanned at fill. Draft the messages, tick the attestation and send: they land in the sandbox outbox only."
  },
  {
    id: "recall-aware-refill",
    title: "Recall-aware refill",
    start: "/refills",
    brief:
      "Open Refills. Priya Natarajan's insulin glargine is due and offered, and James Okafor's oxycodone says it needs a new prescription (Schedule II is never refilled automatically). " +
      "Grace Miller has a one-trip sync suggestion with short fills. Thomas Reyes is flagged for low adherence (PDC under 80%). Now open Recalls and look up D-0611-2026 (insulin glargine lot GX4471C, synthetic). " +
      "Back on Refills, Priya's row turns red: her last fill came from the recalled lot, so no refill is offered and the row links to the recall. Draft reminders for everyone else and approve them: the recalled row gets no reminder."
  },
  {
    id: "agent-catches-it",
    title: "Agent catches it: a new insulin order the history does not back",
    start: "/today",
    brief:
      "Stay on Today. A new insulin glargine order for Henry Walsh (S-0541) has just arrived (Rx 0072301). His history has late insulin fills, a semaglutide pen that is already active, " +
      "and his last insulin fill came from lot GX4471C, which is now recalled (D-0611-2026, synthetic). Rx Guardian is switched on, so within about a minute the Suggestions card on Today lights up. " +
      "To skip the wait, open AI Agents and press Run now on Rx Guardian. Open the order on Fill & pickup to see the evidence next to the order, then Accept one suggestion: the order goes on hold with the reason. " +
      "The agent never changes an order by itself, and every decision is in the audit log."
  },
  {
    id: "not-received",
    title: "Recall for a lot this store never had",
    start: "/recalls",
    brief:
      "Look up D-0603-2026 (insulin glargine lots GX4471A and GX4471B, Class I, synthetic). This store only ever received lot GX4471C, " +
      "so Chimera Rx says no units are on the shelf and no patients are affected. Nobody gets an alarming message."
  },
  {
    id: "misread-fax",
    title: "Fax with a misread lot number",
    start: "/recalls",
    brief:
      "The recall fax for D-0417-2026 in the inbox was read badly: it prints lot PRORX05O925-1 (letter O instead of zero). Open the recall. " +
      "The FDA record's lots are listed with their real stock and patients. The misread lot from the fax is kept apart, unconfirmed, " +
      "with 0 units, until you confirm or ignore it yourself. Chimera Rx never adds a lot that is not printed in the source text, and never confirms one under 0.95 confidence for you."
  },
  {
    id: "receiving-problems",
    title: "Receiving problems: warm fridge item, extra Schedule II, expired package",
    start: "/receiving",
    brief:
      "Open delivery ASH-1105-07 and print the scenario labels from Test labels. The shipper's temperature log says 11.5 °C, so the insulin pens fail the 2–8 °C check. " +
      "A second oxycodone package arrives than the invoice line allows, so the Schedule II count does not match. An amoxicillin package expired on Oct 31, 2026 " +
      "and is refused. None of them can be put away; each can only be reported."
  },
  {
    id: "suspect-product",
    title: "Suspect product: serial missing from the supplier's records",
    start: "/receiving",
    brief:
      "Open delivery ASH-1105-08 and scan the label marked 'suspect' from Test labels. Its serial is not in the supplier's transaction information, " +
      "so the check fails: the package can only be reported and quarantined, never shelved or filled."
  }
];

const EXTRA_LABELS: Record<string, ScenarioLabel[]> = {
  "receiving-problems": [
    { group: "Scenario · ASH-1105-07", ndc10: "70004-310-10", lot: "OX25L072", expiry: "2028-03-31", serial: "55020418", note: "second oxycodone package (count mismatch)" },
    { group: "Scenario · ASH-1105-07", ndc10: "70004-226-01", lot: "AMX0326Z", expiry: "2026-10-31", serial: "10443899", note: "expired amoxicillin" }
  ],
  "suspect-product": [
    { group: "Scenario · ASH-1105-08", ndc10: "70004-145-90", lot: "AM1107B", expiry: "2028-06-30", serial: "20001199", note: "suspect: serial not in supplier records" }
  ]
};

/** Synthetic fill history for the "Recall-aware refill" scenario, dated back from today. [patient, ndc10, drug, lot, daysAgo, daysSupply, refillsLeft] */
const REFILL_HISTORY: [string, string, string, string, number, number, number][] = [
  ["S-0490", "70004-623-15", "Insulin glargine 100 U/mL", "GX4471C", 62, 30, 3], ["S-0490", "70004-623-15", "Insulin glargine 100 U/mL", "GX4471C", 32, 30, 2],
  ["S-0490", "70004-802-10", "Metformin ER 500 mg", "MF2604K", 61, 30, 4], ["S-0490", "70004-802-10", "Metformin ER 500 mg", "MF2604K", 31, 30, 3],
  ["S-0423", "70004-310-10", "Oxycodone HCl 5 mg", "OX25L072", 28, 30, 0], ["S-0423", "70004-801-90", "Lisinopril 10 mg", "LS0811A", 65, 30, 3], ["S-0423", "70004-801-90", "Lisinopril 10 mg", "LS0811A", 35, 30, 2],
  ["S-0502", "70004-801-90", "Lisinopril 10 mg", "LS0811A", 33, 30, 5], ["S-0502", "70004-801-90", "Lisinopril 10 mg", "LS0811A", 63, 30, 6],
  ["S-0502", "70004-804-30", "Sertraline 50 mg", "SR0610B", 14, 30, 4], ["S-0502", "70004-145-90", "Amlodipine 5 mg", "AM1107B", 20, 30, 4],
  ["S-0519", "70004-803-90", "Atorvastatin 20 mg", "AT24K118", 170, 30, 5], ["S-0519", "70004-803-90", "Atorvastatin 20 mg", "AT24K118", 120, 30, 4], ["S-0519", "70004-803-90", "Atorvastatin 20 mg", "AT24K118", 60, 30, 3]
];

/** Synthetic history for "Agent catches it": [ndc10, drug, lot, daysAgo, daysSupply, prescriber, status] for patient S-0541. */
const GUARDIAN_HISTORY: [string, string, string, number, number, string, string][] = [
  ["70004-623-15", "Insulin glargine 100 U/mL · 5 pens", "GX3920A", 178, 30, "Dr. A. Nwosu", "Completed"],
  ["70004-623-15", "Insulin glargine 100 U/mL · 5 pens", "GX3920A", 115, 30, "Dr. A. Nwosu", "Completed"],
  ["70004-623-15", "Insulin glargine 100 U/mL · 5 pens", "GX4471C", 52, 30, "Dr. A. Nwosu", "Active"],
  ["70004-712-01", "Semaglutide 1 mg/dose pen", "SG1107A", 12, 28, "Dr. P. Okonkwo", "Active"]
];

type Apply = (ctx: Ctx, actor: Actor | null) => void | Promise<void>;
const APPLY: Record<string, Apply> = {
  "agent-catches-it": async (ctx, actor) => {
    const today = todayIso(ctx);
    const ago = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    for (const [ndc10, drug, lot, d, days, doc, status] of GUARDIAN_HISTORY) {
      ctx.db.run("INSERT INTO med_history (patient_id, filled_on, ndc11, drug, sig, lot, prescriber, qty, days_supply, status, auto_refill, refills_left) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        "S-0541", ago(d), ndc11Digits(ndc10), drug, "As directed", lot, doc, 1, days, status, 0, 2);
    }
    // The recall is real in the demo's terms: it goes through the same lookup the Recalls screen uses, so lot GX4471C is confirmed and quarantined.
    try { await lookupRecall(ctx, actor, { number: "D-0611-2026" }, { autoConfirm: true }); }
    catch { ctx.db.run("UPDATE lots SET status = 'quarantined' WHERE lot = 'GX4471C' AND status = 'active'"); }
    // The new order. Directions and days supply agree with the quantity, so the suggestions come from the history, not from the order itself.
    ctx.db.run("INSERT INTO prescriptions (rx, patient_id, ndc11, drug, qty, directions, prescriber, refills, status, due, days_supply) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      "0072301", "S-0541", ndc11Digits("70004-623-15"), "Insulin glargine 100 units/mL · 5 × 3 mL pens", 1, "Inject 20 units under the skin once daily at bedtime", "Dr. A. Nwosu", 3, "to_fill", "waiting", 68);
  },

  "recall-aware-refill": (ctx) => {
    const today = todayIso(ctx);
    for (const [pid, ndc10, drug, lot, ago, days, left] of REFILL_HISTORY) {
      const on = new Date(Date.parse(`${today}T00:00:00Z`) - ago * 86_400_000).toISOString().slice(0, 10);
      ctx.db.run("INSERT INTO med_history (patient_id, filled_on, ndc11, drug, sig, lot, prescriber, qty, days_supply, status, auto_refill, refills_left) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        pid, on, ndc11Digits(ndc10), drug, "As directed", lot, "Dr. L. Moreno", days, days, "Active", 0, left);
    }
  },
  "misread-fax": (ctx) => {
    const text = [
      "URGENT: DRUG RECALL", "Recall No. D-0417-2026", "Classification: Class II",
      "Product: Methylprednisolone Acetate Injectable Suspension, USP 40 mg/mL, 5 mL vial", "NDC 70004-417-05",
      "Lot PRORX05O925-1 EXP 09/30/2027", "Lot PRORX050925-3 EXP 09/30/2027", "Reason: Lack of assurance of sterility."
    ].join("\n");
    ctx.db.run("UPDATE fax_inbox SET text = ? WHERE recall_id = 'D-0417-2026'", text);
  },
  "receiving-problems": (ctx) => {
    ctx.db.run("UPDATE deliveries SET shipper_temp_c = 11.5 WHERE id = 'ASH-1105-07'");
    for (const l of EXTRA_LABELS["receiving-problems"]!) {
      ctx.db.run("INSERT OR IGNORE INTO ti_records (delivery_id, gtin, lot, serial, expiry) VALUES (?,?,?,?,?)", "ASH-1105-07", gtinOf(l.ndc10), l.lot, l.serial, l.expiry);
    }
  }
};

/** Test fixture: wipe and re-seed the synthetic dataset, then optionally apply a scenario. There is no HTTP route for this. */
export async function resetDemo(ctx: Ctx, actor: Actor | null, scenarioId: string | null = null) {
  if (ctx.stores) {
    // two stores: rebuild both, so a reset never leaves one store out of step with the other
    const reg = ctx.stores;
    for (const id of reg.ids) reg.run(id, () => { ctx.db.clearAll(); if (id === STORE_2) seedStore2(reg.db(id), ctx.now()); else seedDatabase(reg.db(id), ctx.cfg, ctx.now()); });
    reg.run(STORE_1, () => seedPartners(ctx));
  } else {
    ctx.db.clearAll();
    seedDatabase(ctx.db, ctx.cfg, ctx.now());
    seedPartners(ctx);
  }
  if (scenarioId) {
    await APPLY[scenarioId]?.(ctx, actor);
    ctx.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", META_SCENARIO, scenarioId);
    ctx.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", META_LABELS, JSON.stringify(EXTRA_LABELS[scenarioId] ?? []));
  }
  await ingestFaxInbox(ctx);
  await reviewPending(ctx);
  audit(ctx, actor, scenarioId ? "demo.scenario" : "demo.reset", "demo", scenarioId ?? "reset");
}

export function scenarioLabels(ctx: Ctx): ScenarioLabel[] {
  const raw = ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", META_LABELS)?.value;
  return raw ? (JSON.parse(raw) as ScenarioLabel[]) : [];
}

export async function startScenario(ctx: Ctx, actor: Actor, id: string) {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new HttpError(404, `Unknown scenario ${id}.`, "scenario");
  await resetDemo(ctx, actor, id);
  return { ok: true, scenario: { id: s.id, title: s.title, brief: s.brief, start: s.start } };
}

/**
 * Printable GS1 labels for the synthetic stock (test and e2e harness only; the product has no labels route).
 * Same rows the old demo labels page listed: scenario extras, expected receiving packages, then on-shelf fill packages.
 */
export function printableLabels(ctx: Ctx) {
  const dm = (p: { ndc10: string; lot: string; expiry: string; serial: string }) => ({ ...p, gtin: gtinOf(p.ndc10), product: PRODUCTS.find((x) => x.ndc10 === p.ndc10)?.name ?? p.ndc10 });
  const scanned = (ndc10: string, serial: string) => !!ctx.db.get("SELECT 1 FROM packages WHERE gtin = ? AND serial = ?", gtinOf(ndc10), serial);
  const receiving = expectedPackages().map((e) => ({ ...dm(e), group: `Receiving · ${e.delivery}`, scanned: scanned(e.ndc10, e.serial) }));
  const fill = FILL_PACKAGES.flatMap((f) => {
    const row = f.serial
      ? { serial: f.serial }
      : ctx.db.get<{ serial: string }>("SELECT k.serial FROM packages k JOIN lots l ON l.id = k.lot_id WHERE l.ndc11 = ? AND l.lot = ? AND k.status = 'on_shelf' ORDER BY k.id LIMIT 1", ndc11Digits(f.ndc10), f.lot);
    const exp = ctx.db.get<{ expiry: string }>("SELECT expiry FROM lots WHERE ndc11 = ? AND lot = ?", ndc11Digits(f.ndc10), f.lot)?.expiry ?? "";
    return row ? [{ ...dm({ ndc10: f.ndc10, lot: f.lot, expiry: exp, serial: row.serial }), group: "Fill & pickup", note: f.note, scanned: false }] : [];
  });
  const extra = scenarioLabels(ctx).map((l) => ({ ...dm(l), group: l.group, note: l.note, scanned: scanned(l.ndc10, l.serial) }));
  return { labels: [...extra, ...receiving, ...fill] };
}
