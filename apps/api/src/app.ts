import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { z, ZodError } from "zod";
import { parseElementString } from "@chimera-rx/gs1";
import { actorFromToken, checkPassword, login, logout, openSession, type SessionUser } from "./auth";
import { checkCode, demoCodeHint, startChallenge } from "./mfa";
import { completeSale, findItems, findPatients, readyForPatient } from "./register";
import { decide as decideStock, stockHelp } from "./stockhelp";
import { audit, HttpError, todayIso, verifyAuditChain, type Actor, type Ctx } from "./core";
import { draftPrescriberMessage, reviewPending, reviewRx, reviewView } from "./rxwatcher";
import { decide, listMessages, proposeFix, respond } from "./prescriber";
import { addWebhook, deliveries, WEBHOOK_EVENTS } from "./webhooks";
import { ALL_SCOPES, apiActivity, createPartner, listPartners, rotateSecret, SCOPES, securityPosture, seedPartners, updatePartner, type Scope } from "./integrations";
import { registerPartnerApi } from "./partner-api";
import { registerAgentRoutes, listSuggestions } from "./agents";
import { ruleFor, rolesOf } from "./access";
import { registerEpcisRoutes } from "./epcis";
import { registerRefillRoutes } from "./refills-routes";
import { findPatientByPhone, patientProfile, refillSync, searchPatients } from "./patients";
import { inboundCall, outreachResults, previewVoicemail, runOutreachAgent, startVoicemail, voicemailDraft } from "./outreach";
import { fillQueue, printLabel, rxDetail, scanFill, sell, sendBack, verifyDispense } from "./fill";
import { adjustLot, listLots, lotDetail, moveLot } from "./inventory";
import { parseLabelText } from "./ocr-text";
import { auditReport, closeRecall, confirmRecallLot, listRecalls, lookupRecall, messageDraft, recallImpact, recallResults, recallView, respondToManufacturer, scheduleReturn, sendNotifications, smsSegments, merge } from "./recall";
import { confirmPutaway, deliveryView, listDeliveries, PROBLEM_KINDS, reportProblem, scanReceive } from "./receiving";
import { seedDatabase, expectedPackages, FILL_PACKAGES, PRODUCTS } from "./seed";
import { gtinOf, ndc11Digits } from "./domain";
import { ingestFaxInbox, pollOpenFda, todayView } from "./today";
import { splitStore, withStore } from "./stores";
import { otherStores, transferPackages } from "./crossstore";
import { corsOriginsFrom, publicError, registerSecurity } from "./security";
import { listScenarios, resetDemo, scenarioLabels, startScenario } from "./scenarios";

declare module "fastify" { interface FastifyRequest { actor?: Actor; user?: SessionUser } interface FastifyInstance { routeTable: { method: string; url: string }[] } }

const COOKIE = "lg_session";
const scanBody = z.object({
  raw: z.string().min(1).max(400).optional(),
  fields: z.object({ ndc: z.string().max(20).optional(), lot: z.string().max(30).optional(), expiry: z.string().max(20).optional(), serial: z.string().max(30).optional() }).optional(),
  source: z.enum(["datamatrix", "ocr", "typed"]).optional()
});
const witnessBody = z.object({ email: z.string().email(), password: z.string().min(1).max(200) }).optional();

