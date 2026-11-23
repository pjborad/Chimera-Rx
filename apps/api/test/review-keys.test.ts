import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../src/db";
import { audit, verifyAuditChain, type Ctx } from "../src/core";
import { resetCipherCache } from "../src/crypto";
import { keyStatus, rotateKeys } from "../src/keyadmin";

// REV-API: key file creation, fail-closed on a wrong or lost key, rotation and the audit chain across a reopen.

const saved = { DATA_KEY: process.env.DATA_KEY, KEY_PROVIDER: process.env.KEY_PROVIDER, NEW: process.env.NEW_DATA_KEY };
afterEach(() => { for (const [k, v] of [["DATA_KEY", saved.DATA_KEY], ["KEY_PROVIDER", saved.KEY_PROVIDER], ["NEW_DATA_KEY", saved.NEW]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } resetCipherCache(); delete process.env.ALLOW_UNREADABLE_KEYS; });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rv-key-"));
const ctxOf = (db: Db): Ctx => ({ db, now: () => Date.parse("2026-11-18T18:00:00Z") } as unknown as Ctx);
const addPatient = (db: Db) => db.run("INSERT INTO patients (id, name, phone) VALUES (?,?,?)", "S-9001", "Test Person", "(555) 010-0199");

describe("REV-API keys", () => {
  it("creates data.key with mode 0600 when no key is configured, and the raw file holds no name", () => {
    delete process.env.DATA_KEY; delete process.env.KEY_PROVIDER; resetCipherCache();
    const dir = tmp(); const f = path.join(dir, "x.sqlite");
    const db = new Db(f); addPatient(db); db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const kf = path.join(dir, ".keys", "data.key");
    if (process.platform !== "win32") expect(fs.statSync(kf).mode & 0o777).toBe(0o600);
    if (process.platform !== "win32") expect(fs.statSync(path.join(dir, ".keys")).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(f).toString("latin1")).not.toContain("Test Person");
  });

  it("refuses to open a database sealed with another key (wrong DATA_KEY), and with a lost key file", () => {
    process.env.DATA_KEY = crypto.randomBytes(32).toString("base64"); resetCipherCache();
    const dir = tmp(); const f = path.join(dir, "x.sqlite");
    const db = new Db(f); addPatient(db); db.raw.close();
    process.env.DATA_KEY = crypto.randomBytes(32).toString("base64"); resetCipherCache();
    expect(() => new Db(f)).toThrow(/does not have/);
    // lost key file: a fresh key would be generated; the database must still refuse
    delete process.env.DATA_KEY; resetCipherCache();
    expect(() => new Db(f)).toThrow(/does not have/);
    // the key-status CLI may look at it
    process.env.ALLOW_UNREADABLE_KEYS = "1"; resetCipherCache();
    const look = new Db(f);
    expect(keyStatus(look).unreadable).toBeGreaterThan(0);
  });

  it("rotation with the server stopped keeps the audit chain valid, in this process and after a reopen", () => {
    delete process.env.DATA_KEY; delete process.env.KEY_PROVIDER; resetCipherCache();
    const dir = tmp(); const f = path.join(dir, "x.sqlite");
    const db = new Db(f); const ctx = ctxOf(db);
    addPatient(db);
    audit(ctx, { id: "u", name: "J", role: "pharmacist", storeId: "store-7", workstation: "w" }, "phi.view", "patient", "S-9001", undefined, { a: 1 }, "reason with S-9001");
    audit(ctx, null, "x.y", "patient", "S-9001", undefined, undefined, "second reason");
    const before = keyStatus(db).currentKeyId;
    const r = rotateKeys([db]);
    expect(r.rotated).toBeGreaterThan(0);
    expect(keyStatus(db)).toMatchObject({ plaintext: 0, unreadable: 0 });
    expect(keyStatus(db).currentKeyId).not.toBe(before);
    expect(verifyAuditChain(ctx)).toMatchObject({ ok: true, brokenAt: null });
    db.raw.close(); resetCipherCache();
    const again = new Db(f);
    expect(again.get<any>("SELECT name FROM patients WHERE id = 'S-9001'")!.name).toBe("Test Person");
    expect(verifyAuditChain(ctxOf(again))).toMatchObject({ ok: true });
    expect(keyStatus(again).perKey).toHaveProperty(r.toKeyId);
  });
});
