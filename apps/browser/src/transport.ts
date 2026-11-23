// Routes the web app's same-origin API calls to the in-page Fastify app (app.inject). One call runs at a time, so the
// per-store database routing (AsyncLocalStorage) can never mix two requests. The session cookie is kept here, not in document.cookie.
/** the part of a Fastify instance this file uses */
interface Injectable { inject(o: { method: string; url: string; headers: Record<string, string>; payload?: string; remoteAddress?: string }): Promise<{ statusCode: number; headers: Record<string, unknown>; rawPayload: Uint8Array }> }
import { AsyncLocalStorage } from "async_hooks";

const API = /^\/(api|oauth|v1|mcp|fhir|hooks)(\/|\?|$)/;
const jar = new Map<string, string>();
let chain: Promise<unknown> = Promise.resolve();
/** run fn after every earlier call has finished */
export const serial = <T,>(fn: () => Promise<T>): Promise<T> => { const p = chain.then(fn); chain = p.catch(() => undefined); return p; };

const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
function storeFromCookie(): string | undefined {
  const v = jar.get("lg_session");
  const i = v ? decodeURIComponent(v).indexOf("~") : -1;
  return v && i > 0 ? decodeURIComponent(v).slice(0, i) : undefined;
}
function keepCookies(setCookie: string | string[] | undefined) {
  for (const line of ([] as string[]).concat(setCookie ?? [])) {
    const [pair, ...attrs] = line.split(";");
    const eq = pair!.indexOf("=");
    const name = pair!.slice(0, eq).trim(); const value = pair!.slice(eq + 1).trim();
    const gone = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a) || /^\s*expires=.*1970/i.test(a)) || value === "";
    if (gone) jar.delete(name); else jar.set(name, value);
  }
}

export function installTransport(app: Injectable) {
  const realFetch = window.fetch.bind(window);
  const base = import.meta.env.BASE_URL;
  async function inject(method: string, path: string, headers: Headers, body: string | undefined) {
    return serial(async () => {
      (AsyncLocalStorage as unknown as { base: unknown }).base = storeFromCookie();
      const h: Record<string, string> = {};
      headers.forEach((v, k) => { h[k] = v; });
      const ck = cookieHeader();
      if (ck) h.cookie = ck;
      const res = await app.inject({ method: method as "GET", url: path, headers: h, payload: body, remoteAddress: "127.0.0.1" });
      keepCookies(res.headers["set-cookie"] as string | string[] | undefined);
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (k !== "set-cookie" && v !== undefined) out.set(k, ([] as string[]).concat(v as string | string[]).join(", "));
      const nullBody = [101, 204, 205, 304].includes(res.statusCode);
      return new Response(nullBody ? null : new Uint8Array(res.rawPayload), { status: res.statusCode, headers: out });
    });
  }
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = new URL(req?.url ?? String(input), window.location.href);
    if (url.origin !== window.location.origin) return realFetch(input, init);
    if (API.test(url.pathname)) {
      const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers ?? req?.headers);
      let body: string | undefined;
      const raw = init?.body ?? undefined;
      if (typeof raw === "string") body = raw;
      else if (raw instanceof URLSearchParams) body = raw.toString();
      else if (req && method !== "GET" && method !== "HEAD") body = await req.text();
      return inject(method, url.pathname + url.search, headers, body);
    }
    // static files the server build serves from /fax and /ocr live under the app's base path here
    if (/^\/(fax|ocr)\//.test(url.pathname)) return realFetch(base + url.pathname.slice(1) + url.search, init);
    return realFetch(input, init);
  };
  // plain links to API downloads (audit export) cannot reach a server; fetch them through the same path and save the result
  document.addEventListener("click", (e) => {
    const a = (e.target as Element | null)?.closest?.("a[href^='/api/']") as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    void window.fetch(a.getAttribute("href")!).then(async (r) => {
      const blob = await r.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = (a.getAttribute("href")!.split("/").pop() || "download").split("?")[0] + (r.headers.get("content-type")?.includes("ndjson") ? ".ndjson" : "");
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    });
  }, true);
}
