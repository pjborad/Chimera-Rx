import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp, Db, ingestFaxInbox, loadConfig, SandboxNotifier, seedDatabase, type Ctx } from "../src/index";
import { AgentRuntime } from "../src/agents";
import { seedStore2 } from "../src/seed-store2";
import { createStores, STORE_1, STORE_2 } from "../src/stores";

// REV-API role-by-route matrix: every route registered in src/ is called as each role (and with no session) using an empty
// body. A route fails the matrix when a role that must not change state gets anything but 401/403.

const PW = "moonlight-rx-2026";
const NOW = Date.parse("2026-11-18T18:00:00Z");
process.env.OFFLINE = "1";
const ROLES = ["anon", "cashier", "technician", "admin", "pharmacist"] as const;
type R = (typeof ROLES)[number];
const WHO: Record<string, string> = { cashier: "m.diaz", technician: "k.patel", admin: "s.grant", pharmacist: "j.rivera" };

/** POST routes and the roles that may call them. Anything not listed is pharmacist-only. */
const ALLOW: Record<string, R[]> = {
  "/api/auth/login": ROLES.slice(), "/api/auth/verify": ROLES.slice(), "/api/auth/logout": ROLES.slice(),
  "/api/deliveries/:id/scan": ["technician", "pharmacist"], "/api/packages/:id/putaway": ["technician", "pharmacist"], "/api/packages/:id/problem": ["technician", "pharmacist"],
  "/api/lots/:id/move": ["technician", "pharmacist"], "/api/lots/:id/adjust": ["technician", "pharmacist"],
  "/api/rx/:rx/review": ["technician", "pharmacist"],
  "/api/rx/:rx/scan": ["technician", "pharmacist"],
  "/api/dispenses/:id/label": ["technician", "pharmacist"],
  "/api/recalls/:id/voicemail/preview": ["pharmacist"],
  "/api/ocr/parse": ["cashier", "technician", "admin", "pharmacist"],
  "/api/sms/inbound": ["cashier", "technician", "admin", "pharmacist"], "/api/calls/inbound": ["cashier", "technician", "admin", "pharmacist"],
  "/api/integrations": ["admin"], "/api/integrations/:id": ["admin"], "/api/integrations/:id/rotate": ["admin"], "/api/integrations/:id/webhooks": ["admin"],
  "/api/register/sales": ["cashier", "pharmacist"],
  "/api/epcis/import": ["technician", "pharmacist"], "/api/dscsa/verify": ["technician", "pharmacist"],
  "/api/refills/draft": ["technician", "pharmacist"],
  "/api/dispenses/:id/sell": ["cashier", "pharmacist"],
  "/api/rx/:rx/decision": ["pharmacist"],
  "/api/recalls/:id/preview": ["technician", "pharmacist"], // merges a patient's fields: not for cashier or admin
  "/api/agents/provider": ["admin", "pharmacist"], "/api/agents/provider/test": ["admin", "pharmacist"],
  "/api/agents/:id/run": ["technician", "admin", "pharmacist"], // coroner
  "/api/agents/:id/enable": ["admin", "pharmacist"], "/api/agents/:id/disable": ["admin", "pharmacist"] // background mode (Rx Guardian)
};

function sourceRoutes(): { method: string; url: string }[] {
  const dir = path.join(__dirname, "../src");
  const files = [...fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => path.join(dir, f)), ...fs.readdirSync(path.join(dir, "agents")).map((f) => path.join(dir, "agents", f))]
    .filter((f) => !/partner-api|webhooks/.test(f));
  const out: { method: string; url: string }[] = [];
  for (const f of files) for (const m of fs.readFileSync(f, "utf8").matchAll(/app\.(get|post|put|delete|patch)\(\s*"(\/api\/[^"]+)"/g)) out.push({ method: m[1]!.toUpperCase(), url: m[2]! });
  return out;
}
/** Valid minimal bodies, so a 422 can never hide a missing role check (validation must not be the only thing stopping a role). */
const BODY: Record<string, unknown> = {
  "/api/rx/:rx/decision": { action: "approve" }, "/api/rx/:rx/scan": { raw: "x" }, "/api/dispenses/:id/verify": { checklist: [true] },
  "/api/dispenses/:id/sendback": { reason: "x" }, "/api/dispenses/:id/sell": { idChecked: true, counseled: true, signature: true },
  "/api/recalls/:id/confirm-lot": { lot: "X" }, "/api/recalls/:id/preview": { sms: "hi", emailSubject: "s", emailBody: "b" },
  "/api/recalls/:id/notifications": { sms: "hello there friend", emailSubject: "subj", emailBody: "body body body", attest: true },
  "/api/recalls/:id/voicemail/preview": { script: "x" }, "/api/recalls/:id/voicemail": { script: "x", attest: true },
  "/api/calls/inbound": { from: "5550100100" }, "/api/ocr/parse": { text: "" }, "/api/sms/inbound": { from: "5550100100", body: "hi" },
  "/api/integrations": { partner: "Test Co", kind: "REST", scopes: ["availability.check"] }, "/api/integrations/:id": { purpose: "x" },
  "/api/integrations/:id/webhooks": { url: "https://hooks.example.com/h", events: ["recall.opened"] },
  "/api/register/sales": { items: [], dispenseIds: [] },
  "/api/stock-help/decision": { kind: "reorder", key: "k", decision: "dismissed" },
  "/api/epcis/import": { document: {}, dryRun: false }, "/api/dscsa/verify": { gtin: "00370004417055", serial: "1", lot: "L" }, "/api/dscsa/cases": { note: "x" },
  "/api/dscsa/cases/:id/close": { status: "closed_cleared" }, "/api/refills/send": { attest: true }, "/api/agents/provider": {},
  "/api/prescriber-messages/:id/respond": { response: "approved" }, "/api/recalls/lookup": { number: "x" },
  "/api/lots/:id/move": { location: "A1" }, "/api/lots/:id/adjust": { count: 1, reason: "x" }, "/api/packages/:id/problem": { kind: "damaged" }, "/api/deliveries/:id/scan": { raw: "x" }
};
/** Routes that wipe or reload state (and sign everyone out) run last. */
const LAST: string[] = [];
const concrete = (u: string) => u.replace(":id", u.includes("/agents/") ? "coroner" : "1").replace(":rx", "RX-NONE").replace(":challenge", "x").replace(":file", "x");

