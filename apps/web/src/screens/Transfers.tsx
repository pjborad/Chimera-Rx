import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, msg, post, type User } from "../lib/api";
import { btn, C, ErrorBox, Footer, input, MONO, Pill } from "../components/kit";
import { mainStyle, PageHeader } from "../components/Shell";

/** Move on-shelf packages to the other store (FR4.3). Each package keeps its lot and serial; recalled stock is refused. */
export function Transfers({ user }: { user: User }) {
  const qc = useQueryClient();
  const stores = useQuery({ queryKey: ["stores"], queryFn: () => get<{ me: string; others: { id: string; name: string }[] }>("/api/stores") });
  const lots = useQuery({ queryKey: ["lots", "transfer"], queryFn: () => get<{ rows: any[] }>("/api/lots") });
  const [lotId, setLotId] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [to, setTo] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ moved: number; lot: string; product: string; to: string; serials: string[] } | null>(null);
  const target = to || stores.data?.others[0]?.id || "";
  // One id per move: a double click or a retry after an error repeats the same transfer instead of starting a second one.
  const transferId = useRef<string>(crypto.randomUUID());
  const list = useQuery({ queryKey: ["transfers"], queryFn: () => get<{ transfers: { id: string; state: string; to: string; product: string; lot: string; units: number; incomplete: boolean; error: string | null }[] }>("/api/transfers"), enabled: user.role === "pharmacist" });
  const move = useMutation({
    mutationFn: () => post<NonNullable<typeof done>>("/api/transfers", { toStore: target, lotId, qty, transferId: transferId.current }),
    onSuccess: (r) => { setDone(r); setErr(""); transferId.current = crypto.randomUUID(); void qc.invalidateQueries({ queryKey: ["lots"] }); void qc.invalidateQueries({ queryKey: ["transfers"] }); },
    onError: (e) => { setErr(msg(e)); void qc.invalidateQueries({ queryKey: ["transfers"] }); }
  });
  const recover = useMutation({
    mutationFn: () => post<{ completed: string[]; cancelled: string[]; failed: { id: string; error: string }[] }>("/api/transfers/recover", {}),
    onSuccess: () => { setErr(""); void qc.invalidateQueries({ queryKey: ["transfers"] }); void qc.invalidateQueries({ queryKey: ["lots"] }); },
    onError: (e) => setErr(msg(e))
  });
  const incomplete = (list.data?.transfers ?? []).filter((t) => t.incomplete);
  const rows = (lots.data?.rows ?? []).filter((l) => l.status !== "recall" && l.onHand > 0);
  const chosen = rows.find((l) => l.id === lotId);
  return (
    <>
      <PageHeader title="Transfers" sub="Move stock to the other store. Each package keeps its lot and serial." />
      <main style={mainStyle()}>
        {user.role !== "pharmacist" || !stores.data?.others.length ? (
          <p style={{ color: C.dim }}>Only a pharmacist can move stock, and only when a second store is set up.</p>
        ) : (
          <section style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 22, display: "flex", flexDirection: "column", gap: 14 }}>
            <label htmlFor="to" style={{ fontSize: 13, color: C.dim }}>Move to</label>
            <select id="to" value={target} onChange={(e) => setTo(e.target.value)} style={input()}>{stores.data.others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            <label htmlFor="lot" style={{ fontSize: 13, color: C.dim }}>Lot</label>
            <select id="lot" value={lotId ?? ""} onChange={(e) => { setLotId(Number(e.target.value) || null); setQty(1); }} style={input()}>
              <option value="">Choose a lot</option>
              {rows.map((l) => <option key={l.id} value={l.id}>{l.name} · lot {l.lot} · {l.onHand} on hand</option>)}
            </select>
            <label htmlFor="qty" style={{ fontSize: 13, color: C.dim }}>How many packages</label>
            <input id="qty" type="number" min={1} max={chosen?.onHand ?? 1} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} style={input({ maxWidth: 140 })} />
            <ErrorBox e={err} />
            <button disabled={!lotId || move.isPending} onClick={() => move.mutate()} style={btn("primary", { minHeight: 48, alignSelf: "flex-start" })}>{move.isPending ? "Moving…" : "Move stock"}</button>
            <span style={{ fontSize: 12, color: C.dimmer }}>Recalled or quarantined lots cannot be moved, and a lot recalled in either store is refused. Every move is written to both stores' audit logs.</span>
          </section>
        )}
        {done && (
          <section role="status" style={{ background: C.card, border: `1px solid ${C.ink2}`, borderRadius: 14, padding: 22, display: "flex", flexDirection: "column", gap: 8 }}>
            <strong>Moved {done.moved} × {done.product} (lot {done.lot}) to {done.to}.</strong>
            <span style={{ fontFamily: MONO, fontSize: 12, color: C.dimmer }}>Serials: {done.serials.join(", ")}</span>
            <Pill tone="green">Recorded in both audit logs</Pill>
          </section>
        )}
        {user.role === "pharmacist" && (list.data?.transfers.length ?? 0) > 0 && (
          <section aria-label="Recent transfers" style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 22, display: "flex", flexDirection: "column", gap: 10 }}>
            <strong>Recent transfers</strong>
            <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ textAlign: "left", color: C.dim }}><th>Product</th><th>Lot</th><th>Units</th><th>To</th><th>Status</th></tr></thead>
              <tbody>
                {list.data!.transfers.map((t) => (
                  <tr key={t.id}><td>{t.product}</td><td style={{ fontFamily: MONO }}>{t.lot}</td><td>{t.units}</td><td>{t.to}</td>
                    <td>{t.incomplete ? <Pill tone="amber">Not finished ({t.state})</Pill> : t.state === "completed" ? <Pill tone="green">Completed</Pill> : <Pill tone="amber">{t.state}</Pill>}</td></tr>
                ))}
              </tbody>
            </table>
            {incomplete.length > 0 && (
              <>
                <span style={{ fontSize: 12, color: C.dimmer }}>A move that stopped half way keeps its packages "in transit": they are not on the shelf in either store. Recover finishes it if the other store has the stock, or puts the packages back.</span>
                <button disabled={recover.isPending} onClick={() => recover.mutate()} style={btn("primary", { minHeight: 44, alignSelf: "flex-start" })}>{recover.isPending ? "Recovering…" : "Recover"}</button>
              </>
            )}
          </section>
        )}
        <Footer />
      </main>
    </>
  );
}
