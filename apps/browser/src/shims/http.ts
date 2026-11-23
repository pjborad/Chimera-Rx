// node:http for the browser build: just enough of ServerResponse for Fastify's inject (light-my-request) to run in a page.
import { EventEmitter } from "events";

export const STATUS_CODES: Record<number, string> = {
  100: "Continue", 101: "Switching Protocols", 200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 206: "Partial Content",
  301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 406: "Not Acceptable",
  408: "Request Timeout", 409: "Conflict", 410: "Gone", 413: "Payload Too Large", 414: "URI Too Long", 415: "Unsupported Media Type",
  416: "Range Not Satisfiable", 422: "Unprocessable Entity", 423: "Locked", 429: "Too Many Requests", 431: "Request Header Fields Too Large",
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout"
};
export const METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];

// A function constructor, because light-my-request calls ServerResponse.call(this, req).
export function ServerResponse(this: any, req?: unknown) {
  EventEmitter.call(this);
  this.req = req;
  this.statusCode = 200;
  this.statusMessage = undefined;
  this.headersSent = false;
  this.finished = false;
  this.writableEnded = false;
  this.sendDate = true;
  this._headers = {} as Record<string, { name: string; value: unknown }>;
  this._header = null;
}
ServerResponse.prototype = Object.create(EventEmitter.prototype, { constructor: { value: ServerResponse, writable: true, configurable: true } });
Object.assign(ServerResponse.prototype, {
  setHeader(this: any, name: string, value: unknown) { this._headers[name.toLowerCase()] = { name, value }; return this; },
  appendHeader(this: any, name: string, value: unknown) {
    const k = name.toLowerCase(); const cur = this._headers[k]?.value;
    this._headers[k] = { name, value: cur === undefined ? value : ([] as unknown[]).concat(cur, value) }; return this;
  },
  getHeader(this: any, name: string) { return this._headers[name.toLowerCase()]?.value; },
  getHeaders(this: any) { const o: Record<string, unknown> = {}; for (const [k, v] of Object.entries(this._headers) as [string, { value: unknown }][]) o[k] = v.value; return o; },
  getHeaderNames(this: any) { return Object.keys(this._headers); },
  hasHeader(this: any, name: string) { return name.toLowerCase() in this._headers; },
  removeHeader(this: any, name: string) { delete this._headers[name.toLowerCase()]; },
  writeHead(this: any, status: number, a?: unknown, b?: unknown) {
    this.statusCode = status;
    const headers = (typeof a === "object" && a !== null ? a : b) as Record<string, unknown> | unknown[] | undefined;
    if (typeof a === "string") this.statusMessage = a;
    if (Array.isArray(headers)) for (const h of headers as [string, unknown][]) this.setHeader(h[0], h[1]);
    else if (headers) for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    this.statusMessage ??= STATUS_CODES[status] ?? "unknown";
    this.headersSent = true;
    this._header = `HTTP/1.1 ${status} ${this.statusMessage}\r\n\r\n`;
    return this;
  },
  flushHeaders(this: any) { if (!this.headersSent) this.writeHead(this.statusCode); },
  write(this: any) { if (!this.headersSent) this.writeHead(this.statusCode); return true; },
  end(this: any) { if (!this.headersSent) this.writeHead(this.statusCode); this.finished = true; this.writableEnded = true; return this; },
  assignSocket(this: any, s: unknown) { this.socket = s; this.connection = s; },
  detachSocket() { /* nothing to detach */ },
  setTimeout() { return this; },
  cork() { /* no-op */ }, uncork() { /* no-op */ }
});
export class IncomingMessage extends EventEmitter {}
/** A server that never listens. Fastify builds one even when it is only used through inject(). */
export class Server extends EventEmitter {
  listening = false; keepAliveTimeout = 0; requestTimeout = 0; headersTimeout = 0; maxRequestsPerSocket = 0; timeout = 0;
  listen(): never { throw new Error("The browser build has no network listener"); }
  close(cb?: (e?: Error) => void) { cb?.(); return this; }
  address() { return null; }
  setTimeout() { return this; }
  closeIdleConnections() { /* none */ } closeAllConnections() { /* none */ }
  unref() { return this; } ref() { return this; }
}
export const createServer = (..._a: unknown[]) => new Server();
export default { STATUS_CODES, METHODS, ServerResponse, IncomingMessage, Server, createServer };
