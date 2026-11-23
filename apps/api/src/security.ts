import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { HttpError, type Ctx } from "./core";

/**
 * API hardening (SEC-2): security headers, login throttling per IP and per account, CSRF origin check, request logging
 * that carries no PHI, and error bodies that never echo what the caller sent. Sandbox pilot controls, not a
 * compliance claim (see docs/SECURITY.md).
 */

// ---------------------------------------------------------------------------------------------- headers

/** A CSP that fits the Vite build: own scripts and workers (OCR runs in a worker), inline styles (React style props), Google Fonts. */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

export const PERMISSIONS_POLICY = "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), serial=(), interest-cohort=()";

// ---------------------------------------------------------------------------------------------- rate limiting

/** Sliding-window failure counter. The clock is injected so tests can move time. */
export class FailureLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  private live(key: string, now: number) {
    const a = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (a.length) this.hits.set(key, a); else this.hits.delete(key);
    return a;
  }
  fail(key: string, now: number) { const a = this.live(key, now); a.push(now); this.hits.set(key, a); }
  /** seconds to wait, or 0 when the key is free */
  retryAfter(key: string, now: number): number {
    const a = this.live(key, now);
    return a.length >= this.max ? Math.max(1, Math.ceil((a[0]! + this.windowMs - now) / 1000)) : 0;
  }
  clear(key: string) { this.hits.delete(key); }
  get size() { return this.hits.size; }
}

export interface SecurityOptions { ipMax?: number; acctMax?: number; windowMs?: number; corsOrigins?: string[] }

export const DEFAULT_CORS = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174", "http://127.0.0.1:5174", "http://localhost:4000", "http://127.0.0.1:4000"];

export function corsOriginsFrom(env: Record<string, string | undefined> = process.env): string[] {
  const x = (env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return x.length ? x : DEFAULT_CORS;
}

const LOGIN_PATHS = new Set(["/api/auth/login", "/api/auth/verify"]);
/** POST routes that take no body: anything but an empty body is refused, so a stray payload is never silently ignored. */
const NO_BODY = [
  /^\/api\/rx\/[^/]+\/review$/, /^\/api\/dispenses\/\d+\/label$/, /^\/api\/recalls\/[^/]+\/(return-pickup|manufacturer-response|close)$/,
  /^\/api\/integrations\/[^/]+\/rotate$/, /^\/api\/patients\/[^/]+\/refill-sync$/, /^\/api\/outreach\/run$/, /^\/api\/night-watch\/run$/,
  /^\/api\/auth\/logout$/
];

// ---------------------------------------------------------------------------------------------- request log

export type LogLine = { t: string; method: string; route: string; status: number; ms: number; actor?: string; store?: string; ip: string; error?: string };
let sink: (l: LogLine) => void = (l) => { if (process.env.NODE_ENV !== "test" && !process.env.VITEST) console.log(JSON.stringify(l)); };
/** Replace where request log lines go (tests). Returns a function that restores the default. */
export function setRequestLogSink(fn: (l: LogLine) => void) { const prev = sink; sink = fn; return () => { sink = prev; }; }

// ---------------------------------------------------------------------------------------------- error bodies

/**
 * The only shapes a caller ever sees. Validation messages are rebuilt from the field path and the rule that failed,
 * never from the value that was sent (zod's own text for enums quotes the input). Unknown errors become a generic 500.
 */
export function publicError(err: any): { status: number; body: Record<string, unknown> } {
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => {
      const where = i.path.join(".") || "body";
      const why = i.code === "invalid_type" ? (i.received === "undefined" ? "is required" : `must be ${i.expected}`)
        : i.code === "too_small" ? "is too short or too small" : i.code === "too_big" ? "is too long or too large"
        : i.code === "invalid_string" ? "has the wrong format" : i.code === "unrecognized_keys" ? "has unexpected fields" : "is not an allowed value";
      return `${where} ${why}`;
    });
    return { status: 422, body: { error: "Some fields are missing or wrong.", issues } };
  }
  if (err instanceof HttpError) return { status: err.status, body: { error: err.message, code: err.code } };
  const status = typeof err?.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
  if (status === 413) return { status, body: { error: "That request is too large." } };
  if (status === 415) return { status, body: { error: "Send JSON with Content-Type: application/json." } };
  if (status < 500) return { status, body: { error: "The request could not be read." } };
  return { status: 500, body: { error: "Something went wrong." } };
}

