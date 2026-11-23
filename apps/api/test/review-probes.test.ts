import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, Db, ingestFaxInbox, loadConfig, SandboxNotifier, seedDatabase, type Ctx } from "../src/index";
import { AgentRuntime } from "../src/agents";
import { ledgerViolations } from "../src/inventory";
import { setRequestLogSink, type LogLine } from "../src/security";
import { buildGs1 } from "./helpers";

// REV-API probes: double submit, edge inputs, error bodies, proxy headers, MFA first factor only, admin and cashier PHI reach.

const PW = "moonlight-rx-2026";
const NOW = Date.parse("2026-11-18T18:00:00Z");
process.env.OFFLINE = "1";

async function rig(over: Record<string, unknown> = {}) {
  const cfg = loadConfig({}, { sqlitePath: ":memory:", sandboxDelayMs: 5, today: "2026-11-18", nightWatch: false, assetsDir: "/nonexistent", webDist: "/nonexistent", ...over });
  const db = new Db(":memory:");
  const ctx: Ctx = { cfg, db, notify: new SandboxNotifier(db, cfg), now: () => NOW, agents: new AgentRuntime({ LLM_PROVIDER: "mock" }) };
  seedDatabase(db, cfg, NOW); await ingestFaxInbox(ctx);
  const app = await buildApp(ctx);
  const ck: Record<string, string> = {};
  if (!cfg.mfa) for (const w of ["j.rivera", "k.patel", "m.diaz", "s.grant"]) {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { storeId: "store-7", email: `${w}@elmstreetrx.example`, password: PW, trusted: true } });
    ck[w] = r.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }
  const call = (w: string, method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) => app.inject({ method, url, payload: payload as never, headers: { cookie: ck[w] ?? "", ...headers } });
  return { ctx, db, app, call };
}

describe("REV-API double submit", () => {
  it("two concurrent fill scans of one prescription dispense one package, not two", async () => {
    const { db, call, ctx } = await rig();
    // a slow model (live Bedrock takes seconds): the Rx Watcher explanation is awaited inside the scan, which opens the race window
    (ctx as any).llm = { name: "slow", complete: () => new Promise<string>((ok) => setTimeout(() => ok("{}"), 50)) };
    const rx = "0072214"; // atorvastatin, cleared by Rx Watcher, lot AT24K118 on the shelf with several units
    const r = db.get<any>("SELECT id FROM prescriptions WHERE rx = ?", rx)!;
    db.run("UPDATE prescriptions SET review = 'none' WHERE id = ?", r.id); // forces the async Rx Watcher pass, which opens the race window
    const body = { fields: { ndc: "70004-803-90", lot: "AT24K118", expiry: "2028-01-31" }, source: "typed" };
    const [a, b] = await Promise.all([call("k.patel", "POST", `/api/rx/${rx}/scan`, body), call("j.rivera", "POST", `/api/rx/${rx}/scan`, body)]);
    const codes = [a.statusCode, b.statusCode].sort();
    if (process.env.RACE_DUMP) console.log("RACE", a.body.slice(0, 200), "|", b.body.slice(0, 200));
    expect(codes).toEqual([200, 409]);
    expect(db.get<any>("SELECT COUNT(*) AS n FROM dispenses WHERE rx_id = ?", r.id)!.n).toBe(1);
    expect(ledgerViolations(ctx)).toEqual([]);
  });

  it("two concurrent sells of one dispense write one sale", async () => {
    const { db, call } = await rig();
    const d = db.get<any>("SELECT d.id FROM dispenses d WHERE d.state = 'verified' LIMIT 1");
    expect(d, "the seed has a verified fill waiting for pickup").toBeTruthy();
    const body = { idChecked: true, counseled: true, signature: true };
    const res = await Promise.all([call("m.diaz", "POST", `/api/dispenses/${d.id}/sell`, body), call("j.rivera", "POST", `/api/dispenses/${d.id}/sell`, body)]);
    expect(res.map((x) => x.statusCode).sort()).toEqual([200, 409]);
  });
});