let app: FastifyInstance; let db: Db;
const cookies: Record<string, string> = { anon: "" };
const table: string[] = [];

async function signIn() {
  for (const r of ROLES.filter((x) => x !== "anon")) {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { storeId: "store-7", email: `${WHO[r]}@elmstreetrx.example`, password: PW, trusted: true } });
    cookies[r] = res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }
}

beforeAll(async () => {
  const cfg = loadConfig({}, { sqlitePath: ":memory:", sandboxDelayMs: 20, today: "2026-11-18", nightWatch: false, assetsDir: "/nonexistent", webDist: "/nonexistent" });
  db = new Db(":memory:");
  const ctx: Ctx = { cfg, db, notify: new SandboxNotifier(db, cfg), now: () => NOW, agents: new AgentRuntime({ LLM_PROVIDER: "mock" }) };
  seedDatabase(db, cfg, NOW); await ingestFaxInbox(ctx);
  app = await buildApp(ctx);
  for (const r of ROLES.filter((x) => x !== "anon")) {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { storeId: "store-7", email: `${WHO[r]}@elmstreetrx.example`, password: PW, trusted: true } });
    cookies[r] = res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }
});

describe("REV-API role-by-route matrix", () => {
  it("finds the routes in source", () => { expect(sourceRoutes().length).toBeGreaterThan(100); });

  it("every unauthenticated /api call (except the public list) is 401", async () => {
    const PUB = new Set(["/api/health", "/api/auth/login", "/api/auth/config", "/api/auth/logout", "/api/auth/verify"]);
    const bad: string[] = [];
    for (const r of sourceRoutes()) {
      if (PUB.has(r.url) || r.url.startsWith("/api/auth/demo-code")) continue;
      const res = await app.inject({ method: r.method as "GET", url: concrete(r.url), payload: r.method === "POST" ? {} : undefined });
      if (res.statusCode !== 401) bad.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });

  it("no role outside the allow list changes state on any POST route", async () => {
    const bad: string[] = [];
    for (const r of sourceRoutes().filter((x) => x.method === "POST" && !x.url.startsWith("/api/auth/") && x.url !== "/api/transfers").sort((a, b) => Number(LAST.includes(a.url)) - Number(LAST.includes(b.url)))) {
      const allowed = ALLOW[r.url] ?? ["pharmacist"];
      const row: string[] = [];
      if (LAST.includes(r.url)) await signIn(); // a reset signs everyone out
      for (const role of ROLES) {
        const res = await app.inject({ method: "POST", url: concrete(r.url), headers: { cookie: cookies[role]! }, payload: BODY[r.url] as never });
        row.push(`${role}=${res.statusCode}`);
        if (!allowed.includes(role) && ![401, 403].includes(res.statusCode)) bad.push(`${r.url} as ${role} -> ${res.statusCode}`);
      }
      table.push(`${r.url} | ${row.join(" ")}`);
    }
    if (process.env.MATRIX_DUMP) fs.writeFileSync(process.env.MATRIX_DUMP, table.join("\n"));
    expect(bad).toEqual([]);
  });
});

describe("REV-API transfers between stores are pharmacist-only and never move a recalled lot", () => {
  it("403 for cashier, technician, admin; 401 anonymous; refusal for a recalled lot", async () => {
    const cfg = loadConfig({}, { sqlitePath: ":memory:", sandboxDelayMs: 20, today: "2026-11-18", nightWatch: false, assetsDir: "/nonexistent", webDist: "/nonexistent" });
    const { reg, db } = createStores(cfg);
    seedDatabase(reg.db(STORE_1), cfg, NOW); seedStore2(reg.db(STORE_2), NOW);
    const ctx2: Ctx = { cfg, db, stores: reg, notify: new SandboxNotifier(db, cfg), now: () => NOW };
    await reg.each(() => ingestFaxInbox(ctx2));
    const app2 = await buildApp(ctx2);
    const ck: Record<string, string> = { anon: "" };
    for (const r of ["cashier", "technician", "admin", "pharmacist"]) {
      const res = await app2.inject({ method: "POST", url: "/api/auth/login", payload: { storeId: STORE_1, email: `${WHO[r]}@elmstreetrx.example`, password: PW, trusted: true } });
      ck[r] = res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    }
    const lot = reg.db(STORE_1).get<{ id: number }>("SELECT id FROM lots WHERE status = 'recalled' LIMIT 1") ?? reg.db(STORE_1).get<{ id: number }>("SELECT id FROM lots LIMIT 1")!;
    for (const r of ["anon", "cashier", "technician", "admin"]) {
      const res = await app2.inject({ method: "POST", url: "/api/transfers", headers: { cookie: ck[r]! }, payload: { toStore: STORE_2, lotId: lot.id, qty: 1 } });
      expect([401, 403], r).toContain(res.statusCode);
    }
    reg.db(STORE_1).run("UPDATE lots SET status = 'recalled' WHERE id = ?", lot.id);
    const res = await app2.inject({ method: "POST", url: "/api/transfers", headers: { cookie: ck.pharmacist! }, payload: { toStore: STORE_2, lotId: lot.id, qty: 1 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("recalled");
  });
});
