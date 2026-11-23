/** Helpers shared by the silent-video recorder (record-silent.mjs). Synthetic data only. */
import fs from "node:fs";

export const NOTICE = "Demo environment · synthetic data only · not for clinical use · not HIPAA-compliant · a pharmacist approves every message";
export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export const first = (text, n = 9) => text.replace(/\[pause\]/g, "").replace(/\s+/g, " ").trim().split(" ").slice(0, n).join(" ");

/** Spoken paragraphs of DEMO_FULL.md, by section id (A, B1..B10, C, D, E, F, G, H). Spoken text is the blockquote lines. */
export function parseFull(file) {
  const out = {};
  let id = null, para = null;
  const flush = () => { if (id && para && para.trim()) out[id].push(para.trim()); para = null; };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const h = line.match(/^#{2,3} ([A-H]\d*)\. /);
    if (h) { flush(); id = h[1]; out[id] ??= []; continue; }
    if (/^#{1,3} /.test(line)) { flush(); id = null; continue; }
    if (!id) continue;
    if (line.startsWith(">")) { const t = line.replace(/^>\s?/, ""); if (!t.trim()) flush(); else para = (para ? para + " " : "") + t; }
    else flush();
  }
  flush();
  return out;
}
export const words = (arr) => arr.reduce((n, p) => n + p.replace(/\[pause\]/g, "").split(/\s+/).filter(Boolean).length, 0);

/** Beats of DEMO_CUT3.md: array indexed 1..8, each an array of sentences. */
export function parseCut(file) {
  const out = {};
  let n = 0, inq = false;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const h = line.match(/^### Beat (\d)\./);
    if (h) { n = Number(h[1]); out[n] = ""; inq = false; continue; }
    if (/^## /.test(line)) { n = 0; continue; }
    if (n && line.startsWith(">")) out[n] += " " + line.replace(/^>\s?/, "");
  }
  for (const k of Object.keys(out)) out[k] = out[k].replace(/\[pause\]/g, "").trim().split(/(?<=[.?!])\s+/).filter(Boolean);
  return out;
}

export function terminalHtml(title, body) {
  return `<!doctype html><meta charset=utf-8><title>${title}</title><style>
body{margin:0;background:#14121f;color:#e8e6f5;font:14px/1.45 ui-monospace,Menlo,monospace}
.n{background:#fff7e6;color:#a15c00;text-align:center;font:12px/27px system-ui,sans-serif;border-bottom:1px solid #f0dcb4}
h1{font:600 20px system-ui,sans-serif;margin:22px 40px 8px}pre{margin:0 40px;white-space:pre-wrap;word-break:break-word}.c{color:#9d8bff}.g{color:#7ee0a5}
footer{position:fixed;left:40px;bottom:80px;font:12px system-ui,sans-serif;color:#9a97b3}</style>
<div class=n>${NOTICE}</div><h1>${title}</h1><pre>${body}</pre><footer>${NOTICE}</footer>`;
}

/**
 * Cursor dot, caption bar, section progress bar and click highlight ring, injected into every document.
 * State survives page loads through sessionStorage. Nothing here is product code.
 */
export function OVERLAY() {
  const make = () => {
    if (!document.body || document.getElementById("__cur")) return;
    const dot = document.createElement("div"); dot.id = "__cur";
    dot.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(108,76,255,.35);border:2px solid #6c4cff;z-index:2147483647;pointer-events:none";
    const bar = document.createElement("div"); bar.id = "__capbar";
    bar.style.cssText = "position:fixed;left:50%;bottom:34px;transform:translateX(-50%);max-width:1100px;padding:9px 22px;border-radius:10px;background:rgba(20,18,31,.84);color:#fff;font:500 17px/1.3 system-ui,sans-serif;z-index:2147483646;pointer-events:none;text-align:center";
    const prog = document.createElement("div"); prog.id = "__prog";
    prog.style.cssText = "position:fixed;left:0;right:0;bottom:0;height:22px;z-index:2147483645;pointer-events:none;display:none;background:rgba(20,18,31,.88);font:600 11px/22px system-ui,sans-serif;color:#cfc9ff";
    const note = document.createElement("div"); note.id = "__note";
    note.textContent = "Demo environment · synthetic data only · not for clinical use · not HIPAA-compliant · a pharmacist approves every message";
    note.style.cssText = "position:fixed;left:0;right:0;top:0;height:27px;background:#fff7e6;color:#a15c00;border-bottom:1px solid #f0dcb4;text-align:center;font:12px/27px system-ui,sans-serif;z-index:2147483640;pointer-events:none";
    document.body.append(note, dot, bar, prog);
    const t = sessionStorage.getItem("__cap"); bar.textContent = t || ""; bar.style.display = t ? "block" : "none";
    const pos = sessionStorage.getItem("__pos"); if (pos) { const [x, y] = pos.split(","); dot.style.transform = `translate(${x}px,${y}px)`; }
    render();
  };
  const render = () => {
    const prog = document.getElementById("__prog"); if (!prog) return;
    const s = sessionStorage.getItem("__sec"); if (!s) { prog.style.display = "none"; return; }
    const { letters, idx, label } = JSON.parse(s);
    prog.style.display = "flex";
    prog.innerHTML = letters.map((l, i) => `<span style="flex:1;text-align:center;border-right:1px solid rgba(255,255,255,.12);${i < idx ? "background:#4a3bb0;color:#fff" : i === idx ? "background:#6c4cff;color:#fff" : ""}">${l}</span>`).join("") + `<span style="padding:0 14px;color:#fff;white-space:nowrap">${label}</span>`;
  };
  window.addEventListener("mousemove", (e) => { make(); const d = document.getElementById("__cur"); if (d) d.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; sessionStorage.setItem("__pos", `${e.clientX},${e.clientY}`); }, true);
  document.addEventListener("DOMContentLoaded", make); if (document.readyState !== "loading") make();
  window.__cap = (t) => { make(); sessionStorage.setItem("__cap", t); const b = document.getElementById("__capbar"); if (b) { b.textContent = t; b.style.display = "block"; } };
  window.__sec = (letters, idx, label) => { make(); sessionStorage.setItem("__sec", JSON.stringify({ letters, idx, label })); render(); };
  window.__ring = (x, y, w, h) => {
    make();
    const r = document.createElement("div");
    r.style.cssText = `position:fixed;left:${x - 5}px;top:${y - 5}px;width:${w + 10}px;height:${h + 10}px;border:3px solid #ffb020;border-radius:10px;box-shadow:0 0 0 4px rgba(255,176,32,.28);z-index:2147483644;pointer-events:none;transition:opacity .35s`;
    document.body.append(r);
    setTimeout(() => { r.style.opacity = "0"; }, 850); setTimeout(() => r.remove(), 1250);
  };
  window.__capOff = () => { sessionStorage.removeItem("__cap"); sessionStorage.removeItem("__sec"); document.getElementById("__capbar")?.remove(); document.getElementById("__cur")?.remove(); document.getElementById("__prog")?.remove(); };
}
