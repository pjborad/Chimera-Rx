// The Buffer polyfill predates the "base64url" encoding that the API uses for tokens and encryption envelopes. Patched here, in the
// one copy every package gets (see the alias in vite.config.ts).
import * as real from "../../node_modules/buffer/index.js";

const B = (real as any).Buffer;
if (!B.isEncoding("base64url")) {
  const from = B.from.bind(B);
  B.from = (v: unknown, enc?: unknown, len?: unknown) => (typeof v === "string" && enc === "base64url" ? from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64") : from(v, enc, len));
  const toString = B.prototype.toString;
  B.prototype.toString = function (this: any, enc?: string, a?: number, b?: number) {
    return enc === "base64url" ? toString.call(this, "base64", a, b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : toString.call(this, enc, a, b);
  };
  const isEnc = B.isEncoding.bind(B);
  B.isEncoding = (e: string) => e === "base64url" || isEnc(e);
}
export const Buffer = B;
export const SlowBuffer = (real as any).SlowBuffer;
export const INSPECT_MAX_BYTES = (real as any).INSPECT_MAX_BYTES;
export const kMaxLength = (real as any).kMaxLength;
export default { Buffer: B, SlowBuffer, INSPECT_MAX_BYTES, kMaxLength };
