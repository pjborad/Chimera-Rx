import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Field encryption for patient data at rest (SEC-1). AES-256-GCM with a random 12-byte IV per value.
 * Envelope: `enc:v1:<keyId>:<iv>:<tag>:<ciphertext>` (base64url parts). The key id is a short hash of the key, so a
 * key ring can hold old keys and any row still decrypts after a rotation. Keys are never logged or returned.
 */

export const ENVELOPE_PREFIX = "enc:v1:";
const ENVELOPE_RE = /^enc:v1:([0-9a-f]{8}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]*)$/;
const AAD = Buffer.from("chimera-rx:field:v1");

export class CryptoError extends Error {
  constructor(readonly code: "bad_key" | "bad_envelope" | "unknown_key" | "auth_failed" | "not_configured", message: string) { super(message); }
}

export const keyIdOf = (key: Buffer) => crypto.createHash("sha256").update("chimera-rx:kid:").update(key).digest("hex").slice(0, 8);

export function parseKey(b64: string): Buffer {
  const key = Buffer.from(b64.trim(), "base64");
  if (key.length !== 32) throw new CryptoError("bad_key", "A data key must be 32 bytes, base64 encoded (generate one with: openssl rand -base64 32).");
  return key;
}

export interface KeyRing { current: { id: string; key: Buffer }; byId: Map<string, Buffer> }

export function ringOf(current: Buffer, others: Buffer[] = []): KeyRing {
  const byId = new Map<string, Buffer>();
  for (const k of [...others, current]) byId.set(keyIdOf(k), k);
  return { current: { id: keyIdOf(current), key: current }, byId };
}

/** Seals and opens single values. One instance is shared by every database in a data directory. */
export class FieldCipher {
  /** envelopes that failed to open since start (counts only; never the value) */
  failures = 0;
  constructor(private ring: KeyRing) {}
  get currentKeyId() { return this.ring.current.id; }
  setRing(ring: KeyRing) { this.ring = ring; }
  hasKey(id: string) { return this.ring.byId.has(id); }

  seal(plain: string, key: { id: string; key: Buffer } = this.ring.current): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key.key, iv);
    c.setAAD(AAD);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return `${ENVELOPE_PREFIX}${key.id}:${iv.toString("base64url")}:${c.getAuthTag().toString("base64url")}:${ct.toString("base64url")}`;
  }

  /** Throws CryptoError on a malformed envelope, an unknown key id, or a failed authentication tag (tampering, wrong key). */
  open(env: string): string {
    const m = ENVELOPE_RE.exec(env);
    if (!m) throw new CryptoError("bad_envelope", "Not a valid encrypted value.");
    const key = this.ring.byId.get(m[1]!);
    if (!key) throw new CryptoError("unknown_key", `No key with id ${m[1]} in the key ring.`);
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(m[2]!, "base64url"));
      d.setAAD(AAD);
      d.setAuthTag(Buffer.from(m[3]!, "base64url"));
      return Buffer.concat([d.update(Buffer.from(m[4]!, "base64url")), d.final()]).toString("utf8");
    } catch {
      throw new CryptoError("auth_failed", "Encrypted value failed authentication (tampered or wrong key).");
    }
  }

  /** Read path: a value that is not an envelope is returned as is; one that fails to open is returned undecrypted and counted. */
  openLenient(v: string): string {
    if (!v.startsWith(ENVELOPE_PREFIX)) return v;
    try { return this.open(v); } catch { this.failures++; return v; }
  }
}

export const isEnvelope = (v: unknown): v is string => typeof v === "string" && ENVELOPE_RE.test(v);
export const envelopeKeyId = (v: string) => ENVELOPE_RE.exec(v)?.[1];

// ---------------------------------------------------------------------------------------------------- key providers

/**
 * Where the data key comes from. `env` and `file` work today. `kms` is a placeholder that fails loudly until someone
 * wires it (see docs/SECURITY.md). A provider returns the ring; rotation is staged so a crash never loses a key.
 */
export interface KeyProvider {
  readonly name: "env" | "file" | "kms";
  load(): KeyRing;
  /** Make the next key durable and return a ring that holds the old and the new key. Nothing is switched yet. */
  beginRotation(): KeyRing;
  /** Called after every row was re-encrypted: make the new key the current one. Returns a note for the operator. */
  commitRotation(): string;
}