export async function buildApp(ctx: Ctx): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2_000_000, trustProxy: process.env.TRUST_PROXY === "1" });
  // Every route that gets registered, so a test can prove each one has a row in the access matrix (access.ts).
  const routeTable: { method: string; url: string }[] = [];
  app.decorate("routeTable", routeTable);
  app.addHook("onRoute", (r) => { for (const m of ([] as string[]).concat(r.method as string | string[])) if (m !== "HEAD" && m !== "OPTIONS") routeTable.push({ method: m, url: r.url }); });
  await app.register(cookie);
  // Only the listed origins may call the API from a browser (CORS_ORIGINS); same-origin and non-browser callers need no CORS.
  const corsOrigins = corsOriginsFrom();
  await app.register(cors, { origin: (origin, cb) => cb(null, !origin || corsOrigins.includes(origin)), credentials: true });
  registerSecurity(app, ctx, { corsOrigins });

  // Error bodies are rebuilt from a fixed vocabulary (security.ts) so they never echo what the caller sent.
  app.setErrorHandler((err: any, _req, reply) => {
    const e = publicError(err);
    (reply as any).__errClass = err?.constructor?.name;
    return reply.code(e.status).send(e.body);
  });

  // ---- two stores (FR4): the session cookie says which store's database every query in this request uses
  const stores = ctx.stores;
  if (stores) {
    app.addHook("onRequest", (req, _reply, done) => {
      const raw = /(?:^|;\s*)lg_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
      stores.enter(splitStore(raw ? decodeURIComponent(raw) : undefined, stores).store, done);
    });
  }
  const tokenOf = (req: FastifyRequest) => (stores ? splitStore(req.cookies[COOKIE], stores).token : req.cookies[COOKIE]);
  const inStore = <T,>(id: string, fn: () => T): T => (stores ? stores.run(id, fn) : fn());
  const curStore = () => stores?.current ?? "store-7";

  // ---- sessions: everything under /api needs one, except sign-in and the public config
  const PUBLIC = new Set(["/api/health", "/api/auth/login", "/api/auth/sso", "/api/auth/config", "/api/auth/logout", "/api/auth/verify", "/api/auth/demo-code"]);
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split("?")[0]!;
    if (!url.startsWith("/api/") || PUBLIC.has(url) || url.startsWith("/api/auth/demo-code/")) return;
    const s = actorFromToken(ctx, tokenOf(req));
    if (!s) return reply.code(401).send({ error: "Please sign in.", code: "unauthenticated" });
    req.actor = s.actor;
    req.user = s.user;
    // Read authorization matrix (access.ts): a route with no row is refused, a row that does not list the role is refused.
    const roles = rolesOf(ruleFor(req.method, req.routeOptions?.url));
    if (!roles) return reply.code(403).send({ error: "That route is not open to any role.", code: "route_unlisted" });
    if (!roles.includes(s.actor.role)) return reply.code(403).send({ error: `A ${s.actor.role} cannot do that.`, code: "forbidden" });
  });
  const A = (req: FastifyRequest) => req.actor!;
  const only = (req: FastifyRequest, ...roles: Actor["role"][]) => {
    if (!roles.includes(A(req).role)) throw new HttpError(403, `A ${A(req).role} cannot do that.`, "forbidden");
  };

  app.get("/api/health", async () => ({ ok: true, today: todayIso(ctx), notifier: ctx.notify.name }));

  // ---- auth
  app.get("/api/auth/config", async () => ({
    stores: stores ? stores.ids.flatMap((id) => stores.run(id, () => ctx.db.all<{ id: string; name: string }>("SELECT id, name FROM stores"))) : ctx.db.all<{ id: string; name: string }>("SELECT id, name FROM stores"),
    storeDemos: stores ? { "store-2": { email: "s.okoro@birchavenuerx.example" } } : {},
    mfa: ctx.cfg.mfa,
    demo: ctx.cfg.demo ? { email: "j.rivera@elmstreetrx.example", password: "moonlight-rx-2026", note: "Demo environment: staff accounts j.rivera, k.patel and m.diaz share this password." } : null
  }));
  const loginBody = z.object({ storeId: z.string(), email: z.string().min(3).max(120), password: z.string().min(1).max(200), trusted: z.boolean().optional() });
  const setCookie = (reply: FastifyReply, token: string, ttl: number) => reply.setCookie(COOKIE, stores ? withStore(curStore(), token) : token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: Math.floor(ttl / 1000), secure: ctx.cfg.cookieSecure });
  app.post("/api/auth/login", async (req, reply) => {
    const b = loginBody.parse(req.body);
    const ws = `${req.headers["user-agent"]?.includes("Mac") ? "Mac" : "PC"} workstation · ${req.ip}`;
    const sid = stores && stores.has(b.storeId) ? b.storeId : curStore();
    return inStore(sid, () => {
      if (ctx.cfg.mfa) {
        // Second factor (FR7): the password is right, so a 6-digit code goes to the sandbox outbox and no session exists yet.
        const u = checkPassword(ctx, b);
        const c = startChallenge(ctx, u);
        ctx.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", `mfa_trust:${c.challenge}`, JSON.stringify({ trusted: !!b.trusted, ws }));
        return reply.code(202).send({ mfaRequired: true, challenge: stores ? withStore(sid, c.challenge) : c.challenge, expiresAt: c.expiresAt, demoHint: ctx.cfg.demo });
      }
      const r = login(ctx, { ...b, trusted: !!b.trusted, workstation: ws });
      setCookie(reply, r.token, r.ttl);
      audit(ctx, { id: r.user.id, name: r.user.name, role: r.user.role, storeId: r.user.storeId, workstation: ws }, "auth.login", "user", r.user.id);
      return { user: r.user };
    });
  });
  app.post("/api/auth/verify", async (req, reply) => {
    const b = z.object({ challenge: z.string().min(10).max(100), code: z.string().regex(/^\d{6}$/, "The code is 6 digits.") }).parse(req.body);
    const sp = stores ? splitStore(b.challenge, stores) : { store: curStore(), token: b.challenge };
    return inStore(sp.store, () => {
      const userId = checkCode(ctx, sp.token, b.code);
      const meta = JSON.parse(ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", `mfa_trust:${sp.token}`)?.value ?? "{}") as { trusted?: boolean; ws?: string };
      ctx.db.run("DELETE FROM meta WHERE key = ?", `mfa_trust:${sp.token}`);
      const u = ctx.db.get<any>("SELECT * FROM users WHERE id = ?", userId)!;
      const r = openSession(ctx, u, !!meta.trusted, meta.ws ?? "workstation");
      setCookie(reply, r.token, r.ttl);
      audit(ctx, { id: r.user.id, name: r.user.name, role: r.user.role, storeId: r.user.storeId, workstation: meta.ws ?? "workstation" }, "auth.login_mfa", "user", r.user.id);
      return { user: r.user };
    });
  });
  // Demo only (FR7.3): shows the code from the sandbox outbox on the sign-in page, since a judge has no inbox to read.
  app.get("/api/auth/demo-code/:challenge", async (req) => {
    if (!ctx.cfg.demo || !ctx.cfg.mfa) throw new HttpError(404, "Not available.");
    const ch = (req.params as { challenge: string }).challenge;
    const sp = stores ? splitStore(ch, stores) : { store: curStore(), token: ch };
    return inStore(sp.store, () => ({ code: demoCodeHint(ctx, sp.token) }));
  });
  // Demo stand-in for "badge tap or SSO": signs in the pharmacist on duty. Disabled outside demo mode.
  app.post("/api/auth/sso", async (req, reply) => {
    if (!ctx.cfg.demo) throw new HttpError(501, "SSO is not configured.");
    if (ctx.cfg.mfa) throw new HttpError(501, "The badge stand-in skips the second factor, so it is off while MFA is on.");
    const r = login(ctx, { storeId: "store-7", email: "j.rivera@elmstreetrx.example", password: "moonlight-rx-2026", trusted: false, workstation: `SSO badge · ${req.ip}` });
    setCookie(reply, r.token, r.ttl);
    return { user: r.user };
  });
  app.post("/api/auth/logout", async (req, reply) => { const t = tokenOf(req); if (t) logout(ctx, t); reply.clearCookie(COOKIE, { path: "/" }); return { ok: true }; });
  app.get("/api/me", async (req) => ({ user: req.user, store: ctx.db.get("SELECT * FROM stores WHERE id = ?", A(req).storeId), today: todayIso(ctx) }));

  // ---- today
  app.get("/api/today", async (req) => todayView(ctx, A(req)));

  // ---- receiving
  app.get("/api/deliveries", async () => listDeliveries(ctx));
  app.get("/api/deliveries/:id", async (req) => {
    const d = deliveryView(ctx, (req.params as { id: string }).id);
    if (!d) throw new HttpError(404, "Unknown delivery.");
    return d;
  });
  app.post("/api/deliveries/:id/scan", async (req) => { only(req, "technician", "pharmacist"); return scanReceive(ctx, A(req), (req.params as { id: string }).id, scanBody.parse(req.body)); });
  app.post("/api/packages/:id/putaway", async (req) => {
    only(req, "technician", "pharmacist");
    const b = z.object({ witness: witnessBody }).parse(req.body ?? {});
    return confirmPutaway(ctx, A(req), Number((req.params as { id: string }).id), b.witness);
  });
  app.post("/api/packages/:id/problem", async (req) => {
    only(req, "technician", "pharmacist");
    const b = z.object({ kind: z.enum(PROBLEM_KINDS), note: z.string().max(200).optional() }).parse(req.body);
    return reportProblem(ctx, A(req), Number((req.params as { id: string }).id), b.kind, b.note);
  });

  // ---- inventory
  app.get("/api/lots", async (req) => listLots(ctx, req.query as { filter?: string; q?: string }));
  app.get("/api/lots/:id", async (req) => lotDetail(ctx, Number((req.params as { id: string }).id)));
  app.post("/api/lots/:id/move", async (req) => { only(req, "technician", "pharmacist"); return moveLot(ctx, A(req), Number((req.params as { id: string }).id), z.object({ location: z.string() }).parse(req.body).location); });
  app.post("/api/lots/:id/adjust", async (req) => {
    only(req, "technician", "pharmacist");
    const b = z.object({ count: z.number().int(), reason: z.string().max(200), witness: witnessBody }).parse(req.body);
    return adjustLot(ctx, A(req), Number((req.params as { id: string }).id), b.count, b.reason, b.witness);
  });

  // ---- fill & pickup
  app.get("/api/rx", async (req) => {
    only(req, "cashier", "technician", "pharmacist"); // admin has no job in the fill queue (patient names)
    const rows = fillQueue(ctx);
    // Rx Guardian: an order with open suggestions carries their count and the worst severity. A cashier sees none of it.
    if (A(req).role === "cashier") return rows;
    const open = listSuggestions(ctx, { status: "open", limit: 500 });
    return rows.map((r) => { const mine = open.filter((s) => s.rxNumber === r.rx); return { ...r, suggestions: mine.length, suggestionSeverity: mine[0]?.severity ?? null }; });
  });
  app.get("/api/rx/:rx", async (req) => { only(req, "cashier", "technician", "pharmacist"); return rxDetail(ctx, A(req), (req.params as { rx: string }).rx); });
  // ---- Rx Watcher and the prescriber channel
  const rxp = (req: FastifyRequest) => (req.params as { rx: string }).rx;
  app.get("/api/rx/:rx/review", async (req) => { only(req, "technician", "pharmacist"); return reviewView(ctx, rxp(req)); });
  app.post("/api/rx/:rx/review", async (req) => { only(req, "technician", "pharmacist"); return reviewRx(ctx, A(req), rxp(req)); });
  app.get("/api/rx/:rx/change-draft", async (req) => { only(req, "pharmacist"); return { message: draftPrescriberMessage(ctx, rxp(req)), proposal: proposeFix(ctx, rxp(req)) }; });
  const proposalBody = z.object({ directions: z.string().min(5).max(300), daysSupply: z.number().int().min(1).max(400).nullable() });
  app.post("/api/rx/:rx/decision", async (req) => {
    const b = z.object({ action: z.enum(["approve", "reject", "change"]), reason: z.string().max(500).optional(), message: z.string().max(2000).optional(), proposal: proposalBody.optional() }).parse(req.body);
    return decide(ctx, A(req), rxp(req), b);
  });
  app.get("/api/prescriber-messages", async (req) => { only(req, "technician", "pharmacist"); return listMessages(ctx, (req.query as { rx?: string }).rx); });
  // Sandbox only: the pharmacist records the prescriber's RxChangeResponse (in production it arrives from Surescripts).
  app.post("/api/prescriber-messages/:id/respond", async (req) => {
    only(req, "pharmacist");
    const b = z.object({ response: z.enum(["approved", "denied"]), directions: z.string().max(300).optional(), daysSupply: z.number().int().min(1).max(400).optional(), note: z.string().max(300).optional() }).parse(req.body);
    return respond(ctx, `sandbox via ${A(req).name}`, A(req), Number((req.params as { id: string }).id), b);
  });

  app.post("/api/rx/:rx/scan", async (req) => scanFill(ctx, A(req), (req.params as { rx: string }).rx, scanBody.parse(req.body)));
  const did = (req: FastifyRequest) => Number((req.params as { id: string }).id);
  app.post("/api/dispenses/:id/label", async (req) => printLabel(ctx, A(req), did(req)));
  app.post("/api/dispenses/:id/verify", async (req) => verifyDispense(ctx, A(req), did(req), z.object({ checklist: z.array(z.boolean()) }).parse(req.body).checklist));
  app.post("/api/dispenses/:id/sendback", async (req) => sendBack(ctx, A(req), did(req), z.object({ reason: z.string().max(200) }).parse(req.body).reason));
  app.post("/api/dispenses/:id/sell", async (req) => sell(ctx, A(req), did(req), z.object({ idChecked: z.boolean(), counseled: z.boolean(), signature: z.boolean() }).parse(req.body)));

  // ---- recalls
  const rid = (req: FastifyRequest) => (req.params as { id: string }).id;
  app.get("/api/recalls", async () => listRecalls(ctx));
  app.get("/api/fax", async () => ctx.db.all("SELECT id, received_at, from_name, pages, image, status, recall_id FROM fax_inbox ORDER BY id DESC"));
  app.post("/api/recalls/lookup", async (req) => {
    only(req, "pharmacist");
    const b = z.object({ number: z.string().max(40).optional(), text: z.string().max(20000).optional() }).parse(req.body);
    const v = await lookupRecall(ctx, A(req), b, { autoConfirm: true });
    ctx.db.run("UPDATE fax_inbox SET status = 'read' WHERE recall_id = ?", v.id);
    return { recall: v, impact: recallImpact(ctx, v.id) };
  });
  app.get("/api/recalls/:id", async (req) => ({ recall: recallView(ctx, rid(req)), impact: recallImpact(ctx, rid(req)) }));
  app.post("/api/recalls/:id/confirm-lot", async (req) => {
    const v = confirmRecallLot(ctx, A(req), rid(req), z.object({ lot: z.string() }).parse(req.body).lot);
    return { recall: v, impact: recallImpact(ctx, rid(req)) };
  });
  app.get("/api/recalls/:id/messages", async (req) => {
    only(req, "technician", "pharmacist"); // the preview names a patient
    const d = messageDraft(ctx, rid(req));
    return { ...d, smsPreview: merge(d.sms, d.fields), smsInfo: smsSegments(merge(d.sms, d.fields)) };
  });
  app.post("/api/recalls/:id/preview", async (req) => {
    only(req, "technician", "pharmacist"); // merges the first patient's fields into the text
    const b = z.object({ sms: z.string().max(1000), emailSubject: z.string().max(300), emailBody: z.string().max(6000) }).parse(req.body);
    const d = messageDraft(ctx, rid(req));
    const sms = merge(b.sms, d.fields);
    return { smsPreview: sms, smsInfo: smsSegments(sms), emailSubject: merge(b.emailSubject, d.fields), emailBody: merge(b.emailBody, d.fields) };
  });
  app.post("/api/recalls/:id/notifications", async (req) => {
    const b = z.object({ sms: z.string().min(10).max(1000), emailSubject: z.string().min(3).max(300), emailBody: z.string().min(10).max(6000), attest: z.boolean() }).parse(req.body);
    return sendNotifications(ctx, A(req), rid(req), { sms: b.sms, emailSubject: b.emailSubject, emailBody: b.emailBody }, b.attest);
  });
  app.get("/api/recalls/:id/results", async (req) => ({ ...recallResults(ctx, rid(req)), voice: outreachResults(ctx, rid(req)) }));

  // ---- voicemail outreach (sandbox: audio is real TTS, calls are simulated; nothing is dialled)
  app.get("/api/recalls/:id/voicemail", async (req) => { only(req, "pharmacist"); return voicemailDraft(ctx, rid(req), A(req)); });
  app.post("/api/recalls/:id/voicemail/preview", async (req) => previewVoicemail(ctx, A(req), rid(req), z.object({ script: z.string().min(1).max(2000) }).parse(req.body).script));
  app.post("/api/recalls/:id/voicemail", async (req) => {
    const b = z.object({ script: z.string().min(1).max(2000), attest: z.boolean() }).parse(req.body);
    return startVoicemail(ctx, A(req), rid(req), b.script, b.attest);
  });
  app.post("/api/outreach/run", async (req) => { only(req, "pharmacist"); return { placed: await runOutreachAgent(ctx) }; });
  app.get("/api/recalls/:id/calls", async (req) => { only(req, "pharmacist"); return outreachResults(ctx, rid(req)); });
  app.post("/api/calls/inbound", async (req) => inboundCall(ctx, z.object({ from: z.string().min(7).max(30) }).parse(req.body).from));
  app.get("/api/audio/:id", async (req, reply) => {
    const a = ctx.db.get<{ mime: string; bytes: Uint8Array }>("SELECT mime, bytes FROM audio WHERE id = ?", (req.params as { id: string }).id);
    if (!a) return reply.code(404).send({ error: "No such recording." });
    return reply.type(a.mime).header("Cache-Control", "private, max-age=3600").send(Buffer.from(a.bytes));
  });
  app.get("/api/voice", async () => ({ provider: ctx.voice?.name ?? "browser", voice: ctx.voice?.voice ?? "device voice" }));
  app.post("/api/recalls/:id/return-pickup", async (req) => scheduleReturn(ctx, A(req), rid(req)));
  app.post("/api/recalls/:id/manufacturer-response", async (req) => respondToManufacturer(ctx, A(req), rid(req)));
  app.post("/api/recalls/:id/close", async (req) => { closeRecall(ctx, A(req), rid(req)); return { ok: true }; });
  app.get("/api/recalls/:id/report.pdf", async (req, reply) => {
    only(req, "pharmacist");
    const pdf = await auditReport(ctx, rid(req));
    audit(ctx, A(req), "recall.report", "recall", rid(req));
    return reply.type("application/pdf").header("Content-Disposition", `attachment; filename="recall-${rid(req)}-audit.pdf"`).send(pdf);
  });
  app.post("/api/night-watch/run", async (req) => { only(req, "pharmacist"); return pollOpenFda(ctx); });

  // ---- OCR text -> fields (the OCR itself runs in the browser)
  app.post("/api/ocr/parse", async (req) => parseLabelText(z.object({ text: z.string().max(20000) }).parse(req.body).text));

  // ---- sandbox outbox
  app.get("/api/outbox", async (req) => {
    only(req, "technician", "pharmacist"); // bodies and addresses of patient messages
    const q = req.query as { recall?: string };
    return ctx.db.all(`SELECT o.*, n.recall_id, n.patient_id FROM outbox o LEFT JOIN notifications n ON n.id = o.notification_id ${q.recall ? "WHERE n.recall_id = ?" : ""} ORDER BY o.id DESC LIMIT 200`, ...(q.recall ? [q.recall] : []));
  });
  // A patient replying STOP to a text: honoured from then on (spec: opt-out keyword STOP)
  app.post("/api/sms/inbound", async (req) => {
    const b = z.object({ from: z.string().min(7).max(30), body: z.string().max(200) }).parse(req.body);
    if (!/^\s*stop\s*$/i.test(b.body)) return { handled: false };
    const digits = b.from.replace(/\D/g, "");
    const p = findPatientByPhone(ctx, digits.slice(-10));
    if (!p) return { handled: false };
    ctx.db.run("UPDATE patients SET sms_opt_out = 1 WHERE id = ?", p.id);
    audit(ctx, null, "sms.opt_out", "patient", p.id);
    return { handled: true, patient: p.id };
  });

  app.get("/api/search", async (req) => {
    const q = String((req.query as { q?: string }).q ?? "").trim();
    if (q.length < 2) return { lots: [], rx: [] };
    const g = parseElementString(q);
    if (g.ok && g.value.lot) return { lots: listLots(ctx, { q: g.value.lot }).rows.slice(0, 6), rx: [], scanned: { lot: g.value.lot, serial: g.value.serial ?? "" } };
    return { lots: listLots(ctx, { q }).rows.slice(0, 6), rx: A(req).role === "admin" ? [] : fillQueue(ctx).filter((r) => [r.rx, r.patient, r.drug].some((v) => v.toLowerCase().includes(q.toLowerCase()))).slice(0, 6) };
  });

  app.get("/api/audit", async (req) => { only(req, "pharmacist", "admin"); return ctx.db.all("SELECT id, at, user_name, workstation, action, entity, entity_id, reason, hash FROM audit ORDER BY id DESC LIMIT 100"); });
  app.get("/api/audit/verify", async (req) => { only(req, "pharmacist", "admin"); return verifyAuditChain(ctx); });
  app.get("/api/audit/export", async (req, reply) => {
    only(req, "admin");
    audit(ctx, A(req), "audit.export", "audit", "all");
    const rows = ctx.db.all("SELECT id, at, user_id, user_name, store_id, workstation, action, entity, entity_id, reason, prev_hash, hash FROM audit ORDER BY id");
    return reply.type("application/x-ndjson").header("Content-Disposition", 'attachment; filename="chimera-rx-audit.ndjson"').send(rows.map((r) => JSON.stringify(r)).join("\n"));
  });

  // ---- patients (every profile view is logged with a reason, plan 3.6)
  app.get("/api/patients", async (req) => { only(req, "technician", "pharmacist"); return searchPatients(ctx, String((req.query as { q?: string }).q ?? "")); });
  app.get("/api/patients/:id", async (req) => {
    only(req, "technician", "pharmacist");
    const q = req.query as { reason?: string };
    return patientProfile(ctx, A(req), (req.params as { id: string }).id, q.reason ?? "");
  });
  app.post("/api/patients/:id/refill-sync", async (req) => { only(req, "pharmacist"); return refillSync(ctx, A(req), (req.params as { id: string }).id); });

  // ---- integrations (admin changes; pharmacists can look)
  const iid = (req: FastifyRequest) => (req.params as { id: string }).id;
  const scopeEnum = z.enum(ALL_SCOPES as [Scope, ...Scope[]]);
  app.get("/api/integrations", async (req) => {
    only(req, "admin", "pharmacist");
    return { partners: listPartners(ctx), scopes: SCOPES, events: WEBHOOK_EVENTS, activity: apiActivity(ctx), deliveries: deliveries(ctx), security: securityPosture(ctx), sink: ctx.db.all("SELECT id, at, event, verified FROM webhook_inbox ORDER BY id DESC LIMIT 10"), canEdit: A(req).role === "admin" };
  });
  app.post("/api/integrations", async (req) => {
    const b = z.object({ partner: z.string().min(3).max(80), kind: z.enum(["REST", "MCP", "FHIR"]), scopes: z.array(scopeEnum).min(1), ipAllowlist: z.array(z.string().max(45)).max(20).optional(), baa: z.boolean().optional(), purpose: z.string().max(300).optional(), ratePerMin: z.number().int().min(1).max(6000).optional() }).parse(req.body);
    return createPartner(ctx, A(req), b);
  });
  app.post("/api/integrations/:id", async (req) => {
    const b = z.object({ scopes: z.array(scopeEnum).optional(), ipAllowlist: z.array(z.string().max(45)).max(20).optional(), baa: z.boolean().optional(), purpose: z.string().max(300).optional(), status: z.enum(["active", "revoked"]).optional(), ratePerMin: z.number().int().min(1).max(6000).optional() }).parse(req.body);
    return updatePartner(ctx, A(req), iid(req), b);
  });
  app.post("/api/integrations/:id/rotate", async (req) => rotateSecret(ctx, A(req), iid(req)));
  app.post("/api/integrations/:id/webhooks", async (req) => {
    const b = z.object({ url: z.string().max(500), events: z.array(z.string()).min(1) }).parse(req.body);
    return addWebhook(ctx, A(req), iid(req), b.url, b.events);
  });

  // ---- demo helpers: the labels a camera can scan, and a reset
  app.get("/api/demo/labels", async () => {
    const dm = (p: { ndc10: string; lot: string; expiry: string; serial: string }) => ({ ...p, gtin: gtinOf(p.ndc10), product: PRODUCTS.find((x) => x.ndc10 === p.ndc10)?.name ?? p.ndc10 });
    const receiving = expectedPackages().map((e) => ({ ...dm(e), group: `Receiving · ${e.delivery}`, scanned: !!ctx.db.get("SELECT 1 FROM packages WHERE gtin = ? AND serial = ?", gtinOf(e.ndc10), e.serial) }));
    const fill = FILL_PACKAGES.flatMap((f) => {
      const row = f.serial
        ? { serial: f.serial }
        : ctx.db.get<{ serial: string }>("SELECT k.serial FROM packages k JOIN lots l ON l.id = k.lot_id WHERE l.ndc11 = ? AND l.lot = ? AND k.status = 'on_shelf' ORDER BY k.id LIMIT 1", ndc11Digits(f.ndc10), f.lot);
      const exp = ctx.db.get<{ expiry: string }>("SELECT expiry FROM lots WHERE ndc11 = ? AND lot = ?", ndc11Digits(f.ndc10), f.lot)?.expiry ?? "";
      return row ? [{ ...dm({ ndc10: f.ndc10, lot: f.lot, expiry: exp, serial: row.serial }), group: "Fill & pickup", note: f.note, scanned: false }] : [];
    });
    const extra = scenarioLabels(ctx).map((l) => ({ ...dm(l), group: l.group, note: l.note, scanned: !!ctx.db.get("SELECT 1 FROM packages WHERE gtin = ? AND serial = ?", gtinOf(l.ndc10), l.serial) }));
    return { labels: [...extra, ...receiving, ...fill] };
  });
  app.post("/api/demo/reset", async (req) => {
    only(req, "pharmacist");
    await resetDemo(ctx, A(req));
    return { ok: true };
  });
  // ---- two stores (FR4): see the other store, move stock to it
  app.get("/api/stores", async (req) => ({ me: A(req).storeId, others: otherStores(ctx, A(req)) }));
  app.post("/api/transfers", async (req) => transferPackages(ctx, A(req), z.object({ toStore: z.string().max(40), lotId: z.number().int(), qty: z.number().int() }).parse(req.body)));

  // ---- front-store register (FR3)
  app.get("/api/register/items", async (req) => findItems(ctx, A(req), String((req.query as { q?: string }).q ?? "")));
  app.get("/api/register/patients", async (req) => findPatients(ctx, A(req), String((req.query as { q?: string }).q ?? "")));
  app.get("/api/register/patients/:id", async (req) => readyForPatient(ctx, A(req), (req.params as { id: string }).id));
  app.post("/api/register/sales", async (req) => completeSale(ctx, A(req), z.object({
    patientId: z.string().max(20).optional(), items: z.array(z.object({ upc: z.string().max(20), qty: z.number().int() })).max(40),
    dispenseIds: z.array(z.number().int()).max(20), idChecked: z.boolean().optional(), counseled: z.boolean().optional(), signature: z.boolean().optional()
  }).parse(req.body)));

  // ---- AI stock help (FR8): advice only, a pharmacist decides
  app.get("/api/stock-help", async (req) => stockHelp(ctx, A(req)));
  app.post("/api/stock-help/decision", async (req) => decideStock(ctx, A(req), z.object({ kind: z.enum(["reorder", "expiry", "shortage"]), key: z.string().max(80), decision: z.enum(["accepted", "dismissed"]) }).parse(req.body)));

  // ---- scenario library (FR6, US1.1): pick a known state from the app, no terminal needed
  app.get("/api/demo/scenarios", async () => listScenarios(ctx));
  app.post("/api/demo/scenarios/:id", async (req) => {
    only(req, "pharmacist");
    return startScenario(ctx, A(req), (req.params as { id: string }).id);
  });

  // ---- partner surfaces: /oauth/token, /v1, /mcp, /fhir/r4 (their own auth, scopes and log)
  seedPartners(ctx);
  registerRefillRoutes(app, ctx); // recall-aware refills and adherence (refills.ts)
  registerAgentRoutes(app, ctx); // AI agents (agents/): advisory, role-checked, audited
  registerEpcisRoutes(app, ctx); // DSCSA trace (epcis.ts): EPCIS export/import, sandbox verifier, suspect cases
  await registerPartnerApi(app, ctx);

  // ---- built web app
  app.get("/fax/:file", async (req, reply) => {
    const f = path.join(ctx.cfg.assetsDir, "fax", path.basename((req.params as { file: string }).file));
    if (!fs.existsSync(f)) return reply.code(404).send({ error: "no such fax" });
    return reply.type("image/png").send(fs.readFileSync(f));
  });
  if (fs.existsSync(path.join(ctx.cfg.webDist, "index.html"))) {
    // wildcard: true looks each file up when it is requested, so a `pnpm build:web` while the API runs serves the new hashed
    // assets at once (wildcard: false lists dist once at start and 404s every asset built after that).
    await app.register(fastifyStatic, { root: ctx.cfg.webDist, wildcard: true });
    app.setNotFoundHandler((req, reply) => {
      const url = req.url.split("?")[0]!;
      if (url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      // A missing file (an old hashed asset) is a real 404, never index.html served as a script.
      if (/\.[A-Za-z0-9]{1,8}$/.test(url)) return reply.code(404).type("text/plain").send("not found");
      return reply.type("text/html").header("Cache-Control", "no-cache").send(fs.readFileSync(path.join(ctx.cfg.webDist, "index.html")));
    });
  }
  return app;
}
