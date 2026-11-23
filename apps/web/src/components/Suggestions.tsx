import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { get, msg, post, type User } from "../lib/api";
import { btn, C, ErrorBox, input, MONO, Pill } from "./kit";

/** Rx Guardian suggestions. Advisory: a pharmacist accepts (the order goes on hold), dismisses with a reason, or sends a prescriber change request. */

export interface Suggestion {
  id: number; patientId: string; patientName: string | null; rxNumber: string; severity: "monitor" | "needs_review" | "block"; rule: string; title: string;
  evidence: { text: string; date: string | null }[]; explanation: string; explainedBy: "ai" | "rules"; status: "open" | "accepted" | "dismissed" | "resolved";
  source: "rule" | "llm"; decidedBy: string | null; decision: string | null; decisionReason: string | null; drug: string | null; orderStatus: string | null; orderReview: string | null;
}
export interface SuggestionSummary { open: number; bySeverity: { block: number; needs_review: number; monitor: number }; top: { id: number; rx: string; patientId: string; patient: string | null; title: string; severity: Suggestion["severity"]; drug: string | null }[]; canDecide?: boolean }
export interface SuggestionList { label: string; canDecide: boolean; summary: SuggestionSummary; suggestions: Suggestion[] }

export const SEV_LABEL: Record<Suggestion["severity"], string> = { block: "Block", needs_review: "Needs review", monitor: "Monitor" };
export const SEV_TONE: Record<Suggestion["severity"], string> = { block: "red", needs_review: "amber", monitor: "gray" };
const DECISION: Record<string, string> = { hold: "Accepted: order put on hold", change_request: "Accepted: prescriber change request sent", dismissed: "Dismissed", resolved: "Closed: the history no longer backs it" };

export const useSuggestions = (q: string, enabled = true) => useQuery({ queryKey: ["suggestions", q], queryFn: () => get<SuggestionList>(`/api/suggestions${q}`), enabled, refetchInterval: 15000 });
const refreshAll = (qc: ReturnType<typeof useQueryClient>) => ["suggestions", "today", "rxq", "rx", "review", "pmsg", "agents"].forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));

export function SuggestionCard({ s, canDecide, showOrder = true }: { s: Suggestion; canDecide: boolean; showOrder?: boolean }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"view" | "dismiss" | "accept">("view");
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const done = { onSuccess: () => { setErr(""); setMode("view"); setText(""); refreshAll(qc); }, onError: (e: unknown) => setErr(msg(e)) };
  const accept = useMutation({ mutationFn: () => post(`/api/suggestions/${s.id}/accept`, { note: text.trim() || undefined }), ...done });
  const dismiss = useMutation({ mutationFn: () => post(`/api/suggestions/${s.id}/dismiss`, { reason: text }), ...done });
  const change = useMutation({ mutationFn: () => post(`/api/suggestions/${s.id}/change-request`, {}), ...done });
  const open = s.status === "open";
  const canHold = open && s.orderStatus === "to_fill";
  return (
    <article aria-label={s.title} style={{ border: `1px solid ${s.severity === "block" ? "var(--danger)" : C.line}`, borderRadius: 12, padding: 16, background: C.well, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
        <span><strong style={{ fontSize: 15 }}>{s.title}</strong> <span style={{ fontSize: 11, color: C.dimmer, fontFamily: MONO }} title="Rule id">{s.rule}</span></span>
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Pill tone={SEV_TONE[s.severity]}><span className="sr">Severity: </span>{SEV_LABEL[s.severity]}</Pill>
          {s.source === "llm" && <Pill tone="violet">AI note, lower confidence</Pill>}
          <Pill tone="gray">AI advisory, a pharmacist decides</Pill>
        </span>
      </div>
      {showOrder && <span style={{ fontSize: 12, color: C.dimmer, fontFamily: MONO }}>{s.patientName ? `${s.patientName} · ` : ""}{s.patientId} · Rx {s.rxNumber}{s.drug ? ` · ${s.drug}` : ""}</span>}
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>{s.explanation}{s.explainedBy === "ai" && <span style={{ color: C.violet2 }}> (explained by AI, checked by the gate)</span>}</p>
      {s.evidence.length > 0 && <div>
        <div style={{ fontSize: 12, color: C.dimmer, marginBottom: 4 }}>Evidence from the history</div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5, color: C.ink2 }}>
          {s.evidence.map((e, i) => <li key={i}>{e.date && !e.text.startsWith(e.date) ? <span style={{ fontFamily: MONO, color: C.dimmer }}>{e.date} · </span> : null}{e.text}</li>)}
        </ul>
      </div>}
      {!open && <div style={{ fontSize: 13, color: C.dim }}><strong>{DECISION[s.decision ?? s.status] ?? s.status}</strong>{s.decidedBy && s.decidedBy !== "system" ? ` by ${s.decidedBy}` : ""}{s.decisionReason ? `. ${s.decisionReason}` : ""}</div>}
      {open && canDecide && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {mode === "view" && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button disabled={!canHold} onClick={() => setMode("accept")} style={btn("primary", { minHeight: 44 })} title={canHold ? "" : "This order is already being filled"}>Accept: hold the order</button>
              <button disabled={!canHold || change.isPending} onClick={() => change.mutate()} style={btn("ghost", { minHeight: 44 })}>{change.isPending ? "Sending…" : "Send prescriber change request"}</button>
              <button onClick={() => setMode("dismiss")} style={btn("ghost", { minHeight: 44 })}>Dismiss…</button>
            </div>
          )}
          {mode === "accept" && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input aria-label="Note for the hold (optional)" placeholder="Note for the hold (optional)" value={text} onChange={(e) => setText(e.target.value)} style={input({ flex: "1 1 260px", height: 44 })} />
              <button disabled={accept.isPending} onClick={() => accept.mutate()} style={btn("primary", { minHeight: 44 })}>Put order on hold</button>
              <button onClick={() => setMode("view")} style={btn("ghost", { minHeight: 44 })}>Cancel</button>
            </div>
          )}
          {mode === "dismiss" && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input aria-label="Reason for dismissing" placeholder="Why is this not an issue? (required)" value={text} onChange={(e) => setText(e.target.value)} style={input({ flex: "1 1 260px", height: 44 })} />
              <button disabled={text.trim().length < 5 || dismiss.isPending} onClick={() => dismiss.mutate()} style={btn("ghost", { minHeight: 44 })}>Dismiss</button>
              <button onClick={() => setMode("view")} style={btn("ghost", { minHeight: 44 })}>Cancel</button>
            </div>
          )}
          <ErrorBox e={err} />
        </div>
      )}
      {open && !canDecide && <span style={{ fontSize: 12, color: C.dimmer }}>A pharmacist decides. You can read the evidence.</span>}
    </article>
  );
}

