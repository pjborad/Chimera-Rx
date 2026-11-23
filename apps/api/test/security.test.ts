import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp, ingestFaxInbox, loadConfig, SandboxNotifier, seedDatabase, type Ctx } from "../src/index";
import { CryptoError, EnvKeyProvider, FieldCipher, FileKeyProvider, KmsKeyProvider, createKeyProvider, isEnvelope, keyIdOf, ringOf } from "../src/crypto";
import { keyStatus, rotateKeys } from "../src/keyadmin";
import { PROTECTED, rewriteProtected } from "../src/protect";
import { generateHistory } from "../src/dataset";
import { seedStore2 } from "../src/seed-store2";
import { setRequestLogSink, type LogLine } from "../src/security";
import { createStores, STORE_1, STORE_2 } from "../src/stores";
import { Db } from "../src/db";

// SEC-1 encryption at rest and SEC-2 API hardening. Synthetic data only.

const PW = "moonlight-rx-2026";
const key = () => crypto.randomBytes(32);

describe("SEC-1 field cipher", () => {
  const cipher = new FieldCipher(ringOf(key()));

  it("property: any string survives seal then open, and the envelope has the v1 shape", () => {
    fc.assert(fc.property(fc.string({ unit: "binary" }), (s) => {
      const e = cipher.seal(s);
      expect(e).toMatch(/^enc:v1:[0-9a-f]{8}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]*$/);
      expect(isEnvelope(e)).toBe(true);
      expect(cipher.open(e)).toBe(s);
    }), { numRuns: 300 });
  });

  it("uses a fresh random IV for every value, so equal inputs give different ciphertext", () => {
    const seen = new Set(Array.from({ length: 200 }, () => cipher.seal("Maria Alvarez")));
    expect(seen.size).toBe(200);
  });

  it("detects tampering in the IV, tag or ciphertext, and rejects malformed envelopes", () => {
    const e = cipher.seal("(555) 010-0142");
    const parts = e.split(":");
    for (const i of [3, 4, 5]) {
      const p = [...parts];
      const c = p[i]![0] === "A" ? "B" : "A";
      p[i] = c + p[i]!.slice(1);
      expect(() => cipher.open(p.join(":"))).toThrow(CryptoError);
    }
    expect(() => cipher.open("enc:v1:garbage")).toThrow(/valid encrypted value/);
    expect(() => cipher.open("(555) 010-0142")).toThrow(CryptoError);
  });

  it("refuses a wrong key: unknown key id, and a forged id that points at another key", () => {
    const other = new FieldCipher(ringOf(key()));
    const e = cipher.seal("x");
    expect(() => other.open(e)).toThrowError(expect.objectContaining({ code: "unknown_key" }));
    const forged = e.replace(/^enc:v1:[0-9a-f]{8}/, `enc:v1:${other.currentKeyId}`);
    expect(() => other.open(forged)).toThrowError(expect.objectContaining({ code: "auth_failed" }));
  });

  it("a ring with the old key still opens old rows after the current key changes", () => {
    const k1 = key(), k2 = key();
    const old = new FieldCipher(ringOf(k1)).seal("allergy: penicillin");
    const next = new FieldCipher(ringOf(k2, [k1]));
    expect(next.open(old)).toBe("allergy: penicillin");
    expect(next.seal("y")).toContain(keyIdOf(k2));
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => new EnvKeyProvider({ DATA_KEY: Buffer.alloc(16).toString("base64") }).load()).toThrow(/32 bytes/);
    expect(() => new EnvKeyProvider({}).load()).toThrow(/DATA_KEY is not set/);
  });

  it("the KMS provider is a placeholder that says so, and an unknown provider name is refused", () => {
    expect(() => new KmsKeyProvider().load()).toThrow(/AWS KMS key provider is not configured/);
    expect(() => createKeyProvider("/tmp/x", { KEY_PROVIDER: "kms" }).load()).toThrow(/not configured/);
    expect(() => createKeyProvider("/tmp/x", { KEY_PROVIDER: "vault" })).toThrow(/Unknown KEY_PROVIDER/);
  });

  it("the file provider creates data.key with mode 0600 and survives a reload", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crx-keys-"));
    const a = new FileKeyProvider(path.join(dir, ".keys")).load();
    const f = path.join(dir, ".keys", "data.key");
    if (process.platform !== "win32") expect(fs.statSync(f).mode & 0o777).toBe(0o600); // chmod has no effect on Windows; see review-f08.test.ts
    expect(new FileKeyProvider(path.join(dir, ".keys")).load().current.id).toBe(a.current.id);
  });
});

