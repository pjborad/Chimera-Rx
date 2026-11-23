// node:crypto for the browser build. browserify-aes, create-hash, create-hmac and randombytes supply the synchronous AES-GCM, hashes, HMAC and random bytes the API
// uses for encryption at rest; the three functions it lacks (scrypt, timingSafeEqual, randomInt) are added here.
import { scrypt } from "@noble/hashes/scrypt.js";
import { Buffer } from "buffer";
// The individual browserify packages, not crypto-browserify itself: that one requires "crypto" back through the alias (a cycle).
import aes from "browserify-aes";
import createHashImpl from "create-hash";
import createHmacImpl from "create-hmac";
import randomBytesImpl from "randombytes";
const cb = { createCipheriv: aes.createCipheriv, createDecipheriv: aes.createDecipheriv, createHash: createHashImpl, createHmac: createHmacImpl, randomBytes: randomBytesImpl };

const asBytes = (v: string | Uint8Array) => (typeof v === "string" ? new TextEncoder().encode(v) : v);

export function scryptSync(password: string | Uint8Array, salt: string | Uint8Array, keylen: number, opts: { N?: number; r?: number; p?: number } = {}): Buffer {
  return Buffer.from(scrypt(asBytes(password), asBytes(salt), { N: opts.N ?? 16384, r: opts.r ?? 8, p: opts.p ?? 1, dkLen: keylen }));
}
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) throw new RangeError("Input buffers must have the same byte length");
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}
export function randomInt(min: number, max?: number): number {
  const lo = max === undefined ? 0 : min;
  const hi = max === undefined ? min : max;
  const range = hi - lo;
  const lim = Math.floor(0x100000000 / range) * range;
  const buf = new Uint32Array(1);
  do { globalThis.crypto.getRandomValues(buf); } while (buf[0]! >= lim);
  return lo + (buf[0]! % range);
}
export const randomUUID = () => globalThis.crypto.randomUUID();
export const randomBytes = cb.randomBytes as (n: number) => Buffer;
export const createHash = cb.createHash as typeof import("node:crypto").createHash;
export const createHmac = cb.createHmac as typeof import("node:crypto").createHmac;
export const createCipheriv = cb.createCipheriv as typeof import("node:crypto").createCipheriv;
export const createDecipheriv = cb.createDecipheriv as typeof import("node:crypto").createDecipheriv;
export const getRandomValues = (a: Uint8Array) => globalThis.crypto.getRandomValues(a);
export default { ...cb, scryptSync, timingSafeEqual, randomInt, randomUUID, randomBytes, createHash, createHmac, createCipheriv, createDecipheriv, getRandomValues };
