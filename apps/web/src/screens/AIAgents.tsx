import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { get, msg, post, type User } from "../lib/api";
import { btn, C, ErrorBox, Footer, input, MONO, Pill } from "../components/kit";
import { mainStyle, PageHeader } from "../components/Shell";
import { SuggestionCard, useSuggestions } from "../components/Suggestions";

interface ProviderInfo {
  provider: string; providerLabel: string; model: string; region: string; baseUrl: string; keySet: boolean; keyHint: string | null; keySource: string; credentials: string;
  providers: { id: string; label: string; defaultModel: string; needsKey: boolean }[]; unavailableUntil: number | null;
}
interface BgStatus { id: string; trigger: string; enabled: boolean; enabledBy: string | null; lastRunAt: number | null; nextRunAt: number | null; runsToday: number; lastStatus: "ok" | "error" | null; lastMode: "ai" | "rules only" | null; lastError: string | null; running: boolean }
interface AgentInfo { id: string; name: string; purpose: string; guardrails: string[]; canRun: boolean; background: BgStatus | null }
interface Overview { label: string; provider: ProviderInfo; canConfigure: boolean; agents: AgentInfo[]; background: { allowed: boolean; on: number; canSwitch: boolean; canRunNow: boolean } }
interface Dropped { what: string; why: string }
interface Run {
  id: number; agentId: string; provider: string; model: string; startedAt: number; latencyMs: number; mode: "ai" | "rules only"; input: string;
  ruleOutput: any; rawOutput: string | null; gatedOutput: any; dropped: Dropped[]; label: string; error: string | null; by: string; extra?: { drafts?: Draft[] };
}
interface Draft { patientId: string; channel: string; subject: string | null; text: string }

const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 22, display: "flex", flexDirection: "column" as const, gap: 12 };
const fieldLabel = { fontSize: 12, color: C.dimmer, display: "flex", flexDirection: "column" as const, gap: 4, flex: "1 1 200px" };

