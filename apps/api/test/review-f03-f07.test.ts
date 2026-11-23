import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, Db, ingestFaxInbox, loadConfig, SandboxNotifier, seedDatabase, type Ctx } from "../src/index";
import { AgentRuntime, runAgent } from "../src/agents";
import { ACCESS, rolesOf } from "../src/access";
import { assertDestination, blockedAddress, checkDestinationLiteral, DestinationError } from "../src/agents/destination";
import { OpenAiCompatibleProvider } from "../src/agents/providers";
import { STORE_1 } from "../src/stores";
import type { Actor } from "../src/core";

// REV F03 (read authorization matrix) and F07 (provider destination policy). Synthetic in-memory data only; no real network.

process.env.OFFLINE = "1";
const PW = "moonlight-rx-2026";
const NOW = Date.parse("2026-11-22T18:00:00Z");
const WHO = { pharmacist: "j.rivera", technician: "k.patel", cashier: "m.diaz", admin: "s.grant" } as const;
type Who = keyof typeof WHO;
const ROLES = Object.keys(WHO) as Who[];
const pharmacist: Actor = { id: "u-rivera", name: "J. Rivera, PharmD", role: "pharmacist", storeId: STORE_1, workstation: "review f03" };

let app: FastifyInstance;
let ctx: Ctx;
const cookies: Record<string, string> = { anon: "" };

beforeAll(async () => {
  const cfg = loadConfig({}, { sqlitePath: ":memory:", sandboxDelayMs: 20, today: "2026-11-22", nightWatch: false, assetsDir: "/nonexistent", webDist: "/nonexistent" });
  const db = new Db(":memory:");
  ctx = { cfg, db, notify: new SandboxNotifier(db, cfg), now: () => NOW, agents: new AgentRuntime({ LLM_PROVIDER: "mock" }) };
  seedDatabase(db, cfg, NOW);
  await ingestFaxInbox(ctx);
  app = await buildApp(ctx);
  for (const r of ROLES) {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { storeId: "store-7", email: `${WHO[r]}@elmstreetrx.example`, password: PW, trusted: true } });
    expect(res.statusCode).toBe(200);
    cookies[r] = res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }
  // Give every clinical read something to return: a confirmed recall, a Guardian run, outreach drafts.
  const look = await app.inject({ method: "POST", url: "/api/recalls/lookup", headers: { cookie: cookies.pharmacist! }, payload: { number: "D-0417-2026" } });
  expect(look.statusCode).toBe(200);
  await runAgent(ctx, pharmacist, "rx-guardian", {});
}, 60_000);
afterAll(async () => { await app.close(); ctx.db.raw.close(); });

const as = (who: Who | "anon", method: string, url: string, payload?: unknown) => app.inject({ method: method as "GET", url, payload: payload as never, headers: { cookie: cookies[who]! } });
const concrete = (url: string) => url
  .replace("/recalls/:id", "/recalls/D-0417-2026").replace("/agents/:id", "/agents/rx-guardian")
  .replace(":rx", "0072210").replace(":id", "1").replace(":challenge", "x").replace(":file", "x").replace(":fda", "D-0417-2026").replace(":webhookId", "1");

// ------------------------------------------------------------------ F03

/**
 * Routes a cashier or admin may read on purpose, with the reason. Everything else a cashier or admin can read must hold no patient id,
 * allergy or date of birth. A route that is open to them but not listed here fails the scan below.
 */
const PICKUP_READS: Record<string, string> = {
  "GET /api/rx": "pickup queue: the cashier hands over medicine; the columns are fixed in fill.ts and carry no allergies or DOB",
  "GET /api/rx/:rx": "one order at pickup: dob, email and allergies are withheld from the cashier in rxDetail",
  "GET /api/search": "lots plus pickup-queue rows (the cashier already reads the queue); the admin gets lots only",
  "GET /api/register/patients": "register patient finder: name and id only",
  "GET /api/register/patients/:id": "register: what is ready for this patient to pick up",
  "GET /api/audit": "admin and pharmacist read the audit log: ids only, no names, no clinical text"
};
const PATIENT_ID = /\bS-\d{4}\b/;