export class EnvKeyProvider implements KeyProvider {
  readonly name = "env" as const;
  private next?: Buffer;
  constructor(private env: Record<string, string | undefined> = process.env) {}
  load(): KeyRing {
    if (!this.env.DATA_KEY) throw new CryptoError("not_configured", "DATA_KEY is not set (base64, 32 bytes).");
    const prev = (this.env.DATA_KEY_PREVIOUS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(parseKey);
    return ringOf(parseKey(this.env.DATA_KEY), prev);
  }
  beginRotation(): KeyRing {
    if (!this.env.NEW_DATA_KEY) throw new CryptoError("not_configured", "Set NEW_DATA_KEY (base64, 32 bytes) to the key you are rotating to.");
    const old = this.load();
    this.next = parseKey(this.env.NEW_DATA_KEY);
    return ringOf(this.next, [...old.byId.values()]);
  }
  commitRotation() {
    return "Rows are re-encrypted. Now set DATA_KEY to the value of NEW_DATA_KEY, add the old DATA_KEY to DATA_KEY_PREVIOUS, unset NEW_DATA_KEY and restart.";
  }
}

export interface FileKeyOptions {
  /** defaults to process.platform; tests inject "win32" or "linux" */
  platform?: NodeJS.Platform;
  /** runs a fixed executable with an argument array (no shell) and returns stdout; defaults to execFileSync. Tests inject a fake. */
  exec?: (file: string, args: string[]) => string;
  /** the account that must own the key files on Windows; defaults to os.userInfo().username */
  username?: string;
}

const WIN_ALLOWED = ["system", "administrators"];

/**
 * A key file at <data>/.keys/data.key. POSIX: directory 0700, files 0600, checked after writing.
 * Windows: chmod does nothing there, so the ACL is tightened with icacls (inheritance removed, current user only) and
 * the result is read back; if that fails the file provider refuses to run and DATA_KEY must be supplied instead.
 * Older keys live in retired.keys so rotated rows stay readable. Neither platform's file mode replaces disk encryption or a KMS.
 */
export class FileKeyProvider implements KeyProvider {
  readonly name = "file" as const;
  private next?: Buffer;
  private platform: NodeJS.Platform;
  private exec: (file: string, args: string[]) => string;
  private user: string;
  constructor(readonly dir: string, opts: FileKeyOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.exec = opts.exec ?? ((file, args) => execFileSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 15000 }));
    this.user = opts.username ?? os.userInfo().username;
  }
  private get keyFile() { return path.join(this.dir, "data.key"); }
  private get retiredFile() { return path.join(this.dir, "retired.keys"); }
  private get win() { return this.platform === "win32"; }

  private refuse(what: string, why: string): never {
    throw new CryptoError("not_configured", `Cannot keep ${what} owner-only (${why}). The file key provider refuses to run here. Supply the key through the environment instead: set DATA_KEY (openssl rand -base64 32) and unset KEY_PROVIDER, or set KEY_PROVIDER=env.`);
  }

  /** Restrict a file or directory to the current user and verify it. Throws instead of continuing with a wider access. */
  private secure(target: string, isDir: boolean) {
    if (!this.win) {
      const want = isDir ? 0o700 : 0o600;
      try { fs.chmodSync(target, want); } catch (e: any) { this.refuse(target, `chmod failed: ${e.code ?? e.message}`); }
      const mode = fs.statSync(target).mode & 0o777;
      if (mode & ~want & 0o777) this.refuse(target, `mode is ${mode.toString(8)}, wider than ${want.toString(8)}`);
      return;
    }
    const grant = `${this.user}:${isDir ? "(OI)(CI)F" : "F"}`;
    try { this.exec("icacls", [target, "/inheritance:r", "/grant:r", grant]); } catch (e: any) { this.refuse(target, `icacls could not set the ACL: ${String(e.message ?? e).split("\n")[0]}`); }
    let out: string;
    try { out = this.exec("icacls", [target]); } catch (e: any) { this.refuse(target, `icacls could not read the ACL back: ${String(e.message ?? e).split("\n")[0]}`); }
    const bad = this.extraPrincipals(out, target);
    if (bad === null) this.refuse(target, "the ACL could not be read");
    if (bad.length) this.refuse(target, `other principals still have access: ${bad.join(", ")}`);
  }

  /** Principals in `icacls` output other than the current user, SYSTEM and Administrators. null = nothing parseable. */
  private extraPrincipals(out: string, target: string): string[] | null {
    const found: string[] = [];
    for (const raw of out.split(/\r?\n/)) {
      let line = raw.trim();
      if (!line || /^successfully processed/i.test(line)) continue;
      const at = line.toLowerCase().indexOf(target.toLowerCase());
      if (at === 0) line = line.slice(target.length).trim();
      const m = /^(.+?):\(/.exec(line);
      if (m) found.push(m[1].trim());
    }
    if (!found.length) return null;
    const me = this.user.toLowerCase();
    return found.filter((p) => {
      const low = p.toLowerCase();
      const last = low.split("\\").pop() as string;
      if (WIN_ALLOWED.includes(last) && (low.startsWith("nt authority\\") || low.startsWith("builtin\\"))) return false;
      return !(low === me || last === me.split("\\").pop());
    });
  }

  private ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.secure(this.dir, true);
  }
  private writeSecret(file: string, content: string, exclusive = false) {
    this.ensureDir();
    const tmp = `${file}.${process.pid}.tmp`;
    try { fs.unlinkSync(tmp); } catch { /* none left over */ }
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      this.secure(tmp, false); // before any key material is written
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } catch (e) { fs.closeSync(fd); try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw e; }
    fs.closeSync(fd);
    if (exclusive) {
      try { fs.linkSync(tmp, file); } catch (e: any) { fs.unlinkSync(tmp); if (e.code === "EEXIST") return; throw e; }
      fs.unlinkSync(tmp);
    } else fs.renameSync(tmp, file);
    this.secure(file, false);
  }
  private retired(): Buffer[] {
    if (!fs.existsSync(this.retiredFile)) return [];
    this.secure(this.retiredFile, false);
    return fs.readFileSync(this.retiredFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean).map(parseKey);
  }
  load(): KeyRing {
    this.ensureDir();
    if (!fs.existsSync(this.keyFile)) this.writeSecret(this.keyFile, crypto.randomBytes(32).toString("base64") + "\n", true);
    this.secure(this.keyFile, false);
    return ringOf(parseKey(fs.readFileSync(this.keyFile, "utf8")), this.retired());
  }
  beginRotation(): KeyRing {
    const old = this.load();
    this.next = crypto.randomBytes(32);
    // Durable first: the new key is on disk (in the retired list) before any row is written with it.
    const all = [...this.retired(), old.current.key, this.next].filter((k, i, a) => a.findIndex((x) => x.equals(k)) === i);
    this.writeSecret(this.retiredFile, all.map((k) => k.toString("base64")).join("\n") + "\n");
    return ringOf(this.next, [...old.byId.values()]);
  }
  commitRotation() {
    if (!this.next) throw new CryptoError("not_configured", "No rotation in progress.");
    this.writeSecret(this.keyFile, this.next.toString("base64") + "\n");
    return `New key written to ${this.keyFile}; the old key stays in ${this.retiredFile} so older backups still open.`;
  }
}

