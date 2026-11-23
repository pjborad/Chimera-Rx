import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, HttpError, type Actor, type Ctx } from "./core";
import { ADVISORY_LABEL, draftQueue, refillDraftProblem, REFILL_DRAFT_KEY, runAgent } from "./agents";
import { refillFields, refillReport } from "./refills";
import { spokenPhone } from "./outreach";
import { channelsFor, merge } from "./recall";
import { pharmacyProfile } from "./stores";

/**
 * Refills routes. Pharmacist and technician see the worklist and may start drafts; a cashier gets 403. Only a pharmacist sends,
 * after attesting, and consent is read again at that moment. Messages go through the same sandbox notifier as recalls.
 */

const ROLES: readonly Actor["role"][] = ["pharmacist", "technician"];
const SENT_NOTE = "Sandbox: texts and emails go to the demo outbox only. A voicemail is rendered, never dialled.";

export function sendRefillDrafts(ctx: Ctx, actor: Actor, ids: number[] | undefined, attested: boolean) {
  if (actor.role !== "pharmacist") throw new HttpError(403, "Only a pharmacist can send patient messages.", "forbidden");
  if (!attested) throw new HttpError(422, "The pharmacist must tick the attestation before anything is sent.", "attest");
  const rows = ctx.db.all<{ id: number; patient_id: string; channel: string; subject: string | null; body: string }>(
    "SELECT id, patient_id, channel, subject, body FROM ai_drafts WHERE recall_id = ? AND status = 'draft' ORDER BY id", REFILL_DRAFT_KEY)
    .filter((r) => !ids || ids.includes(r.id));
  if (!rows.length) throw new HttpError(409, "There are no drafts to send. Draft the reminders first.", "no_drafts");
  const rep = refillReport(ctx); // the block is re-read now: a lot recalled since the draft was made stops the reminder
  const skipped: { patientId: string; channel: string; why: string }[] = [];
  let sent = 0, rendered = 0;
  const skip = (r: { id: number; patient_id: string; channel: string }, why: string) => {
    ctx.db.run("UPDATE ai_drafts SET status = 'skipped' WHERE id = ?", r.id);
    skipped.push({ patientId: r.patient_id, channel: r.channel, why });
  };
  for (const r of rows) {
    const mine = rep.worklist.filter((w) => w.patientId === r.patient_id);
    const offer = mine.filter((w) => w.eligible);
    if (!offer.length) { skip(r, mine.some((w) => w.action === "blocked_recall") ? "Last fill is from a recalled lot now." : "No longer due, or needs a new prescription."); continue; }
    const pat = ctx.db.get<any>("SELECT * FROM patients WHERE id = ?", r.patient_id);
    if (!pat) { skip(r, "Unknown patient."); continue; }
    const ch = channelsFor(pat);
    const f = refillFields(ctx, r.patient_id, actor.name.replace(/, PharmD$/, ""), rep);
    const me = pharmacyProfile(ctx, actor);
    const base = { first_name: f.first_name, drug_name: f.drug_name, pharmacist: f.pharmacist, pharmacy_name: me.name };
    const draft = {
      patientId: r.patient_id, channel: r.channel as "sms" | "email" | "voicemail",
      subject: r.subject ? merge(r.subject, base) : null,
      text: merge(r.body, { ...base, pharmacy_phone: r.channel === "voicemail" ? spokenPhone(me.phone) : me.phone })
    };
    const bad = refillDraftProblem(ctx, draft, offer.map((o) => o.drug));
    if (bad) { skip(r, bad); continue; }
    const version = 1;
    if (r.channel === "voicemail") {
      if (!(pat.phone && !pat.dnc && pat.voice_consent)) { skip(r, "No consent for voicemail now."); continue; }
      ctx.db.run("UPDATE ai_drafts SET status = 'rendered' WHERE id = ?", r.id); // rendered, never dialled
      rendered++;
      continue;
    }
    const wantsText = r.channel === "sms";
    if (wantsText ? !ch.includes("Text") : !ch.includes("Email")) { skip(r, wantsText ? "No text consent now, or the patient opted out." : "No email consent now."); continue; }
    const nid = Number(ctx.db.run("INSERT INTO notifications (recall_id, patient_id, rx, channel, template_version, merged_text, subject, status, queued_at) VALUES (?,?,?,?,?,?,?,?,?)",
      REFILL_DRAFT_KEY, r.patient_id, offer[0]!.rx, r.channel, version, draft.text, draft.subject, "queued", ctx.now()).lastInsertRowid);
    if (wantsText) ctx.notify.send({ channel: "sms", to: pat.phone, body: draft.text, notificationId: nid });
    else ctx.notify.send({ channel: "email", to: pat.email, subject: draft.subject ?? "", body: draft.text, notificationId: nid });
    ctx.db.run("UPDATE ai_drafts SET status = 'sent' WHERE id = ?", r.id);
    sent++;
  }
  audit(ctx, actor, "refill.send", "refill", REFILL_DRAFT_KEY, undefined, { sent, voicemailRendered: rendered, skipped: skipped.length });
  return { sent, voicemailRendered: rendered, skipped, note: SENT_NOTE };
}

export function registerRefillRoutes(app: FastifyInstance, ctx: Ctx) {
  const A = (req: FastifyRequest): Actor => req.actor!;
  const need = (req: FastifyRequest, roles: readonly Actor["role"][]) => {
    if (!roles.includes(A(req).role)) throw new HttpError(403, `A ${A(req).role} cannot do that.`, "forbidden");
  };
  const tune = z.object({ grace: z.coerce.number().int().min(0).max(60).optional(), lookahead: z.coerce.number().int().min(0).max(30).optional() });

  app.get("/api/refills", async (req) => {
    need(req, ROLES);
    const q = tune.parse(req.query);
    const report = refillReport(ctx, { graceDays: q.grace, lookaheadDays: q.lookahead });
    return { ...report, drafts: draftQueue(ctx, REFILL_DRAFT_KEY), canSend: A(req).role === "pharmacist", label: ADVISORY_LABEL, note: SENT_NOTE };
  });

  app.get("/api/refills/drafts", async (req) => {
    need(req, ROLES);
    return { note: "Drafts only. Nothing here has been sent. A pharmacist attests and sends.", drafts: draftQueue(ctx, REFILL_DRAFT_KEY) };
  });

  app.post("/api/refills/draft", async (req) => {
    need(req, ROLES);
    const b = z.object({ lookaheadDays: z.number().int().min(0).max(30).optional(), graceDays: z.number().int().min(0).max(60).optional() }).strict().parse(req.body ?? {});
    const run = await runAgent(ctx, A(req), "refill-outreach", b);
    const drafts = draftQueue(ctx, REFILL_DRAFT_KEY);
    audit(ctx, A(req), "refill.draft", "refill", run.id, undefined, { runId: run.id, drafts: drafts.length, mode: run.mode, dropped: run.dropped.length });
    const { extra: _extra, ...record } = run;
    return { label: ADVISORY_LABEL, run: record, drafts, sent: false };
  });

  app.post("/api/refills/send", async (req) => {
    need(req, ["pharmacist"]);
    const b = z.object({ ids: z.array(z.number().int()).max(500).optional(), attest: z.boolean() }).strict().parse(req.body ?? {});
    return sendRefillDrafts(ctx, A(req), b.ids, b.attest);
  });
}
