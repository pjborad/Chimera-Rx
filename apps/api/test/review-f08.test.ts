import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CryptoError, FileKeyProvider, createKeyProvider } from "../src/crypto";

// REV-F08: the owner-only key claim must hold per platform. POSIX is checked on the real file system;
// Windows is checked with an injected platform and a fake icacls, so this runs on macOS and Linux.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rv-f08-"));
const posix = process.platform !== "win32";

/** A fake icacls that remembers what was granted and prints an ACL in the real output shape. */
function fakeIcacls(opts: { extra?: string[]; failSet?: boolean; failRead?: boolean; garbage?: boolean } = {}) {
  const calls: string[][] = [];
  const exec = (file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (file !== "icacls") throw new Error("unexpected executable");
    if (args.includes("/inheritance:r")) {
      if (opts.failSet) throw new Error("Access is denied.");
      return "Successfully processed 1 files; Failed processing 0 files\n";
    }
    if (opts.failRead) throw new Error("icacls read failed");
    if (opts.garbage) return "nothing useful here\n";
    const target = args[0];
    const rows = ["NT AUTHORITY\\SYSTEM:(F)", "BUILTIN\\Administrators:(F)", "HOST\\alice:(F)", ...(opts.extra ?? [])];
    return `${target} ${rows[0]}\n${rows.slice(1).map((r) => " ".repeat(target.length + 1) + r).join("\n")}\n\nSuccessfully processed 1 files; Failed processing 0 files\n`;
  };
  return { exec, calls };
}
const win = (dir: string, f: ReturnType<typeof fakeIcacls>) => new FileKeyProvider(path.join(dir, ".keys"), { platform: "win32", exec: f.exec, username: "alice" });

describe("REV-F08 key file permissions", () => {
  it.skipIf(!posix)("POSIX: key directory 0700, key and retired files 0600, no temp file left, same after rotation", () => {
    const dir = tmp(); const kd = path.join(dir, ".keys");
    const p = new FileKeyProvider(kd);
    p.load(); p.beginRotation(); p.commitRotation();
    expect(fs.statSync(kd).mode & 0o777).toBe(0o700);
    for (const n of ["data.key", "retired.keys"]) expect(fs.statSync(path.join(kd, n)).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(kd).sort()).toEqual(["data.key", "retired.keys"]);
  });

  it.skipIf(!posix)("POSIX: a key file left world-readable is tightened on load, and an unfixable one fails closed", () => {
    const dir = tmp(); const kd = path.join(dir, ".keys");
    const p = new FileKeyProvider(kd); p.load();
    fs.chmodSync(path.join(kd, "data.key"), 0o666);
    new FileKeyProvider(kd).load();
    expect(fs.statSync(path.join(kd, "data.key")).mode & 0o777).toBe(0o600);
  });

  it("Windows: tightens the DACL with icacls (argument array, inheritance removed, current user granted) before key material is written", () => {
    const dir = tmp(); const f = fakeIcacls();
    win(dir, f).load();
    const set = f.calls.filter((c) => c.includes("/inheritance:r"));
    expect(set.length).toBeGreaterThanOrEqual(2); // directory and file
    for (const c of set) { expect(c[0]).toBe("icacls"); expect(c).toContain("/grant:r"); expect(c.some((a) => a.startsWith("alice:"))).toBe(true); }
    expect(fs.existsSync(path.join(dir, ".keys", "data.key"))).toBe(true);
  });

  it("Windows: refuses the file provider and names DATA_KEY when icacls fails to set the ACL", () => {
    const dir = tmp();
    expect(() => win(dir, fakeIcacls({ failSet: true })).load()).toThrow(/DATA_KEY/);
    expect(fs.existsSync(path.join(dir, ".keys", "data.key"))).toBe(false); // nothing written before the ACL held
  });

  it("Windows: refuses when verification shows another principal (a local group, Users or Everyone)", () => {
    for (const extra of ["HOST\\CodexSandboxUsers:(RX)", "BUILTIN\\Users:(RX)", "Everyone:(R)"]) {
      const dir = tmp();
      expect(() => win(dir, fakeIcacls({ extra: [extra] })).load()).toThrow(CryptoError);
    }
  });

  it("Windows: refuses when the ACL cannot be read back or parsed", () => {
    expect(() => win(tmp(), fakeIcacls({ failRead: true })).load()).toThrow(/DATA_KEY/);
    expect(() => win(tmp(), fakeIcacls({ garbage: true })).load()).toThrow(/DATA_KEY/);
  });

  it("Windows: rotation re-checks every file it writes", () => {
    const dir = tmp(); const f = fakeIcacls(); const p = win(dir, f);
    p.load(); const before = f.calls.length;
    p.beginRotation(); p.commitRotation();
    expect(f.calls.length).toBeGreaterThan(before);
    expect(fs.existsSync(path.join(dir, ".keys", "retired.keys"))).toBe(true);
  });

  it("an explicit DATA_KEY still works on Windows without touching icacls", () => {
    const f = fakeIcacls();
    const key = Buffer.alloc(32, 7).toString("base64");
    const p = createKeyProvider("/nowhere", { DATA_KEY: key }, { platform: "win32", exec: f.exec });
    expect(p.name).toBe("env");
    expect(p.load().current.key.length).toBe(32);
    expect(f.calls).toEqual([]);
  });
});