describe("SEC-1 protected columns", () => {
  it("seals bound parameters and string literals on protected columns, leaves other columns alone, and fails closed on odd shapes", () => {
    const seal = (s: string) => `<${s}>`;
    expect(rewriteProtected("INSERT INTO patients (id, name, dob) VALUES (?,?,?)", seal)).toEqual({ sql: "INSERT INTO patients (id, name, dob) VALUES (?, ?, ?)", idx: [1, 2] });
    expect(rewriteProtected("INSERT INTO med_history (patient_id, sig, qty) VALUES ('S-1',?,?)", seal).idx).toEqual([0]);
    expect(rewriteProtected("UPDATE patients SET sms_opt_out = 1, phone = ? WHERE id = ?", seal).idx).toEqual([0]);
    expect(rewriteProtected("UPDATE patients SET email = 'a''b@example.com' WHERE id = 'S-1'", seal).sql).toContain("<a'b@example.com>");
    expect(rewriteProtected("UPDATE users SET failed = ? WHERE id = ?", seal)).toEqual({ sql: "UPDATE users SET failed = ? WHERE id = ?", idx: [] });
    expect(() => rewriteProtected("UPDATE patients SET name = upper(name) WHERE id = ?", seal)).toThrow(/bound parameter/);
    expect(() => rewriteProtected("INSERT INTO patients (id, name) SELECT id, name FROM patients", seal)).toThrow();
  });

  it("every protected table and column exists in the schema", () => {
    const db = new Db(":memory:");
    for (const [t, cols] of Object.entries(PROTECTED)) {
      const have = (db.raw.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
      for (const c of cols) expect(have, `${t}.${c}`).toContain(c);
    }
  });
});

describe("SEC-1 database files hold no plaintext PHI", () => {
  let dir: string;
  let ctx: Ctx;
  let app: FastifyInstance;
  let reg: ReturnType<typeof createStores>["reg"];
  const secrets: string[] = [];
  const cookies: Record<string, string> = {};
  const call = (method: "GET" | "POST", url: string, payload?: unknown) => app.inject({ method, url, payload: payload as never, headers: { cookie: cookies.j! } });

  beforeAll(async () => {
    process.env.OFFLINE = "1";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crx-sec-"));
    const cfg = loadConfig({}, { dataDir: dir, sqlitePath: path.join(dir, "chimera-rx.sqlite"), sandboxDelayMs: 20, today: "2026-11-18", nightWatch: false, assetsDir: "/nonexistent", webDist: "/nonexistent" });
    const s = createStores(cfg);
    reg = s.reg;
    const now = Date.parse("2026-11-18T18:00:00Z");
    seedDatabase(reg.db(STORE_1), cfg, now);
    seedStore2(reg.db(STORE_2), now);
    generateHistory(reg.db(STORE_1), { seed: 3, patients: 40, fills: 200, products: 12 });
    ctx = { cfg, db: s.db, stores: reg, notify: new SandboxNotifier(s.db, cfg), now: () => now };
    await reg.each(() => ingestFaxInbox(ctx));
    app = await buildApp(ctx);
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { storeId: STORE_1, email: "j.rivera@elmstreetrx.example", password: PW, trusted: true } });
    expect(r.statusCode).toBe(200);
    cookies.j = r.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    // collect the synthetic plaintext from the decrypted view
    for (const id of reg.ids) for (const p of reg.db(id).all<any>("SELECT name, dob, phone, email, allergies, conditions FROM patients")) {
      for (const v of [p.name, p.dob, p.phone, p.email, p.allergies, p.conditions]) if (v && String(v).length >= 5) secrets.push(String(v));
    }
    for (const id of reg.ids) for (const o of reg.db(id).all<any>("SELECT directions FROM prescriptions WHERE length(directions) > 12")) secrets.push(o.directions);
  }, 60_000);
  afterAll(() => { for (const id of reg.ids) reg.db(id).raw.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const bytesOf = (id: string) => {
    reg.db(id).raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const f = id === STORE_1 ? ctx.cfg.sqlitePath : path.join(dir, `chimera-rx-${id}.sqlite`);
    return [f, `${f}-wal`].filter((x) => fs.existsSync(x)).map((x) => fs.readFileSync(x));
  };

  it("the raw sqlite files of both stores contain no synthetic name, phone, email, date of birth, allergy or directions", () => {
    expect(secrets.length).toBeGreaterThan(100);
    expect(secrets).toContain("(555) 010-0142");
    for (const id of reg.ids) {
      const files = bytesOf(id);
      expect(files[0]!.length).toBeGreaterThan(50_000);
      const miss = secrets.filter((s) => files.some((b) => b.includes(Buffer.from(s, "utf8"))));
      expect(miss, `plaintext found in ${id}`).toEqual([]);
      expect(files.some((b) => b.includes(Buffer.from("enc:v1:")))).toBe(true);
    }
  });

  it("the key is not in the database files, and the key file is mode 0600", () => {
    const k = fs.readFileSync(path.join(dir, ".keys", "data.key"), "utf8").trim();
    for (const id of reg.ids) for (const b of bytesOf(id)) expect(b.includes(Buffer.from(k))).toBe(false);
    if (process.platform !== "win32") expect(fs.statSync(path.join(dir, ".keys", "data.key")).mode & 0o777).toBe(0o600);
  });

  it("routes keep working: name, phone and date-of-birth search return decrypted values", async () => {
    const byName = (await call("GET", "/api/patients?q=brooks")).json();
    expect(byName.matches.map((m: any) => m.id)).toContain("S-0612");
    expect(byName.matches[0].name).not.toMatch(/^enc:/);
    const byPhone = (await call("GET", "/api/patients?q=0142")).json();
    expect(byPhone.matches.length).toBeGreaterThan(0);
    const dob = byName.matches.find((m: any) => m.id === "S-0612").dob;
    expect(dob).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const [y, m, d] = dob.split("-");
    expect((await call("GET", `/api/patients?q=${m}/${d}/${y}`)).json().matches.map((x: any) => x.id)).toContain("S-0612");
    const profile = (await call("GET", "/api/patients/S-0612?reason=refill%20question")).json();
    expect(profile.patient.allergies).toContain("penicillin");
    expect(profile.patient.phone).toBe("(555) 010-0142");
  });

  it("STOP replies find the patient by phone through the encrypted column", async () => {
    const r = await call("POST", "/api/sms/inbound", { from: "555-010-0142", body: "STOP" });
    expect(r.json()).toMatchObject({ handled: true, patient: "S-0612" });
  });

  it("the audit chain verifies, holds ids only, and records PHI views", async () => {
    await call("GET", "/api/rx/0072210");
    const v = (await call("GET", "/api/audit/verify")).json();
    expect(v).toMatchObject({ ok: true, brokenAt: null });
    expect(v.rows).toBeGreaterThan(3);
    const rows = reg.db(STORE_1).all<any>("SELECT * FROM audit");
    expect(rows.some((r) => r.action === "patient.view" && r.entity_id === "S-0612")).toBe(true);
    expect(rows.some((r) => r.action === "phi.view")).toBe(true);
    const blob = JSON.stringify(rows);
    for (const s of secrets.filter((x) => x.length >= 8 && !x.startsWith("Use as"))) expect(blob.includes(s), s).toBe(false);
    // the free-text reason is encrypted in the file
    const raw = reg.db(STORE_1).raw.prepare("SELECT reason FROM audit WHERE action = 'patient.view' AND reason IS NOT NULL").get() as { reason: string };
    expect(raw.reason.startsWith("enc:v1:")).toBe(true);
  });

  it("keys:status counts values per key and prints no values", () => {
    const s = keyStatus(reg.db(STORE_1));
    expect(s.plaintext).toBe(0);
    expect(s.unreadable).toBe(0);
    expect(Object.keys(s.perKey)).toEqual([s.currentKeyId]);
    expect(JSON.stringify(s)).not.toMatch(/Brooks|555/);
  });

  it("rotation re-encrypts every protected value under a new key, keeps every row readable, and audits the event", async () => {
    const before = reg.db(STORE_1).all<any>("SELECT id, name, phone, allergies FROM patients ORDER BY id");
    const oldId = reg.db(STORE_1).cipher.currentKeyId;
    const r = rotateKeys(reg.ids.map((i) => reg.db(i)), { actorName: "test" });
    expect(r.fromKeyId).toBe(oldId);
    expect(r.toKeyId).not.toBe(oldId);
    expect(r.rotated).toBeGreaterThan(500);
    for (const id of reg.ids) {
      const s = keyStatus(reg.db(id));
      expect(s.perKey).toEqual({ [r.toKeyId]: expect.any(Number) });
      expect(s.plaintext).toBe(0);
    }
    expect(reg.db(STORE_1).all("SELECT id, name, phone, allergies FROM patients ORDER BY id")).toEqual(before);
    expect(fs.readFileSync(path.join(dir, ".keys", "data.key"), "utf8").trim()).not.toBe("");
    expect(keyIdOf(Buffer.from(fs.readFileSync(path.join(dir, ".keys", "data.key"), "utf8").trim(), "base64"))).toBe(r.toKeyId);
    expect(fs.readFileSync(path.join(dir, ".keys", "retired.keys"), "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(2);
    expect(reg.db(STORE_1).get("SELECT 1 FROM audit WHERE action = 'keys.rotate'")).toBeTruthy();
    expect((await call("GET", "/api/audit/verify")).json().ok).toBe(true);
    // a fresh process (new cipher from the key files) reads the rotated rows
    const reopened = new Db(ctx.cfg.sqlitePath);
    expect(reopened.get<any>("SELECT name FROM patients WHERE id = 'S-0612'")!.name).toBe(before.find((p) => p.id === "S-0612")!.name);
    reopened.raw.close();
    // the files still hold no plaintext afterwards
    for (const id of reg.ids) {
      const files = bytesOf(id);
      expect(secrets.filter((s) => files.some((b) => b.includes(Buffer.from(s))))).toEqual([]);
    }
  });

  it("a rotation that fails part way rolls that database back whole and leaves every row readable", () => {
    const db = reg.db(STORE_2);
    const before = db.all("SELECT id, name, phone FROM patients ORDER BY id");
    const idsBefore = keyStatus(db).perKey;
    const realSeal = db.cipher.seal.bind(db.cipher);
    let n = 0;
    (db.cipher as any).seal = (...a: Parameters<typeof realSeal>) => { if (++n > 20) throw new Error("disk full"); return realSeal(...a); };
    expect(() => rotateKeys([db])).toThrow(/disk full/);
    (db.cipher as any).seal = realSeal;
    expect(keyStatus(db).perKey).toEqual(idsBefore);
    expect(db.all("SELECT id, name, phone FROM patients ORDER BY id")).toEqual(before);
    expect(keyStatus(db).unreadable).toBe(0);
    // writes still seal under the old current key
    db.run("UPDATE patients SET phone = ? WHERE id = 'S-2001'", "(555) 010-0199");
    expect(db.get<any>("SELECT phone FROM patients WHERE id = 'S-2001'")!.phone).toBe("(555) 010-0199");
  });

  it("an envelope that fails authentication is never turned into plaintext and is counted", () => {
    const db = reg.db(STORE_2);
    const raw = db.raw.prepare("SELECT name FROM patients WHERE id = 'S-2001'").get() as { name: string };
    const bad = raw.name.slice(0, -2) + (raw.name.endsWith("AA") ? "BB" : "AA");
    db.raw.prepare("UPDATE patients SET name = ? WHERE id = 'S-2001'").run(bad);
    const failures = db.cipher.failures;
    const got = db.get<any>("SELECT name FROM patients WHERE id = 'S-2001'")!.name;
    expect(got).toBe(bad);
    expect(db.cipher.failures).toBe(failures + 1);
    db.raw.prepare("UPDATE patients SET name = ? WHERE id = 'S-2001'").run(raw.name);
  });
});

describe("SEC-1 existing plaintext is encrypted when an older database opens", () => {
  it("encrypts leftover plaintext once on open", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crx-mig-"));
    const f = path.join(dir, "old.sqlite");
    const a = new Db(f);
    a.raw.exec("INSERT INTO patients (id, name, dob, phone, email, preferred) VALUES ('S-9', 'Legacy Person', '1960-01-02', '(555) 010-0999', 'l@example.com', 'sms')");
    a.raw.close();
    const b = new Db(f);
    expect(b.get<any>("SELECT name, phone FROM patients WHERE id = 'S-9'")).toMatchObject({ name: "Legacy Person", phone: "(555) 010-0999" });
    expect((b.raw.prepare("SELECT name FROM patients WHERE id = 'S-9'").get() as any).name).toMatch(/^enc:v1:/);
    expect(keyStatus(b).plaintext).toBe(0);
    b.raw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------------------------------------------ SEC-2

describe("SEC-2 API hardening", () => {
  let nowMs = Date.parse("2026-11-18T18:00:00Z");
  let app: FastifyInstance;
  let ctx: Ctx;
  const logs: LogLine[] = [];
  let restore: () => void;

  beforeAll(async () => {
    process.env.OFFLINE = "1";
    restore = setRequestLogSink((l) => logs.push(l));
    const cfg = loadConfig({}, { sqlitePath: ":memory:", sandboxDelayMs: 20, today: "2026-11-18", nightWatch: false, assetsDir: "/nonexistent", webDist: "/nonexistent", cookieSecure: true });
    const db = new Db(":memory:");
    ctx = { cfg, db, notify: new SandboxNotifier(db, cfg), now: () => nowMs };
    seedDatabase(db, cfg, nowMs);
    await ingestFaxInbox(ctx);
    app = await buildApp(ctx);
  }, 60_000);
  afterAll(() => restore());

  const login = (email: string, password: string, ip = "10.0.0.1") =>
    app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: ip, payload: { storeId: "store-7", email, password, trusted: false } });
  const J = "j.rivera@elmstreetrx.example";

  it("sends the security headers on API, health and error responses", async () => {
    for (const r of [await app.inject({ method: "GET", url: "/api/health" }), await app.inject({ method: "GET", url: "/api/me" }), await app.inject({ method: "GET", url: "/nope" })]) {
      const csp = String(r.headers["content-security-policy"]);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).not.toContain("'unsafe-eval'");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["referrer-policy"]).toBe("no-referrer");
      expect(r.headers["permissions-policy"]).toContain("camera=(self)");
      expect(r.headers["permissions-policy"]).toContain("microphone=()");
      expect(r.headers["x-frame-options"]).toBe("DENY");
      expect(r.headers["strict-transport-security"]).toBeTruthy(); // cookieSecure is on in this app
    }
    expect((await app.inject({ method: "GET", url: "/api/health" })).headers["cache-control"]).toBe("no-store");
  });

  it("sets the session cookie HttpOnly, SameSite=Lax and Secure (when COOKIE_SECURE is on)", async () => {
    const r = await login(J, PW, "10.0.0.50");
    expect(r.statusCode).toBe(200);
    const c = String(r.headers["set-cookie"]);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Lax/i);
    expect(c).toMatch(/Secure/i);
  });

  it("closes a session after the idle timeout and keeps one that stays active", async () => {
    const r = await login(J, PW, "10.0.0.51");
    const cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const me = () => app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect((await me()).statusCode).toBe(200);
    nowMs += 20 * 60_000;
    expect((await me()).statusCode).toBe(200);
    nowMs += 20 * 60_000; // 20 minutes since the last request: still fine
    expect((await me()).statusCode).toBe(200);
    nowMs += 31 * 60_000;
    const gone = await me();
    expect(gone.statusCode).toBe(401);
    expect(ctx.db.get("SELECT 1 FROM sessions WHERE token = ?", cookie.split("=")[1]!.split(";")[0])).toBeUndefined();
  });

  it("throttles sign-in per IP: 20 failures from one address, across different accounts, then 429 with Retry-After", async () => {
    for (let i = 0; i < 20; i++) expect((await login(`nobody${i}@example.com`, "wrong", "10.9.9.9")).statusCode).toBe(401);
    const blocked = await login(J, PW, "10.9.9.9");
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.json().code).toBe("rate_limited");
    // another address is unaffected, and the block lifts once the window passes
    expect((await login(J, PW, "10.9.9.10")).statusCode).toBe(200);
    nowMs += 16 * 60_000;
    expect((await login(J, PW, "10.9.9.9")).statusCode).toBe(200);
  });

  it("throttles sign-in per account, including accounts that do not exist, and locks a real account after 5 wrong passwords", async () => {
    for (let i = 0; i < 10; i++) expect((await login("ghost@example.com", "x", `10.1.1.${i}`)).statusCode).toBe(401);
    expect((await login("ghost@example.com", "x", "10.1.1.99")).statusCode).toBe(429);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await login("m.diaz@elmstreetrx.example", "wrong", `10.2.2.${i}`)).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 423, 423]);
    expect((await login("m.diaz@elmstreetrx.example", PW, "10.2.2.77")).statusCode).toBe(423);
  });

  it("refuses a state-changing request that names a foreign Origin, and allows the same origin", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: "https://evil.example" }, payload: { storeId: "store-7", email: J, password: PW } });
    expect(bad.statusCode).toBe(403);
    const same = await app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "10.3.3.3", headers: { origin: "http://api.local:8080", host: "api.local:8080" }, payload: { storeId: "store-7", email: J, password: PW } });
    expect(same.statusCode).toBe(200);
    const pre = await app.inject({ method: "OPTIONS", url: "/api/me", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects bad bodies with 422 and never echoes what was sent", async () => {
    const r = await login(J, PW, "10.4.4.4");
    const cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const echoes = ["Maria Alvarez 1960-01-02", "(555) 010-0142"];
    const enumBad = await app.inject({ method: "POST", url: "/api/packages/1/problem", headers: { cookie }, payload: { kind: echoes[0], note: echoes[1] } });
    expect(enumBad.statusCode).toBe(422);
    expect(enumBad.body).not.toContain("Maria");
    expect(enumBad.body).not.toContain("555");
    const badJson = await app.inject({ method: "POST", url: "/api/ocr/parse", headers: { cookie, "content-type": "application/json" }, payload: `{"text": "Maria Alvarez ` });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.body).not.toContain("Maria");
    const wrongType = await app.inject({ method: "POST", url: "/api/ocr/parse", headers: { cookie }, payload: { text: 42 } });
    expect(wrongType.statusCode).toBe(422);
    const huge = await app.inject({ method: "POST", url: "/api/ocr/parse", headers: { cookie }, payload: { text: "x".repeat(20001) } });
    expect(huge.statusCode).toBe(422);
    const extra = await app.inject({ method: "POST", url: "/api/recalls/D-0417-2026/close", headers: { cookie }, payload: { patient: "Maria Alvarez" } });
    expect(extra.statusCode).toBe(422);
    expect(extra.body).not.toContain("Maria");
  });

  it("turns an unexpected server error into a generic 500 without the internal message", async () => {
    const r = await login(J, PW, "10.4.4.5");
    const cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const orig = ctx.db.all.bind(ctx.db);
    (ctx.db as any).all = (sql: string, ...p: unknown[]) => { if (/FROM patients/.test(sql)) throw new Error("boom: Maria Alvarez (555) 010-0142"); return orig(sql, ...p); };
    const res = await app.inject({ method: "GET", url: "/api/patients?q=maria", headers: { cookie } });
    (ctx.db as any).all = orig;
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("Maria");
    expect(res.json()).toEqual({ error: "Something went wrong." });
  });

  it("request logs carry the route pattern, status and ids, and no query text, names, phones or passwords", async () => {
    logs.length = 0;
    const r = await login(J, "wrong-password-xyz", "10.5.5.5");
    expect(r.statusCode).toBe(401);
    const ok = await login(J, PW, "10.5.5.6");
    const cookie = ok.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    await app.inject({ method: "GET", url: "/api/patients?q=Brooks%20(555)%20010-0142", headers: { cookie } });
    await app.inject({ method: "GET", url: "/api/patients/S-0612?reason=refill%20for%20Brooks", headers: { cookie } });
    const text = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThanOrEqual(4);
    for (const bad of ["Brooks", "555", "wrong-password", PW, "S-0612", "refill", "q="]) expect(text, bad).not.toContain(bad);
    expect(logs.map((l) => l.route)).toContain("/api/patients/:id");
    expect(logs.find((l) => l.route === "/api/patients")).toMatchObject({ method: "GET", status: 200, actor: "u-rivera" });
  });

  it("role checks stay on the server: a technician cannot read the audit log or open recall lookups", async () => {
    const r = await login("k.patel@elmstreetrx.example", PW, "10.6.6.6");
    const cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    expect((await app.inject({ method: "GET", url: "/api/audit", headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/recalls/lookup", headers: { cookie }, payload: { number: "D-1" } })).statusCode).toBe(403);
  });
});
