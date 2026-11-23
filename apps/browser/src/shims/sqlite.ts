// node:sqlite (DatabaseSync) over sql.js, the same SQLite engine compiled to WebAssembly. Synchronous, in memory.
import type { Database, SqlJsStatic } from "sql.js";

let SQL: SqlJsStatic | null = null;
export const useSqlJs = (s: SqlJsStatic) => { SQL = s; };

type Param = string | number | bigint | null | Uint8Array;
const bindable = (p: Param[]) => p.map((v) => (typeof v === "bigint" ? Number(v) : v)) as (string | number | null | Uint8Array)[];

export class StatementSync {
  constructor(private db: Database, private sql: string) {}
  private withStmt<T>(params: Param[], fn: (s: import("sql.js").Statement) => T): T {
    const s = this.db.prepare(this.sql);
    try { if (params.length) s.bind(bindable(params)); return fn(s); } finally { s.free(); }
  }
  all(...params: Param[]): Record<string, unknown>[] {
    return this.withStmt(params, (s) => { const out: Record<string, unknown>[] = []; while (s.step()) out.push(s.getAsObject()); return out; });
  }
  get(...params: Param[]): Record<string, unknown> | undefined {
    return this.withStmt(params, (s) => (s.step() ? s.getAsObject() : undefined));
  }
  run(...params: Param[]): { changes: number; lastInsertRowid: number } {
    this.withStmt(params, (s) => { while (s.step()) { /* drain */ } });
    const id = this.db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] as number | undefined;
    return { changes: this.db.getRowsModified(), lastInsertRowid: id ?? 0 };
  }
}

export class DatabaseSync {
  private db: Database;
  constructor(_file: string) {
    if (!SQL) throw new Error("sql.js is not loaded yet");
    this.db = new SQL.Database();
  }
  exec(sql: string) { this.db.exec(sql); }
  prepare(sql: string) { return new StatementSync(this.db, sql); }
  close() { this.db.close(); }
}
export default { DatabaseSync };