/** AI Agents: a provider card, the agent list with a one-click sample run, and rules-vs-AI side by side for the last run. */
export function AIAgents({ user }: { user: User }) {
  const qc = useQueryClient();
  const ov = useQuery({ queryKey: ["agents"], queryFn: () => get<Overview>("/api/agents") });
  const runs = useQuery({ queryKey: ["agent-runs"], queryFn: () => get<{ runs: Run[] }>("/api/agents/runs?limit=8"), enabled: user.role !== "admin" }); // run history holds patient ids: pharmacist and technician only
  const [err, setErr] = useState("");
  const [result, setResult] = useState<Run | null>(null);
  const [busy, setBusy] = useState("");
  const [inputs, setInputs] = useState<Record<string, Record<string, string>>>({});

  const run = async (a: AgentInfo, useSample: boolean) => {
    setErr(""); setBusy(a.id);
    try {
      const body = useSample ? { useSample: true } : { input: inputs[a.id] ?? {} };
      const r = await post<{ run: Run }>(`/api/agents/${a.id}/run`, body);
      setResult(r.run);
      void qc.invalidateQueries({ queryKey: ["agent-runs"] });
    } catch (e) { setErr(msg(e)); } finally { setBusy(""); }
  };
  const o = ov.data;
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") === "suggestions" ? "suggestions" : "agents";
  const canSee = user.role === "pharmacist" || user.role === "technician";
  const open = useSuggestions("?status=open", canSee);
  const all = useSuggestions("?status=all", canSee && tab === "suggestions");
  const [filter, setFilter] = useState<"open" | "decided">("open");
  const setIn = (id: string, k: string, v: string) => setInputs((s) => ({ ...s, [id]: { ...(s[id] ?? {}), [k]: v } }));
  const editor = (a: AgentInfo): ReactNode => {
    const f = (k: string, label: string, ph: string, area = false) => (
      <label style={fieldLabel}>{label}
        {area ? <textarea value={inputs[a.id]?.[k] ?? ""} onChange={(e) => setIn(a.id, k, e.target.value)} placeholder={ph} rows={4} style={input({ height: "auto", padding: 12, fontFamily: MONO, fontSize: 13 })} />
          : <input value={inputs[a.id]?.[k] ?? ""} onChange={(e) => setIn(a.id, k, e.target.value)} placeholder={ph} style={input()} />}
      </label>
    );
    if (a.id === "coroner") return f("text", "Recall notice text", "Paste the notice text, or use the sample", true);
    if (a.id === "copilot") return f("question", "Question", "Which patients received lot PRORX050925-1?");
    if (a.id === "rx-explainer") return f("rx", "Rx number", "e.g. 0072214");
    if (a.id === "outreach-drafter") return f("recallId", "Recall number", "e.g. D-0417-2026");
    return <p style={{ margin: 0, fontSize: 13, color: C.dim }}>This agent takes no input. It reads the store's own data.</p>;
  };

  return (
    <>
      <PageHeader title="AI agents" sub="Rules decide. The model explains. A gate checks the model. A pharmacist decides." />
      <main style={mainStyle()}>
        <div role="note" style={{ padding: "12px 16px", borderRadius: 10, background: "var(--accent-soft)", fontSize: 14 }}>
          <strong>{o?.label ?? "AI advisory, a pharmacist decides"}.</strong> Every agent runs its deterministic rules first. The model can add an explanation or a lower-confidence note; it cannot remove a rule hit, invent a lot, or send anything. With no provider ("none") or when a call fails, the agent shows "rules only".
        </div>
        <div role="tablist" aria-label="AI agents sections" style={{ display: "flex", gap: 8 }}>
          <button role="tab" aria-selected={tab === "agents"} onClick={() => setSp({})} style={btn(tab === "agents" ? "primary" : "ghost", { minHeight: 44 })}>Agents{o ? ` · ${o.background.on} on` : ""}</button>
          {canSee && <button role="tab" aria-selected={tab === "suggestions"} onClick={() => setSp({ tab: "suggestions" })} style={btn(tab === "suggestions" ? "primary" : "ghost", { minHeight: 44 })}>Suggestions{open.data ? ` · ${open.data.summary.open}` : ""}</button>}
        </div>
        <ErrorBox e={err} />
        {tab === "suggestions" && canSee && (
          <section aria-label="Suggestions" style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
              <h2 style={{ margin: 0, fontSize: 16 }}>Rx Guardian suggestions</h2>
              <span style={{ display: "flex", gap: 6 }}>
                <button aria-pressed={filter === "open"} onClick={() => setFilter("open")} style={btn(filter === "open" ? "primary" : "ghost", { minHeight: 40 })}>Open</button>
                <button aria-pressed={filter === "decided"} onClick={() => setFilter("decided")} style={btn(filter === "decided" ? "primary" : "ghost", { minHeight: 40 })}>Decided</button>
              </span>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: C.dim }}>Found by checking each new or changed order against the patient's history. The agent never changes an order. {all.data?.canDecide ? "You decide each one." : "A pharmacist decides; you can read the evidence."}</p>
            {(all.data?.suggestions ?? []).filter((x) => (filter === "open" ? x.status === "open" : x.status !== "open")).map((x) => <SuggestionCard key={x.id} s={x} canDecide={all.data?.canDecide ?? false} />)}
            {all.data && all.data.suggestions.filter((x) => (filter === "open" ? x.status === "open" : x.status !== "open")).length === 0 && <p style={{ margin: 0, fontSize: 14, color: C.dim }}>{filter === "open" ? "Nothing open. Switch on Rx Guardian on the Agents tab, or press Run now." : "Nothing decided yet."}</p>}
          </section>
        )}
        {tab === "agents" && <>
        {o && !o.background.allowed && <div role="status" style={{ padding: "10px 14px", borderRadius: 10, background: C.warnSoft, fontSize: 14 }}>Background mode is paused by a server setting (AGENTS_BACKGROUND=0). Agents still run when a pharmacist presses Run now.</div>}
        {o && <ProviderCard info={o.provider} canConfigure={o.canConfigure} onChanged={() => { void qc.invalidateQueries({ queryKey: ["agents"] }); }} />}

        <section aria-label="Agents" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16 }}>
          {(o?.agents ?? []).map((a) => (
            <article key={a.id} style={card} aria-label={a.name}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                <h2 style={{ margin: 0, fontSize: 16 }}>{a.name}</h2>
                <Pill tone={a.canRun ? "violet" : "gray"}>{a.canRun ? (a.background ? "Advisory" : "Read-only") : `Not for a ${user.role}`}</Pill>
              </div>
              <p style={{ margin: 0, fontSize: 14, color: C.dim, lineHeight: 1.5 }}>{a.purpose}</p>
              <details>
                <summary style={{ cursor: "pointer", fontSize: 13, color: C.violet2 }}>Guardrails</summary>
                <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13, lineHeight: 1.5, color: C.ink2 }}>{a.guardrails.map((g) => <li key={g}>{g}</li>)}</ul>
              </details>
              {a.background && o && <BackgroundRow a={a} bg={a.background} o={o} onError={setErr} />}
              {a.canRun && (
                <>
                  <button disabled={!!busy} onClick={() => run(a, true)} style={btn("primary", { minHeight: 44 })}>{busy === a.id ? "Running…" : "Run with sample input"}</button>
                  <details>
                    <summary style={{ cursor: "pointer", fontSize: 13, color: C.dim }}>Use my own input</summary>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
                      {editor(a)}
                      <button disabled={!!busy} onClick={() => run(a, false)} style={btn("ghost", { minHeight: 44 })}>Run with this input</button>
                    </div>
                  </details>
                </>
              )}
            </article>
          ))}
        </section>

        {result && <RunView run={result} name={o?.agents.find((a) => a.id === result.agentId)?.name ?? result.agentId} />}

        {user.role !== "admin" && <section aria-label="Recent runs" style={card}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Recent runs <span style={{ color: C.dimmer, fontWeight: 400 }}>(newest first, the last 300 are kept)</span></h2>
          {!(runs.data?.runs.length) && <p style={{ margin: 0, color: C.dim, fontSize: 14 }}>No runs yet. Press "Run with sample input" on any agent.</p>}
          {runs.data?.runs.map((r) => (
            <button key={r.id} onClick={() => setResult(r)} style={{ ...btn("ghost", { justifyContent: "space-between", minHeight: 44, width: "100%", textAlign: "left" }) }}>
              <span>{o?.agents.find((a) => a.id === r.agentId)?.name ?? r.agentId} <span style={{ color: C.dimmer, fontSize: 12 }}>· {r.by} · {new Date(r.startedAt).toISOString().slice(11, 16)} UTC</span></span>
              <span style={{ display: "flex", gap: 6 }}><Pill tone={r.mode === "ai" ? "violet" : "gray"}>{r.mode === "ai" ? `${r.provider}` : "rules only"}</Pill><Pill tone="gray">{r.latencyMs} ms</Pill>{r.dropped.length > 0 && <Pill tone="amber">{r.dropped.length} dropped</Pill>}</span>
            </button>
          ))}
        </section>}
        </>}
        <Footer />
      </main>
    </>
  );
}

