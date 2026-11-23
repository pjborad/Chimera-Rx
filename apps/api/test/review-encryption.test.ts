import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp, Db, ingestFaxInbox, loadConfig, SandboxNotifier, seedDatabase, type Ctx } from "../src/index";
import { resetDemo } from "./scenario-fixtures";
import { AgentRuntime } from "../src/agents";
import { resetCipherCache } from "../src/crypto";

// REV-API: after a full scenario (agents, refills, recall sends, voicemail, patient view, fill, register), no synthetic patient
// name, phone, email, date of birth, allergy or condition may appear in the raw SQLite file or its WAL.

const PW = "moonlight-rx-2026";
const NOW = Date.parse("2026-11-18T18:00:00Z");

describe("REV-API PHI is encrypted in the raw database file after every write path", () => {
  it("raw bytes of the db and WAL hold no patient identifiers", async () => {
    process.env.OFFLINE = "1";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-enc-"));
    resetCipherCache();
    const file = path.join(dir, "chimera-rx.sqlite");
    const cfg = loadConfig({}, { sqlitePath: file, sandboxDelayMs: 5, today: "2026-11-18", nightWatch: false, assetsDir: "/nonexistent", webDist: "/nonexistent" });
    const db = new Db(file);
    const ctx: Ctx = { cfg, db, notify: new SandboxNotifier(db, cfg), now: () => NOW, agents: new AgentRuntime({ LLM_PROVIDER: "mock" }) };
    seedDatabase(db, cfg, NOW); await ingestFaxInbox(ctx);
    await resetDemo(ctx, null, "recall-aware-refill");
    await resetDemo(ctx, null, "class1-recall");
    const app = await buildApp(ctx);
    const login = async (w: string) => (await app.inject({ method: "POST", url: "/api/auth/login", payload: { storeId: "store-7", email: `${w}@elmstreetrx.example`, password: PW, trusted: true } })).cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const ph = await login("j.rivera"), cashier = await login("m.diaz");
    const call = (cookie: string, method: "GET" | "POST", url: string, payload?: unknown) => app.inject({ method, url, payload: payload as never, headers: { cookie } });

    for (const a of ["coroner", "night-watch", "outreach-drafter", "rx-explainer", "stock-advisor", "copilot", "refill-outreach"]) await call(ph, "POST", `/api/agents/${a}/run`, { useSample: true });
    await call(ph, "POST", "/api/refills/draft", {});
    await call(ph, "POST", "/api/refills/send", { attest: true });
    const recalls = (await call(ph, "GET", "/api/recalls")).json() as any[];
    const rid = (Array.isArray(recalls) ? recalls : (recalls as any).recalls)[0].id;
    for (const l of ((await call(ph, "GET", `/api/recalls/${rid}`)).json() as any).recall.lots) await call(ph, "POST", `/api/recalls/${rid}/confirm-lot`, { lot: l.lot });
    await call(ph, "POST", "/api/outreach/run");
    const d = (await call(ph, "GET", `/api/recalls/${rid}/messages`)).json() as any;
    await call(ph, "POST", `/api/recalls/${rid}/notifications`, { sms: d.sms, emailSubject: d.emailSubject, emailBody: d.emailBody, attest: true });
    const vm = (await call(ph, "GET", `/api/recalls/${rid}/voicemail`)).json() as any;
    await call(ph, "POST", `/api/recalls/${rid}/voicemail`, { script: vm.script ?? vm.draft ?? "Please call the pharmacy.", attest: true });
    await call(ph, "GET", "/api/patients/S-0417?reason=review");
    await call(ph, "POST", "/api/patients/S-0417/refill-sync");
    for (const r of ((await call(ph, "GET", "/api/rx")).json() as any[]).slice(0, 3)) { await call(ph, "GET", `/api/rx/${r.rx}`); await call(ph, "POST", `/api/rx/${r.rx}/review`); }
    await call(ph, "POST", "/api/sms/inbound", { from: "(555) 010-0100", body: "STOP" });
    await call(cashier, "GET", "/api/register/patients?q=a");
    await call(ph, "POST", "/api/dscsa/cases", { note: "Maria Alvarez returned a damaged pack" });

    const n = (t: string, w = "") => Number(db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t} ${w}`)!.c);
    const covered = { ai_runs: n("ai_runs"), ai_drafts: n("ai_drafts"), outbox: n("outbox"), notifications: n("notifications"), outreach_calls: n("outreach_calls"), audit: n("audit"), suspect_cases: n("suspect_cases"), rx_findings: n("rx_findings") };
    for (const [t, c] of Object.entries(covered)) if (t !== "suspect_cases") expect(c, `${t} must have rows so the scan means something`).toBeGreaterThan(0);

    // needles come from the decrypted patient table
    const pats = db.all<any>("SELECT name, dob, phone, email, allergies, conditions FROM patients");
    const needles = new Set<string>();
    for (const p of pats) for (const v of [p.name, p.dob, p.phone, p.email, p.allergies, p.conditions]) if (v && String(v).length >= 6) needles.add(String(v));
    for (const p of pats) { const nm = String(p.name).split(" "); if (nm[1] && nm[1].length > 3) needles.add(nm[1]); if (nm[0] && nm[0].length > 3) needles.add(nm[0]); }
    db.raw.exec("PRAGMA wal_checkpoint(PASSIVE)");
    // A plain value sits between non-base64 bytes; a chance match inside ciphertext (even one split across an overflow page) does not.
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bounded = (hay: string, n: string) => new RegExp(`(?<![A-Za-z0-9_-])${esc(n)}(?![A-Za-z0-9_-])`).test(hay);
    // An envelope is base64, so a short name can turn up inside one by chance: envelopes are removed before searching.
    const files = [file, `${file}-wal`].filter((f) => fs.existsSync(f));
    const hits: string[] = [];
    for (const f of files) { const buf = fs.readFileSync(f).toString("latin1").replace(/enc:v1:[A-Za-z0-9_:-]+/g, ""); for (const n of needles) if (bounded(buf, n)) hits.push(`${path.basename(f)}: ${n}`); }
    // which table holds each hit, for the evidence
    const where: string[] = [];
    for (const t of db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
      const rows = db.raw.prepare(`SELECT * FROM ${t.name}`).all() as Record<string, unknown>[];
      for (const r of rows) for (const [c, v] of Object.entries(r)) if (typeof v === "string") for (const n of needles) if (v.replace(/enc:v1:[A-Za-z0-9_:-]+/g, "").includes(n) && !where.includes(`${t.name}.${c}`)) where.push(`${t.name}.${c}`);
    }
    if (process.env.ENC_DUMP) fs.writeFileSync(process.env.ENC_DUMP, JSON.stringify({ needles: needles.size, hits: hits.length, where }, null, 1));
    expect(where).toEqual([]);
    expect(hits).toEqual([]);
  }, 60_000);
});
