// A read-mostly virtual file system: the fixtures are bundled as text, writes land in memory.
const files = new Map<string, string>();
const fixtures = import.meta.glob("../../../api/fixtures/**/*.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
for (const [k, v] of Object.entries(fixtures)) files.set(`/app/apps/api/fixtures/${k.split("/fixtures/")[1]}`, v);

const norm = (p: string) => p.replace(/\/+$/, "");
const isDir = (p: string) => [...files.keys()].some((k) => k.startsWith(`${norm(p)}/`));
const enoent = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: "ENOENT" });

export const existsSync = (p: string) => files.has(norm(p)) || isDir(p);
export function readFileSync(p: string, enc?: string): string | Uint8Array {
  const v = files.get(norm(p));
  if (v === undefined) throw enoent(p);
  return enc ? v : new TextEncoder().encode(v);
}
export const writeFileSync = (p: string, data: string | Uint8Array) => { files.set(norm(p), typeof data === "string" ? data : new TextDecoder().decode(data)); };
export const mkdirSync = () => undefined;
export const readdirSync = (p: string) => [...new Set([...files.keys()].filter((k) => k.startsWith(`${norm(p)}/`)).map((k) => k.slice(norm(p).length + 1).split("/")[0]!))];
export const rmSync = (p: string) => { files.delete(norm(p)); };
export const unlinkSync = rmSync;
const unsupported = (n: string) => () => { throw new Error(`fs.${n} is not available in the browser build`); };
export const statSync = (p: string) => { if (!existsSync(p)) throw enoent(p); return { mode: 0o600 }; };
export const chmodSync = () => undefined;
export const openSync = unsupported("openSync");
export const writeSync = unsupported("writeSync");
export const fsyncSync = unsupported("fsyncSync");
export const closeSync = unsupported("closeSync");
export const linkSync = unsupported("linkSync");
export const renameSync = unsupported("renameSync");
export const mkdtempSync = unsupported("mkdtempSync");
export default { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, unlinkSync, statSync, chmodSync, openSync, writeSync, fsyncSync, closeSync, linkSync, renameSync, mkdtempSync };