const stamp = (ms: number | null) => (ms ? `${new Date(ms).toISOString().slice(11, 16)} UTC` : "not yet");

/** Background mode for one agent: the switch, when it last ran and runs next, how many runs today, and Run now. */
function BackgroundRow({ a, bg, o, onError }: { a: AgentInfo; bg: BgStatus; o: Overview; onError: (e: string) => void }) {
  const qc = useQueryClient();
  const refresh = () => ["agents", "suggestions", "today", "agent-runs", "rxq"].forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
  const toggle = useMutation({ mutationFn: () => post(`/api/agents/${a.id}/${bg.enabled ? "disable" : "enable"}`), onSuccess: () => { onError(""); refresh(); }, onError: (e) => onError(msg(e)) });
  const now = useMutation({ mutationFn: () => post(`/api/agents/${a.id}/run-now`), onSuccess: () => { onError(""); refresh(); }, onError: (e) => onError(msg(e)) });
  return (
    <div role="group" aria-label={`${a.name} background mode`} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 10, background: C.well, border: `1px solid ${bg.enabled ? "var(--ok)" : C.line}` }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" }}>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <strong style={{ fontSize: 14 }}>Background mode</strong>
          <Pill tone={bg.enabled ? "green" : "gray"}>{bg.enabled ? "On" : "Off"}</Pill>
          {bg.running && <Pill tone="violet">Running</Pill>}
        </span>
        <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button role="switch" aria-checked={bg.enabled} disabled={!o.background.canSwitch || toggle.isPending} onClick={() => toggle.mutate()} style={btn(bg.enabled ? "ghost" : "primary", { minHeight: 44 })}>{bg.enabled ? "Switch off" : "Switch on"}</button>
          {o.background.canRunNow && <button disabled={now.isPending || bg.running} onClick={() => now.mutate()} style={btn("ghost", { minHeight: 44 })}>{now.isPending ? "Running…" : "Run now"}</button>}
        </span>
      </div>
      <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, fontSize: 13 }}>
        <div><dt style={{ color: C.dimmer, fontSize: 12 }}>Last run</dt><dd style={{ margin: 0 }}>{stamp(bg.lastRunAt)}</dd></div>
        <div><dt style={{ color: C.dimmer, fontSize: 12 }}>Next run</dt><dd style={{ margin: 0 }}>{bg.enabled ? (o.background.allowed ? stamp(bg.nextRunAt) : "paused") : "off"}</dd></div>
        <div><dt style={{ color: C.dimmer, fontSize: 12 }}>Runs today</dt><dd style={{ margin: 0 }}>{bg.runsToday}</dd></div>
      </dl>
      <span style={{ fontSize: 12, color: C.dimmer }}>Runs: {bg.trigger}.{bg.lastMode === "rules only" ? " Last run used rules only." : ""}{bg.lastStatus === "error" ? ` Last run failed: ${bg.lastError ?? "unknown"}.` : ""}{!o.background.canSwitch ? " A pharmacist or admin switches it." : ""}</span>
    </div>
  );
}