// ---------------------------------------------------------------------------------------------- plugin

export function registerSecurity(app: FastifyInstance, ctx: Ctx, opts: SecurityOptions = {}) {
  const windowMs = opts.windowMs ?? 15 * 60_000;
  const ipLimit = new FailureLimiter(opts.ipMax ?? 20, windowMs);
  const acctLimit = new FailureLimiter(opts.acctMax ?? 10, windowMs);
  const origins = new Set(opts.corsOrigins ?? corsOriginsFrom());
  const acctKey = (req: FastifyRequest) => {
    const b = (req.body ?? {}) as { email?: unknown; storeId?: unknown; challenge?: unknown };
    return typeof b.email === "string" ? `acct:${String(b.storeId ?? "")}:${b.email.trim().toLowerCase().slice(0, 120)}` : typeof b.challenge === "string" ? `chal:${b.challenge.slice(0, 100)}` : "";
  };

  app.addHook("onRequest", async (req, reply) => {
    (req as any).t0 = performance.now();
    // CSRF defence in depth on top of SameSite=Lax: a browser request that changes state and names a foreign Origin is refused.
    const origin = req.headers.origin;
    if (origin && req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && req.url.startsWith("/api/")) {
      const host = req.headers.host;
      let same = false;
      try { same = !!host && new URL(origin).host === host; } catch { /* malformed origin */ }
      if (!same && !origins.has(origin)) return reply.code(403).send({ error: "That origin is not allowed.", code: "bad_origin" });
    }
  });

  // Login throttling: count failures per IP and per account (known or not, so the answer never reveals which accounts exist).
  app.addHook("preValidation", async (req, reply) => {
    const url = req.url.split("?")[0]!;
    if (req.method !== "POST") return;
    if (LOGIN_PATHS.has(url)) {
      const now = ctx.now();
      const ka = acctKey(req);
      const wait = Math.max(ipLimit.retryAfter(`ip:${req.ip}`, now), ka ? acctLimit.retryAfter(ka, now) : 0);
      if (wait) return reply.code(429).header("Retry-After", String(wait)).send({ error: `Too many sign-in attempts. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? "s" : ""}.`, code: "rate_limited" });
    }
    if (NO_BODY.some((r) => r.test(url))) {
      const b = req.body;
      if (b !== undefined && b !== null && !(typeof b === "object" && !Array.isArray(b) && Object.keys(b as object).length === 0)) {
        return reply.code(422).send({ error: "This action takes no request body.", code: "unexpected_body" });
      }
    }
  });

  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split("?")[0]!;
    const now = ctx.now();
    if (req.method === "POST" && LOGIN_PATHS.has(url) && (reply.statusCode === 401 || reply.statusCode === 423)) {
      ipLimit.fail(`ip:${req.ip}`, now);
      const ka = acctKey(req);
      if (ka) acctLimit.fail(ka, now);
    }
    // One line per request: method, route pattern (never the raw URL, which can hold ids and search text), status, timing, ids.
    sink({
      t: new Date(now).toISOString(), method: req.method, route: req.routeOptions?.url ?? "unmatched", status: reply.statusCode,
      ms: Math.round(performance.now() - ((req as any).t0 ?? performance.now())), actor: req.actor?.id, store: req.actor?.storeId, ip: req.ip,
      error: (reply as any).__errClass
    });
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("Content-Security-Policy", CSP);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", PERMISSIONS_POLICY);
    reply.header("X-Frame-Options", "DENY");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.removeHeader("X-Powered-By");
    if (ctx.cfg.cookieSecure) reply.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    if (req.url.startsWith("/api/") && !reply.getHeader("Cache-Control")) reply.header("Cache-Control", "no-store");
    return payload;
  });
}
