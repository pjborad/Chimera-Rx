import dns from "node:dns";
import net from "node:net";

/**
 * Destination policy for the one provider that calls an address an operator typed in (OpenAI-compatible base URL).
 *
 * Refused: credentials in the URL, anything but http(s), link-local addresses (IPv4 169.254.0.0/16, IPv6 fe80::/10) in any spelling,
 * and the cloud metadata addresses (169.254.169.254, fd00:ec2::254, metadata host names). Allowed on purpose: localhost and
 * 127.0.0.0/8 / ::1, so Ollama (11434) and LM Studio (1234) keep working, and ordinary public or private-LAN hosts.
 *
 * The WHATWG URL parser already folds decimal, octal and hex IPv4 (`2852039166`, `0251.0376.0251.0376`, `0xa9.0xfe.0xa9.0xfe`),
 * trailing dots on a numeric host and upper case into dotted form, and writes an IPv4-mapped IPv6 host in hex (`[::ffff:a9fe:a9fe]`).
 * This module reads the parsed host, so it sees one canonical spelling, then checks the numeric value, not a text prefix.
 *
 * Known residual risk: DNS rebinding. A host name is resolved here and again by fetch; a hostile resolver could answer differently the
 * second time. Pinning the resolved address needs a custom undici dispatcher and is not done. Redirects are never followed.
 */

export class DestinationError extends Error {
  constructor(message: string, readonly code: "invalid" | "scheme" | "credentials" | "blocked" | "resolve") { super(message); }
}

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;
const systemLookup: LookupFn = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/** Parse an IPv6 text form (no brackets, no zone) into eight 16-bit groups, or null. Handles `::` and a dotted IPv4 tail. */
function ipv6Groups(text: string): number[] | null {
  if (!net.isIPv6(text)) return null;
  let t = text.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (tail) {
    const o = tail[1]!.split(".").map(Number);
    t = t.slice(0, -tail[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ":" + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const [head, rest] = t.split("::");
  const a = head ? head.split(":") : [];
  const b = rest === undefined ? [] : rest ? rest.split(":") : [];
  const fill = rest === undefined ? [] : Array(8 - a.length - b.length).fill("0");
  const all = [...a, ...fill, ...b].map((x) => parseInt(x || "0", 16));
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : null;
}

function ipv4Octets(text: string): number[] | null {
  if (!net.isIPv4(text)) return null;
  return text.split(".").map(Number);
}

const blockedV4 = (o: number[]) => o[0] === 169 && o[1] === 254; // link-local, includes 169.254.169.254 metadata

/** The reason an address is refused, or null when it is allowed. Accepts any IPv4 or IPv6 text, bracketed or not. */
export function blockedAddress(addr: string): string | null {
  let host = addr.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  host = host.replace(/%.*$/, ""); // zone id (fe80::1%en0)
  const v4 = ipv4Octets(host);
  if (v4) return blockedV4(v4) ? "link-local or metadata address" : null;
  const g = ipv6Groups(host);
  if (!g) return null; // not an IP literal: a host name, resolved elsewhere
  if ((g[0]! & 0xffc0) === 0xfe80) return "link-local address"; // fe80::/10
  if (g[0] === 0xfd00 && g[1] === 0x0ec2) return "metadata address"; // fd00:ec2::/32 (AWS IPv6 metadata is fd00:ec2::254)
  const embedded = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  // IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible ::a.b.c.d, NAT64 64:ff9b::a.b.c.d, and the SIIT form ::ffff:0:a.b.c.d
  if (zeros(5) && g[5] === 0xffff) return blockedV4(embedded(g[6]!, g[7]!)) ? "IPv4-mapped link-local address" : null;
  if (zeros(6) && (g[6]! !== 0 || g[7]! > 1)) return blockedV4(embedded(g[6]!, g[7]!)) ? "IPv4-compatible link-local address" : null;
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return blockedV4(embedded(g[6]!, g[7]!)) ? "NAT64 link-local address" : null;
  if (zeros(4) && g[4] === 0xffff && g[5] === 0) return blockedV4(embedded(g[6]!, g[7]!)) ? "IPv4-translated link-local address" : null;
  return null;
}

const METADATA_NAMES = /(^|\.)metadata(\.|$)|^instance-data(\.|$)/i;

/** Parse and check a base URL without touching the network. Returns the parsed URL. */
export function checkDestinationLiteral(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new DestinationError("The base URL is not a valid URL.", "invalid"); }
  if (!/^https?:$/.test(u.protocol)) throw new DestinationError("The base URL must start with http:// or https://.", "scheme");
  if (u.username || u.password) throw new DestinationError("Put the key in the key field, not in the URL.", "credentials");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host) throw new DestinationError("The base URL has no host.", "invalid");
  if (METADATA_NAMES.test(host)) throw new DestinationError("That address is not allowed.", "blocked");
  if (blockedAddress(host)) throw new DestinationError("That address is not allowed.", "blocked");
  return u;
}

/**
 * The same checks, then (for a host name) every address the name resolves to must be allowed too. Call right before each request.
 * A name that does not resolve is an error: nothing is sent.
 */
export async function assertDestination(raw: string, lookup: LookupFn = systemLookup): Promise<URL> {
  const u = checkDestinationLiteral(raw);
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (net.isIP(host)) return u;
  let answers: { address: string }[];
  try { answers = await lookup(host); } catch { throw new DestinationError("The server name did not resolve.", "resolve"); }
  if (!answers.length) throw new DestinationError("The server name did not resolve.", "resolve");
  if (answers.some((a) => blockedAddress(a.address))) throw new DestinationError("That address is not allowed.", "blocked");
  return u;
}