/** Placeholder. Wiring steps are in docs/SECURITY.md ("Wiring AWS KMS"). It never silently falls back to another provider. */
export class KmsKeyProvider implements KeyProvider {
  readonly name = "kms" as const;
  private fail(): never { throw new CryptoError("not_configured", "AWS KMS key provider is not configured in this pilot. Implement KmsKeyProvider.load() (envelope-decrypt the data key with kms:Decrypt) or use KEY_PROVIDER=env or file."); }
  load(): KeyRing { return this.fail(); }
  beginRotation(): KeyRing { return this.fail(); }
  commitRotation(): string { return this.fail(); }
}

export function createKeyProvider(keyDir: string, env: Record<string, string | undefined> = process.env, fileOpts?: FileKeyOptions): KeyProvider {
  const want = env.KEY_PROVIDER || (env.DATA_KEY ? "env" : "file");
  if (want === "env") return new EnvKeyProvider(env);
  if (want === "kms") return new KmsKeyProvider();
  if (want === "file") return new FileKeyProvider(keyDir, fileOpts);
  throw new CryptoError("not_configured", `Unknown KEY_PROVIDER "${want}" (use env, file or kms).`);
}

// One cipher per key directory, so every database opened from the same data directory shares a key ring.
const ciphers = new Map<string, { cipher: FieldCipher; provider: KeyProvider }>();

export function cipherFor(dbFile: string, env: Record<string, string | undefined> = process.env): { cipher: FieldCipher; provider: KeyProvider } {
  const dir = dbFile === ":memory:" ? ":memory:" : path.join(path.dirname(path.resolve(dbFile)), ".keys");
  const cacheKey = `${dir}|${env.KEY_PROVIDER ?? ""}|${env.DATA_KEY ?? ""}`;
  let hit = ciphers.get(cacheKey);
  if (!hit) {
    if (dir === ":memory:" && !env.DATA_KEY) {
      // In-memory databases (tests, scratch runs) get a key that exists only for this process.
      const provider = new EnvKeyProvider({ DATA_KEY: crypto.randomBytes(32).toString("base64") });
      hit = { cipher: new FieldCipher(provider.load()), provider };
      // not cached: each in-memory database has its own throwaway key
      return hit;
    }
    const provider = createKeyProvider(dir === ":memory:" ? "" : dir, env);
    hit = { cipher: new FieldCipher(provider.load()), provider };
    ciphers.set(cacheKey, hit);
  }
  return hit;
}

/** Test helper: forget cached ciphers (a test that changes DATA_KEY or the data dir). */
export const resetCipherCache = () => ciphers.clear();