/** On Fill & pickup: the open suggestions for the order, with their evidence next to it. */
export function RxSuggestions({ rx, user }: { rx: string; user: User }) {
  const q = useSuggestions(`?rx=${encodeURIComponent(rx)}&status=open`, user.role === "pharmacist" || user.role === "technician");
  const list = q.data?.suggestions ?? [];
  if (!list.length) return null;
  return (
    <section aria-label="Rx Guardian suggestions" style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 22, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Rx Guardian found {list.length} thing{list.length === 1 ? "" : "s"} in this patient's history</h3>
        <Pill tone="amber">AI advisory, a pharmacist decides</Pill>
      </div>
      {list.map((s) => <SuggestionCard key={s.id} s={s} canDecide={q.data?.canDecide ?? false} showOrder={false} />)}
    </section>
  );
}

/** On Today: counts by severity and the top three, with a link to all of them. */
export function SuggestionsCard({ summary }: { summary: SuggestionSummary }) {
  const tone = summary.bySeverity.block ? "var(--danger)" : summary.open ? "var(--warn)" : C.line;
  return (
    <section aria-labelledby="sugg" style={{ background: C.card, border: `1px solid ${tone}`, borderRadius: 14, padding: 22, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <h2 id="sugg" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Rx Guardian suggestions</h2>
        <Link to="/agents?tab=suggestions" style={{ fontSize: 13, textDecoration: "none" }}>See all {summary.open}</Link>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} aria-label="Open suggestions by severity">
        <Pill tone="red">Block {summary.bySeverity.block}</Pill>
        <Pill tone="amber">Needs review {summary.bySeverity.needs_review}</Pill>
        <Pill tone="gray">Monitor {summary.bySeverity.monitor}</Pill>
      </div>
      {summary.top.length === 0 && <p style={{ margin: 0, fontSize: 14, color: C.dim }}>Nothing open. Rx Guardian checks each new or changed order against the patient's history.</p>}
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {summary.top.map((t) => (
          <li key={t.id} style={{ borderTop: `1px solid ${C.line}` }}>
            <Link to={`/fill?rx=${t.rx}`} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "10px 4px", color: C.ink, textDecoration: "none" }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>{t.title}</span>
              <span style={{ fontSize: 12, color: C.dimmer }}>{t.patient ?? t.patientId} · Rx {t.rx}{t.drug ? ` · ${t.drug}` : ""} · {SEV_LABEL[t.severity]}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