function ProviderCard({ info, canConfigure, onChanged }: { info: ProviderInfo; canConfigure: boolean; onChanged: () => void }) {
  const [provider, setProvider] = useState(info.provider);
  const [model, setModel] = useState(info.model);
  const [region, setRegion] = useState(info.region);
  const [baseUrl, setBaseUrl] = useState(info.baseUrl);
  const [key, setKey] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [testing, setTesting] = useState(false);
  const sel = info.providers.find((p) => p.id === provider);
  const save = useMutation({
    mutationFn: () => post<{ provider: ProviderInfo }>("/api/agents/provider", { provider, model, ...(provider === "bedrock" ? { region } : {}), ...(provider === "openai-compatible" ? { baseUrl } : {}), ...(key ? { apiKey: key } : {}) }),
    onSuccess: (r) => { setKey(""); setErr(""); setNote(`Saved. Using ${r.provider.provider} · ${r.provider.model || "no model"}.`); onChanged(); },
    onError: (e) => { setNote(""); setErr(msg(e)); }
  });
  const test = async () => {
    setTesting(true); setErr(""); setNote("");
    try { const r = await post<{ ok: boolean; message: string; latencyMs: number }>("/api/agents/provider/test"); (r.ok ? setNote : setErr)(`${r.message} (${r.latencyMs} ms)`); } catch (e) { setErr(msg(e)); } finally { setTesting(false); }
  };
  return (
    <section aria-label="Provider" style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Provider</h2>
        <span style={{ fontSize: 13, color: C.dim }}>Now: <strong>{info.providerLabel}</strong>{info.model ? ` · ${info.model}` : ""}{info.unavailableUntil ? " · paused after an error (rules only for a minute)" : ""}</span>
      </div>
      <p style={{ margin: 0, fontSize: 13, color: C.dim }}>Credentials: {info.credentials}. {info.keySet ? `Key ${info.keyHint} (${info.keySource}).` : ""} A key you paste here stays in the server's memory. It is never saved to disk, never logged and never shown again.</p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <label style={fieldLabel}>Provider
          <select value={provider} disabled={!canConfigure} onChange={(e) => { setProvider(e.target.value); setModel(info.providers.find((p) => p.id === e.target.value)?.defaultModel ?? ""); }} style={input()}>
            {info.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        {provider !== "none" && provider !== "mock" && (
          <label style={fieldLabel}>Model
            <input value={model} disabled={!canConfigure} onChange={(e) => setModel(e.target.value)} placeholder={sel?.defaultModel} style={input({ fontFamily: MONO })} />
          </label>
        )}
        {provider === "bedrock" && <label style={fieldLabel}>AWS region<input value={region} disabled={!canConfigure} onChange={(e) => setRegion(e.target.value)} style={input({ fontFamily: MONO })} /></label>}
        {provider === "openai-compatible" && <label style={fieldLabel}>Base URL (OpenAI, Azure, Ollama, LM Studio, vLLM)<input value={baseUrl} disabled={!canConfigure} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1" style={input({ fontFamily: MONO })} /></label>}
        {(provider === "anthropic" || provider === "openai-compatible") && (
          <label style={fieldLabel}>API key {info.keySet && info.provider === provider ? `(current ${info.keyHint})` : ""}
            <input type="password" autoComplete="off" value={key} disabled={!canConfigure} onChange={(e) => setKey(e.target.value)} placeholder={provider === "openai-compatible" ? "optional for local servers" : "paste a key"} style={input({ fontFamily: MONO })} />
          </label>
        )}
      </div>
      {provider === "bedrock" && <p style={{ margin: 0, fontSize: 13, color: C.dim }}>Bedrock uses your AWS credential chain (AWS_PROFILE, environment keys, SSO or a role). No key is entered here.</p>}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button disabled={!canConfigure || save.isPending} onClick={() => save.mutate()} style={btn("primary", { minHeight: 44 })}>Save</button>
        <button disabled={!canConfigure || testing} onClick={test} style={btn("ghost", { minHeight: 44 })}>{testing ? "Testing…" : "Test connection"}</button>
        {!canConfigure && <span style={{ fontSize: 13, color: C.dim }}>A pharmacist or admin changes the provider.</span>}
      </div>
      {note && <div role="status" style={{ fontSize: 14, color: C.green2 }}>{note}</div>}
      <ErrorBox e={err} />
    </section>
  );
}

function RunView({ run, name }: { run: Run; name: string }) {
  const g = run.gatedOutput, r = run.ruleOutput;
  const col = (title: string, tone: string, sub: string, data: unknown, ai: boolean): ReactNode => (
    <div style={{ flex: "1 1 360px", minWidth: 0, display: "flex", flexDirection: "column", gap: 8, padding: 14, borderRadius: 12, background: C.well, border: `1px solid ${C.line}` }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}><strong style={{ fontSize: 14 }}>{title}</strong><Pill tone={tone}>{sub}</Pill></div>
      <Out data={data} ai={ai} />
    </div>
  );
  return (
    <section aria-label="Run result" style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{name}: result</h2>
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Pill tone={run.mode === "ai" ? "violet" : "gray"}>{run.mode === "ai" ? "AI + gate" : "Rules only"}</Pill>
          <Pill tone="gray">{run.provider}{run.model ? ` · ${run.model}` : ""}</Pill>
          <Pill tone="gray">{run.latencyMs} ms</Pill>
          <Pill tone="amber">{run.label}</Pill>
        </span>
      </div>
      {run.error && <div role="status" style={{ fontSize: 13, color: C.amber2 }}>The model could not be used for this run ({run.error}). The rule output is shown.</div>}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {col("Rule output", "green", "deterministic, always runs", r, false)}
        {col("AI output after the gate", "violet", run.mode === "ai" ? "advisory" : "same as rules: no AI used", g, true)}
      </div>
      <div style={{ padding: 14, borderRadius: 12, border: `1px solid ${run.dropped.length ? "var(--warn)" : C.line}`, background: run.dropped.length ? C.warnSoft : C.well }}>
        <strong style={{ fontSize: 14 }}>What the gate dropped</strong>
        {run.dropped.length === 0 ? <p style={{ margin: "6px 0 0", fontSize: 13, color: C.dim }}>Nothing. {run.mode === "ai" ? "Everything the model said passed the checks." : "No model was used."}</p> : (
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>{run.dropped.map((d, i) => <li key={i}><strong>{d.what}</strong>: {d.why}</li>)}</ul>
        )}
      </div>
      {run.extra?.drafts && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <strong style={{ fontSize: 14 }}>Drafts in the pharmacist's queue <Pill tone="amber">Draft. Nothing was sent.</Pill></strong>
          {run.extra.drafts.slice(0, 12).map((d, i) => (
            <div key={i} style={{ fontSize: 13, padding: 10, borderRadius: 10, background: C.well, border: `1px solid ${C.line}` }}>
              <Pill tone="gray">{d.channel}</Pill> <span style={{ fontFamily: MONO, color: C.dimmer }}>{d.patientId}</span>
              {d.subject && <div style={{ fontWeight: 600, marginTop: 4 }}>{d.subject}</div>}
              <div style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{d.text}</div>
            </div>
          ))}
          {run.extra.drafts.length > 12 && <span style={{ fontSize: 12, color: C.dimmer }}>…and {run.extra.drafts.length - 12} more.</span>}
        </div>
      )}
      <details>
        <summary style={{ cursor: "pointer", fontSize: 13, color: C.dim }}>Prompt sent (de-identified, patient IDs only) and the model's raw answer</summary>
        <pre style={pre}>{run.input || "(no model call)"}</pre>
        <pre style={pre}>{run.rawOutput ?? "(no model answer)"}</pre>
      </details>
    </section>
  );
}

const pre = { margin: "8px 0 0", padding: 12, borderRadius: 10, background: C.chip, fontFamily: MONO, fontSize: 12, whiteSpace: "pre-wrap" as const, overflowWrap: "anywhere" as const, maxHeight: 260, overflow: "auto" };

/** Plain rendering of an agent's output: the sentence first, then lists, then the full JSON on request. */
function Out({ data, ai }: { data: any; ai: boolean }) {
  if (data == null) return <p style={{ margin: 0, fontSize: 13, color: C.dim }}>Nothing.</p>;
  const text: string | undefined = data.summary ?? data.answer;
  const lots: any[] | undefined = data.lots;
  const findings: any[] | undefined = data.findings;
  const items: any[] | undefined = data.items;
  const templates: Record<string, string> | undefined = data.templates;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13, lineHeight: 1.5 }}>
      {text && <p style={{ margin: 0, fontSize: 14 }}>{text}</p>}
      {lots && <ul style={ul}>{lots.map((l, i) => <li key={i}><span style={{ fontFamily: MONO }}>{l.value}</span> · exp {l.expiry ?? "none printed"} · confidence {l.confidence} · {l.source}</li>)}{lots.length === 0 && <li>No lots found.</li>}</ul>}
      {findings && <ul style={ul}>{findings.filter((f) => f.severity !== "pass").map((f, i) => <li key={i}><Pill tone={f.severity === "block" ? "red" : f.severity === "needs_review" ? "amber" : "gray"}>{f.severity.replace("_", " ")}</Pill> {f.source === "llm" && <Pill tone="violet">AI suggestion</Pill>} <strong>{f.title}</strong>. {f.body}</li>)}</ul>}
      {items && <ul style={ul}>{items.map((it, i) => <li key={i}><strong>{it.product}</strong>: {it.reason}{ai && it.explanation && <div style={{ color: C.violet2 }}>AI: {it.explanation}</div>}</li>)}{items.length === 0 && <li>No suggestions.</li>}</ul>}
      {templates && <ul style={ul}>{Object.entries(templates).map(([k, v]) => <li key={k}><strong>{k}</strong>{data.source?.[k] ? ` (${data.source[k] === "ai" ? "AI-written, gate passed" : "approved default"})` : ""}: <span style={{ whiteSpace: "pre-wrap" }}>{v}</span></li>)}</ul>}
      {data.toolCalls && <div style={{ color: C.dim }}>Read-only lookups: {data.toolCalls.map((c: any) => `${c.tool}${c.ok ? "" : " (refused)"}`).join(", ")}</div>}
      {data.counts && <div style={{ color: C.dim }}>{Object.entries(data.counts).map(([k, v]) => `${k}: ${v}`).join(" · ")}</div>}
      <details><summary style={{ cursor: "pointer", color: C.dimmer }}>Full record</summary><pre style={pre}>{JSON.stringify(data, null, 2)}</pre></details>
    </div>
  );
}
const ul = { margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column" as const, gap: 6 };
