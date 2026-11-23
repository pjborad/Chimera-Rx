import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, HttpError, type Actor, type Ctx } from "../core";
import "./coroner";
import "./rx";
import "./outreach";
import "./nightwatch";
import "./stock";
import "./copilot";
import "./refills";
import "./guardian";
import { ADVISORY_LABEL, allAgents, canRun, getAgent, listRuns, runAgent, sampleFor } from "./agent";
import { draftQueue } from "./outreach";
import { PROVIDER_IDS, runtimeOf } from "./providers";
import { checkDestinationLiteral, DestinationError } from "./destination";
import { agentsOn, backgroundAllowed, backgroundStatus, runNow, setEnabled } from "./background";
import { acceptSuggestion, dismissSuggestion, listSuggestions, requestChange, suggestionSummary } from "./guardian";

/** Who may change the provider: the pharmacist (in charge of the store) and the admin. */
const CONFIGURE = ["pharmacist", "admin"] as const;

const providerBody = z.object({
  provider: z.enum(PROVIDER_IDS as [string, ...string[]]).optional(),
  model: z.string().trim().max(120).optional(),
  region: z.string().trim().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, "region looks like us-west-2").optional(),
  baseUrl: z.string().trim().max(200).optional(),
  apiKey: z.string().max(600).optional()
}).strict();

/** The OpenAI-compatible base URL is called from the server: the shared destination policy (destination.ts) applies here and again before every request. */
function checkBaseUrl(raw: string) {
  try { checkDestinationLiteral(raw); } catch (e) { if (e instanceof DestinationError) throw new HttpError(422, e.message, "base_url"); throw e; }
}

export function registerAgentRoutes(app: FastifyInstance, ctx: Ctx) {
  const A = (req: FastifyRequest): Actor => req.actor!;
  const need = (req: FastifyRequest, roles: readonly Actor["role"][]) => {
    if (!roles.includes(A(req).role)) throw new HttpError(403, `A ${A(req).role} cannot do that.`, "forbidden");
  };
  const rt = () => runtimeOf(ctx);

  app.get("/api/agents", async (req) => {
    const role = A(req).role;
    return {
      label: ADVISORY_LABEL,
      provider: rt().settings(),
      canConfigure: (CONFIGURE as readonly string[]).includes(role),
      background: { allowed: backgroundAllowed(), on: agentsOn(ctx), canSwitch: (CONFIGURE as readonly string[]).includes(role), canRunNow: role === "pharmacist" },
      agents: allAgents().map((a) => ({ id: a.id, name: a.name, purpose: a.purpose, guardrails: a.guardrails, roles: a.roles, canRun: canRun(a, role), readOnly: true, background: backgroundStatus(ctx).find((s) => s.id === a.id) ?? null }))
    };
  });

  // ---- background mode: switch an agent on or off, or run it now (a pharmacist or admin switches; only a pharmacist runs now)
  const agentId = (req: FastifyRequest) => z.object({ id: z.string().max(40) }).parse(req.params).id;
  app.post("/api/agents/:id/enable", async (req) => ({ status: setEnabled(ctx, A(req), agentId(req), true) }));
  app.post("/api/agents/:id/disable", async (req) => ({ status: setEnabled(ctx, A(req), agentId(req), false) }));
  app.post("/api/agents/:id/run-now", async (req) => ({ status: await runNow(ctx, A(req), agentId(req)), summary: suggestionSummary(ctx) }));

  // ---- Rx Guardian suggestions: a pharmacist decides; a technician can read; a cashier and an admin cannot
  const SEE = ["pharmacist", "technician"] as const;
  app.get("/api/suggestions", async (req) => {
    need(req, SEE);
    const q = z.object({ status: z.enum(["open", "accepted", "dismissed", "resolved", "all"]).optional(), rx: z.string().max(20).optional(), patient: z.string().max(12).optional() }).parse(req.query);
    return { label: ADVISORY_LABEL, canDecide: A(req).role === "pharmacist", summary: suggestionSummary(ctx), suggestions: listSuggestions(ctx, { status: q.status ?? "open", rx: q.rx, patientId: q.patient }) };
  });
  const sid = (req: FastifyRequest) => z.object({ id: z.coerce.number().int().min(1) }).parse(req.params).id;
  app.post("/api/suggestions/:id/accept", async (req) => {
    need(req, ["pharmacist"]);
    const b = z.object({ note: z.string().max(300).optional() }).parse(req.body ?? {});
    return acceptSuggestion(ctx, A(req), sid(req), b.note);
  });
  app.post("/api/suggestions/:id/dismiss", async (req) => {
    need(req, ["pharmacist"]);
    const b = z.object({ reason: z.string().max(300) }).parse(req.body ?? {});
    return dismissSuggestion(ctx, A(req), sid(req), b.reason);
  });
  app.post("/api/suggestions/:id/change-request", async (req) => {
    need(req, ["pharmacist"]);
    const b = z.object({ message: z.string().max(2000).optional() }).parse(req.body ?? {});
    return requestChange(ctx, A(req), sid(req), b.message);
  });

  app.get("/api/agents/provider", async () => ({ provider: rt().settings() }));

  app.post("/api/agents/provider", async (req) => {
    need(req, CONFIGURE);
    const b = providerBody.parse(req.body);
    if (b.baseUrl) checkBaseUrl(b.baseUrl);
    const before = rt().settings();
    const r = rt().update(b as any);
    const after = rt().settings();
    // The audit row records what changed. The key is never part of it, only whether one was set.
    audit(ctx, A(req), "agents.provider.update", "agents", "provider", { provider: before.provider, model: before.model }, { provider: after.provider, model: after.model, region: after.region, baseUrl: after.baseUrl, keyChanged: r.keyChanged, keyHint: after.keyHint });
    return { provider: after };
  });

  app.post("/api/agents/provider/test", async (req) => {
    need(req, CONFIGURE);
    const r = await rt().test();
    audit(ctx, A(req), "agents.provider.test", "agents", "provider", undefined, { ok: r.ok, provider: r.provider, model: r.model });
    return r;
  });

  app.get("/api/agents/runs", async (req) => {
    const q = z.object({ agent: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).parse(req.query);
    return { label: ADVISORY_LABEL, runs: listRuns(ctx, q.agent, q.limit ?? 25) };
  });

  app.get("/api/agents/drafts", async (req) => {
    need(req, ["pharmacist"]);
    const q = z.object({ recallId: z.string().max(40).optional() }).parse(req.query);
    return { note: "Drafts only. Nothing here has been sent. Sending needs a pharmacist's attestation on the Recalls screen.", drafts: draftQueue(ctx, q.recallId) };
  });

  app.get("/api/agents/:id", async (req) => {
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    const a = getAgent(id);
    if (!a) throw new HttpError(404, "Unknown agent.");
    return {
      id: a.id, name: a.name, purpose: a.purpose, guardrails: a.guardrails, roles: a.roles, canRun: canRun(a, A(req).role), readOnly: true,
      sample: canRun(a, A(req).role) ? sampleFor(ctx, a.id) : null, runs: listRuns(ctx, a.id, 5)
    };
  });

  app.post("/api/agents/:id/run", async (req) => {
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    const a = getAgent(id);
    if (!a) throw new HttpError(404, "Unknown agent.");
    need(req, a.roles);
    const body = z.object({ input: z.record(z.unknown()).optional(), useSample: z.boolean().optional() }).parse(req.body ?? {});
    const input = body.useSample || !body.input ? sampleFor(ctx, id) : body.input;
    const run = await runAgent(ctx, A(req), id, input);
    return { label: ADVISORY_LABEL, input, run };
  });
}