describe("F03 read authorization matrix", () => {
  it("every registered route has a row in the matrix, and every row is a registered route", () => {
    const registered = new Set(app.routeTable.map((r) => `${r.method} ${r.url}`));
    expect([...registered].filter((k) => !(k in ACCESS)).sort(), "routes with no matrix row").toEqual([]);
    expect(Object.keys(ACCESS).filter((k) => !registered.has(k)).sort(), "matrix rows with no route").toEqual([]);
    expect(registered.size).toBeGreaterThan(100);
  });

  it("default deny: a route nobody listed answers 403 to every signed-in role and 401 to an anonymous caller", async () => {
    const fresh = await buildApp(ctx); // same database and sessions, plus one route that nobody added to the matrix
    fresh.get("/api/zz-unlisted", async () => ({ secret: "S-0001 allergic to penicillin" }));
    const hit = (who: Who | "anon") => fresh.inject({ method: "GET", url: "/api/zz-unlisted", headers: { cookie: cookies[who]! } });
    for (const r of ROLES) {
      const res = await hit(r);
      expect(res.statusCode, r).toBe(403);
      expect(res.json().code).toBe("route_unlisted");
    }
    expect((await hit("anon")).statusCode).toBe(401);
    await fresh.close();
  });

  it("anonymous gets 401 on every session route; a role the matrix does not list gets 403", async () => {
    const bad: string[] = [];
    for (const [key, rule] of Object.entries(ACCESS)) {
      const roles = rolesOf(rule);
      if (!roles) continue; // public, partner and static rows are covered below
      const [method, pattern] = key.split(" ") as [string, string];
      const url = concrete(pattern);
      const anon = await as("anon", method, url, method === "POST" ? {} : undefined);
      if (anon.statusCode !== 401) bad.push(`${key} anonymous -> ${anon.statusCode}`);
      for (const r of ROLES.filter((x) => !roles.includes(x))) {
        const res = await as(r, method, url, method === "POST" ? {} : undefined);
        if (res.statusCode !== 403) bad.push(`${key} ${r} -> ${res.statusCode}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every GET a role is listed for answers it (never 403 from the matrix); partner rows ignore a staff session", async () => {
    const bad: string[] = [];
    for (const [key, rule] of Object.entries(ACCESS)) {
      const [method, pattern] = key.split(" ") as [string, string];
      if (method !== "GET") continue;
      const roles = rolesOf(rule);
      if (!roles) {
        if (rule === "partner" && pattern !== "/fhir/r4/metadata") {
          const res = await as("pharmacist", "GET", concrete(pattern));
          if (res.statusCode === 200) bad.push(`${key} answered a staff session with 200`);
        }
        continue;
      }
      for (const r of roles) {
        const res = await as(r, "GET", concrete(pattern));
        if (res.statusCode === 403 || res.statusCode === 401 || res.statusCode >= 500) bad.push(`${key} ${r} -> ${res.statusCode}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("a cashier or admin can read no patient id, allergy or date of birth, except the listed pickup and audit reads", async () => {
    const bad: string[] = [];
    for (const who of ["cashier", "admin"] as const) {
      for (const [key, rule] of Object.entries(ACCESS)) {
        const [method, pattern] = key.split(" ") as [string, string];
        const roles = rolesOf(rule);
        if (method !== "GET" || !roles?.includes(who)) continue;
        const res = await as(who, "GET", concrete(pattern));
        if (res.statusCode !== 200) continue;
        const body = res.body;
        if (key in PICKUP_READS) {
          if (/allerg[a-z]*"\s*:\s*"[^"]/i.test(body) || /allerg[a-z]*"\s*:\s*\[\s*"/i.test(body) || /"dob"\s*:\s*"/i.test(body)) bad.push(`${who} ${key} returns allergies or DOB`);
          continue;
        }
        if (PATIENT_ID.test(body) || /"allerg[a-z]*"\s*:/i.test(body) || /"dob"/i.test(body)) bad.push(`${who} ${key} returns patient-linked data`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the reviewer's reads: runs, Guardian results, recalls, recall detail and results are 403 for cashier and admin, 200 for pharmacist and technician", async () => {
    for (const url of ["/api/agents/runs", "/api/agents/rx-guardian", "/api/recalls", "/api/recalls/D-0417-2026", "/api/recalls/D-0417-2026/results", "/api/recalls/D-0417-2026/messages", "/api/fax", "/api/outbox", "/api/suggestions"]) {
      expect((await as("anon", "GET", url)).statusCode, `anon ${url}`).toBe(401);
      for (const r of ["cashier", "admin"] as const) expect((await as(r, "GET", url)).statusCode, `${r} ${url}`).toBe(403);
      for (const r of ["pharmacist", "technician"] as const) expect((await as(r, "GET", url)).statusCode, `${r} ${url}`).toBe(200);
    }
    for (const url of ["/api/recalls/D-0417-2026/voicemail", "/api/recalls/D-0417-2026/calls", "/api/recalls/D-0417-2026/report.pdf", "/api/recalls/D-0417-2026/trace-export"]) {
      for (const r of ["cashier", "admin", "technician"] as const) expect((await as(r, "GET", url)).statusCode, `${r} ${url}`).toBe(403);
      expect((await as("pharmacist", "GET", url)).statusCode, url).toBe(200);
    }
  });

  it("the Today screen gives a cashier and an admin counts, no patient-naming Rx Watcher tasks", async () => {
    for (const r of ["cashier", "admin"] as const) {
      const body = (await as(r, "GET", "/api/today")).body;
      expect(body, r).not.toMatch(/Review Rx|Waiting on prescriber/);
    }
    expect((await as("pharmacist", "GET", "/api/today")).body).toMatch(/Review Rx|Waiting on prescriber|Verify|Check in/);
  });

  it("the pickup and admin flows still work: cashier register and pickup queue, admin integrations", async () => {
    for (const url of ["/api/me", "/api/today", "/api/rx", "/api/register/items?q=a", "/api/register/patients?q=a", "/api/lots", "/api/deliveries", "/api/agents"]) expect((await as("cashier", "GET", url)).statusCode, `cashier ${url}`).toBe(200);
    for (const url of ["/api/me", "/api/integrations", "/api/audit", "/api/audit/verify", "/api/agents", "/api/agents/provider"]) expect((await as("admin", "GET", url)).statusCode, `admin ${url}`).toBe(200);
  });
});

// ------------------------------------------------------------------ F07

describe("F07 provider destination policy: addresses", () => {
  const blocked = [
    "http://169.254.169.254/latest", "http://169.254.0.1/", "http://169.254.169.254./latest",
    "http://[::ffff:169.254.169.254]/latest", "http://[::ffff:a9fe:a9fe]/latest", "http://[::FFFF:A9FE:A9FE]/latest", "http://[0:0:0:0:0:ffff:a9fe:a9fe]/latest",
    "http://[::169.254.169.254]/", "http://[64:ff9b::a9fe:a9fe]/", "http://[::ffff:0:a9fe:a9fe]/",
    "http://2852039166/latest", "http://0251.0376.0251.0376/latest", "http://0xa9.0xfe.0xa9.0xfe/latest", "http://0xa9fea9fe/latest", "http://169.254.169.254.:80/",
    "http://[fe80::1]/", "http://[FE80::abcd]/", "http://[febf::1]/", "http://[fd00:ec2::254]/latest", "http://[FD00:EC2::254]/latest",
    "http://metadata.google.internal/computeMetadata/v1/", "http://METADATA.google.internal./", "http://instance-data/latest",
    "http://user:pw@localhost:11434/v1", "http://:pw@localhost:11434/v1", "file:///etc/passwd", "ftp://localhost/", "not a url"
  ];
  for (const u of blocked) it(`refuses ${u}`, () => { expect(() => checkDestinationLiteral(u)).toThrow(DestinationError); });

  const allowed = ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:11434/v1", "http://LOCALHOST:11434/v1", "https://api.openai.com/v1", "http://[::ffff:7f00:1]:11434/v1", "http://10.0.0.5:8000/v1", "http://[2001:db8::1]/v1", "http://localhost./v1"];
  for (const u of allowed) it(`allows ${u}`, () => { expect(() => checkDestinationLiteral(u)).not.toThrow(); });

  it("blockedAddress reads the numeric value, not a text prefix", () => {
    expect(blockedAddress("169.254.1.1")).toBeTruthy();
    expect(blockedAddress("169.253.1.1")).toBeNull();
    expect(blockedAddress("1169.254.1.1")).toBeNull();
    expect(blockedAddress("::ffff:169.254.169.254")).toBeTruthy();
    expect(blockedAddress("[::ffff:a9fe:a9fe]")).toBeTruthy();
    expect(blockedAddress("fe80::1%en0")).toBeTruthy();
    expect(blockedAddress("fec0::1")).toBeNull();
    expect(blockedAddress("::ffff:127.0.0.1")).toBeNull();
    expect(blockedAddress("::1")).toBeNull();
    expect(blockedAddress("::")).toBeNull();
  });

  it("the settings route answers 422 for each form and 200 for the local model endpoints", async () => {
    for (const baseUrl of ["http://[::ffff:169.254.169.254]/latest", "http://[::ffff:a9fe:a9fe]/latest", "http://2852039166/", "http://[fe80::1]/", "http://[fd00:ec2::254]/latest", "http://169.254.169.254./latest"]) {
      const res = await as("pharmacist", "POST", "/api/agents/provider", { provider: "openai-compatible", baseUrl });
      expect(res.statusCode, baseUrl).toBe(422);
    }
    for (const baseUrl of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1"]) expect((await as("admin", "POST", "/api/agents/provider", { provider: "openai-compatible", baseUrl })).statusCode, baseUrl).toBe(200);
    await as("pharmacist", "POST", "/api/agents/provider", { provider: "mock" });
  });
});

describe("F07 provider destination policy: resolution, redirects and the request itself", () => {
  const resolvesTo = (...addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  const okFetch = () => {
    const calls: { url: string; init: any }[] = [];
    const f = (async (url: string, init: any) => { calls.push({ url, init }); return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) }; }) as unknown as typeof fetch;
    return { f, calls };
  };

  it("a host name that resolves to a blocked address is refused, whichever answer it is", async () => {
    for (const bad of ["169.254.169.254", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "fe80::1", "fd00:ec2::254"]) {
      await expect(assertDestination("http://models.example.com/v1", resolvesTo("93.184.216.34", bad)), bad).rejects.toThrow(DestinationError);
    }
    await expect(assertDestination("http://models.example.com/v1", resolvesTo("93.184.216.34"))).resolves.toBeInstanceOf(URL);
    await expect(assertDestination("http://models.example.com/v1", async () => { throw new Error("ENOTFOUND"); })).rejects.toThrow(/did not resolve/);
    await expect(assertDestination("http://models.example.com/v1", resolvesTo())).rejects.toThrow(/did not resolve/);
  });

  it("a refused destination gets no request and never sees the key", async () => {
    const { f, calls } = okFetch();
    for (const [url, lookup] of [
      ["http://[::ffff:169.254.169.254]/latest", undefined], ["http://169.254.169.254/latest", undefined], ["http://rebind.example.com/v1", resolvesTo("169.254.169.254")],
      ["http://rebind.example.com/v1", resolvesTo("::ffff:a9fe:a9fe")], ["http://u:p@localhost:11434/v1", undefined]
    ] as const) {
      await expect(new OpenAiCompatibleProvider(url, "sk-secret-123", "m", f, lookup).complete("s", "u"), url).rejects.toThrow(/refused/);
    }
    expect(calls).toEqual([]);
  });

  it("an allowed destination is called once, with redirects switched off so a redirect cannot reach a blocked address", async () => {
    const { f, calls } = okFetch();
    expect(await new OpenAiCompatibleProvider("http://localhost:11434/v1", "", "llama3", f).complete("s", "u")).toBe("ok");
    expect(await new OpenAiCompatibleProvider("https://models.example.com/v1", "k", "m", f, resolvesTo("93.184.216.34")).complete("s", "u")).toBe("ok");
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.init.redirect).toBe("error");
    expect(calls[1]!.init.headers.authorization).toBe("Bearer k");
  });

  it("a saved or environment URL that the policy refuses never reaches fetch, even though the settings route was never asked", async () => {
    const { f, calls } = okFetch();
    const rt = new AgentRuntime({ LLM_PROVIDER: "openai-compatible", OPENAI_BASE_URL: "http://[::ffff:a9fe:a9fe]/latest", OPENAI_API_KEY: "sk-env-1234" }, { fetch: f });
    const res = await rt.test();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/refused/);
    expect(calls).toEqual([]);
  });
});