describe("REV-API edge inputs", () => {
  it("negative, zero, huge and SQL-looking values are refused or harmless", async () => {
    const { call, db, ctx } = await rig();
    const lot = db.get<any>("SELECT id FROM lots LIMIT 1")!.id;
    expect((await call("j.rivera", "POST", `/api/lots/${lot}/adjust`, { count: -5, reason: "x" })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await call("m.diaz", "POST", "/api/register/sales", { items: [{ upc: "x", qty: -3 }], dispenseIds: [] })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await call("m.diaz", "POST", "/api/register/sales", { items: [{ upc: "x", qty: 1e9 }], dispenseIds: [] })).statusCode).toBeGreaterThanOrEqual(400);
    for (const q of ["' OR 1=1 --", "\"; DROP TABLE lots; --", "\u0000\u202e", "😀".repeat(500)]) {
      const r = await call("j.rivera", "GET", `/api/search?q=${encodeURIComponent(q)}`);
      expect(r.statusCode).toBe(200);
      const p = await call("j.rivera", "GET", `/api/patients?q=${encodeURIComponent(q)}`);
      expect(p.statusCode).toBe(200);
    }
    expect(db.get<any>("SELECT COUNT(*) AS n FROM lots")!.n).toBeGreaterThan(0);
    const big = await call("j.rivera", "POST", "/api/ocr/parse", { text: "x".repeat(3_000_000) });
    expect(big.statusCode).toBe(413);
    expect(ledgerViolations(ctx)).toEqual([]);
  });

  it("error bodies never carry a stack, SQL or what the caller sent", async () => {
    const { call } = await rig();
    const lines: LogLine[] = []; const restore = setRequestLogSink((l) => lines.push(l));
    const probes = [
      await call("j.rivera", "POST", "/api/recalls/NOPE/manufacturer-response"),
      await call("j.rivera", "POST", "/api/recalls/NOPE/close"),
      await call("j.rivera", "POST", "/api/recalls/NOPE/return-pickup"),
      await call("j.rivera", "POST", "/api/rx/0072214/scan", { raw: "Maria Alvarez (555) 010-0142" }),
      await call("j.rivera", "POST", "/api/integrations", "{not json", { "content-type": "application/json" }),
    ];
    // a patient view with a name in the reason: the answer is the profile (expected), the request log must not hold the reason
    expect((await call("j.rivera", "GET", "/api/patients/S-0417?reason=Maria%20Alvarez")).statusCode).toBe(200);
    restore();
    for (const r of probes) {
      expect(r.statusCode).not.toBe(500);
      expect(r.body).not.toMatch(/at \w+ \(|\.ts:\d+|SELECT |sqlite|Maria|010-0142|stack/i);
    }
    expect(probes.slice(0, 3).map((r) => r.statusCode)).toEqual([404, 404, 404]);
    expect(JSON.stringify(lines)).not.toMatch(/Maria|010-0142|S-0417|reason=/);
  });
});

describe("REV-API proxy headers, origin and cookies", () => {
  it("X-Forwarded-For does not reset the sign-in limiter (trust proxy is off by default)", async () => {
    const { app } = await rig();
    let last = 0;
    for (let i = 0; i < 25; i++) {
      const r = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-for": `10.0.0.${i}` }, payload: { storeId: "store-7", email: `nobody${i}@elmstreetrx.example`, password: "wrong" } });
      last = r.statusCode;
    }
    expect(last).toBe(429);
  });

  it("a foreign Origin, a lookalike Origin and a null Origin cannot change state", async () => {
    const { call } = await rig();
    for (const origin of ["https://evil.example", "http://localhost:5173.evil.example", "null", "http://localhost:51730"]) {
      const r = await call("j.rivera", "POST", "/api/outreach/run", undefined, { origin });
      expect(r.statusCode, origin).toBe(403);
    }
  });

  it("CORS never reflects a foreign origin with credentials", async () => {
    const { app } = await rig();
    const r = await app.inject({ method: "OPTIONS", url: "/api/me", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("a session token set before sign-in is not adopted (no fixation)", async () => {
    const { app } = await rig();
    const r = await app.inject({ method: "POST", url: "/api/auth/login", headers: { cookie: "lg_session=attacker-chosen" }, payload: { storeId: "store-7", email: "j.rivera@elmstreetrx.example", password: PW } });
    const c = r.cookies.find((x) => x.name === "lg_session")!;
    expect(c.value).not.toContain("attacker-chosen");
    expect(c.httpOnly).toBe(true);
    expect(String(c.sameSite).toLowerCase()).toBe("lax");
  });
});

describe("REV-API MFA: the first factor alone opens nothing", () => {
  it("password-only gives no session cookie, every API route stays 401, and there is no badge stand-in", async () => {
    const { app } = await rig({ mfa: true });
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { storeId: "store-7", email: "j.rivera@elmstreetrx.example", password: PW } });
    expect(r.statusCode).toBe(202);
    expect(r.cookies.find((c) => c.name === "lg_session")).toBeUndefined();
    const challenge = r.json().challenge as string;
    for (const u of ["/api/me", "/api/rx", "/api/patients?q=a", "/api/outbox"]) {
      expect((await app.inject({ url: u, headers: { cookie: `lg_session=${challenge}` } })).statusCode, u).toBe(401);
    }
    expect([401, 404]).toContain((await app.inject({ method: "POST", url: "/api/auth/sso" })).statusCode);
    // a wrong code many times locks the challenge (limiter), it never opens a session
    let code = 0;
    for (let i = 0; i < 12; i++) code = (await app.inject({ method: "POST", url: "/api/auth/verify", payload: { challenge, code: String(100000 + i) } })).statusCode;
    expect([401, 423, 429]).toContain(code);
  });
});

describe("REV-API least privilege on reads that name patients", () => {
  it("admin cannot read the fill queue, a prescription, the outbox or a recall message preview; search gives admin no prescriptions", async () => {
    const { call } = await rig();
    for (const u of ["/api/rx", "/api/rx/0072214", "/api/outbox", "/api/recalls/D-0417-2026/messages"]) expect((await call("s.grant", "GET", u)).statusCode, u).toBe(403);
    expect((await call("s.grant", "GET", "/api/search?q=ch")).json().rx).toEqual([]);
  });
  it("a cashier cannot read the outbox or recall message previews; the fill queue stays available to hand over medicine", async () => {
    const { call } = await rig();
    for (const u of ["/api/outbox", "/api/recalls/D-0417-2026/messages"]) expect((await call("m.diaz", "GET", u)).statusCode, u).toBe(403);
    expect((await call("m.diaz", "GET", "/api/rx")).statusCode).toBe(200);
  });
});

describe("REV-API inferred serials at fill", () => {
  it("a scan with no serial is marked inferred and the response never claims it was scanned", async () => {
    const { call } = await rig();
    const r = await call("k.patel", "POST", "/api/rx/0072214/scan", { raw: buildGs1("70004-803-90", "AT24K118", "2028-01-31", "").replace(/21$/, "") });
    if (r.statusCode !== 200) { const t = await call("k.patel", "POST", "/api/rx/0072214/scan", { fields: { ndc: "70004-803-90", lot: "AT24K118", expiry: "2028-01-31" }, source: "typed" }); expect(t.statusCode).toBe(200); expect(t.json().inferredSerial).toBe(true); return; }
    expect(r.json().inferredSerial).toBe(true);
  });
});

describe("REV-API agent API key handling", () => {
  it("a pasted key never appears in a response, a table (ai_runs, audit) or a request log line", async () => {
    const { call, db } = await rig();
    const KEY = "sk-review-0123456789abcdefSECRET";
    const lines: LogLine[] = []; const restore = setRequestLogSink((l) => lines.push(l));
    const bodies: string[] = [];
    const set = await call("j.rivera", "POST", "/api/agents/provider", { provider: "openai-compatible", model: "gpt-x", apiKey: KEY, baseUrl: "http://127.0.0.1:9/v1" });
    expect(set.statusCode).toBe(200);
    expect(set.json().provider.keyHint).toBeTruthy();
    bodies.push(set.body);
    bodies.push((await call("j.rivera", "POST", "/api/agents/provider/test")).body);
    bodies.push((await call("j.rivera", "POST", "/api/agents/coroner/run", { useSample: true })).body);
    for (const u of ["/api/agents", "/api/agents/provider", "/api/agents/runs", "/api/agents/coroner", "/api/audit"]) bodies.push((await call("j.rivera", "GET", u)).body);
    await call("s.grant", "GET", "/api/audit/export").then((r) => bodies.push(r.body));
    restore();
    for (const b of bodies) expect(b).not.toContain(KEY.slice(3, 20));
    for (const t of db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
      for (const r of db.all<Record<string, unknown>>(`SELECT * FROM ${t.name}`)) expect(JSON.stringify(r), t.name).not.toContain(KEY.slice(3, 20));
    }
    expect(JSON.stringify(lines)).not.toContain(KEY.slice(3, 20));
    await call("j.rivera", "POST", "/api/agents/provider", { provider: "mock" });
  });
});
