/**
 * Core of the voiced-video recorder: browser, overlay (cursor, lower-third caption, click ring), screencast capture,
 * step timing and the composer that makes the picture follow the audio. Synthetic data only.
 *
 * Timing model: the narration is synthesised first (make-voice.py -> timeline.json). Each recorded step is tied to a
 * narration unit and starts on the screen when that unit starts. A step is recorded at its natural speed; the composer
 * then maps it onto the unit's audio window: faster than the window means a hold on the last frame, slower means the
 * step is sped up (setpts-style frame skipping). Waits that are not interesting (role switch, OCR, reseeding) run inside
 * cutWait() and are removed from the picture. The voice is never stretched and never padded.
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const BASE = "http://localhost:4690";
export const CONTROL = "http://127.0.0.1:4691";
export const PW = "moonlight-rx-2026";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const require = createRequire(path.join(ROOT, "apps/api/package.json"));
const bwip = require("bwip-js");

export const FAKE_CAM = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 1280; canvas.height = 720;
  const g = canvas.getContext("2d");
  let img = null, text = null;
  const draw = () => {
    g.fillStyle = "#6b6a66"; g.fillRect(0, 0, 1280, 720);
    if (img) { g.save(); g.translate(640, 360); g.rotate(-0.05); g.drawImage(img, -230, -230, 460, 460); g.restore(); }
    if (text) {
      g.fillStyle = "#fff"; g.fillRect(140, 120, 1000, 480);
      g.fillStyle = "#000"; g.font = "bold 44px Arial"; g.textBaseline = "top";
      text.forEach((line, i) => g.fillText(line, 180, 160 + i * 70));
    }
    requestAnimationFrame(draw);
  };
  draw();
  window.__hold = (url) => { text = null; const i = new Image(); i.onload = () => { img = i; }; i.src = url; };
  window.__holdText = (lines) => { img = null; text = lines; };
  window.__lower = () => { img = null; text = null; };
  const stream = canvas.captureStream(30);
  navigator.mediaDevices.getUserMedia = async () => stream;
};

/** Cursor dot, lower-third (screen and role) and click ring, injected into every document. Not product code. */
export const OVERLAY = () => {
  const make = () => {
    if (!document.body || document.getElementById("__cur")) return;
    const dot = document.createElement("div"); dot.id = "__cur";
    dot.style.cssText = "position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(108,76,255,.35);border:2px solid #6c4cff;z-index:2147483647;pointer-events:none";
    const lt = document.createElement("div"); lt.id = "__lt";
    lt.style.cssText = "position:fixed;left:28px;bottom:26px;max-width:900px;padding:8px 16px;border-radius:9px;background:rgba(20,18,31,.86);color:#fff;font:600 17px/1.3 system-ui,sans-serif;z-index:2147483646;pointer-events:none;display:none;border-left:5px solid #6c4cff";
    document.body.append(dot, lt);
    const t = sessionStorage.getItem("__lt"); if (t) { lt.innerHTML = t; lt.style.display = "block"; }
    const pos = sessionStorage.getItem("__pos"); if (pos) { const [x, y] = pos.split(","); dot.style.transform = `translate(${x}px,${y}px)`; }
  };
  window.addEventListener("mousemove", (e) => { make(); const d = document.getElementById("__cur"); if (d) d.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; sessionStorage.setItem("__pos", `${e.clientX},${e.clientY}`); }, true);
  document.addEventListener("DOMContentLoaded", make); if (document.readyState !== "loading") make();
  window.__lt = (html) => { make(); sessionStorage.setItem("__lt", html); const b = document.getElementById("__lt"); if (b) { b.innerHTML = html; b.style.display = html ? "block" : "none"; } };
  // Highlight ring: tied to its element (rect recomputed every frame), at most 700 ms, never kept across page loads,
  // and removed on scroll, resize, route change and by __clearRings() before every step, card and navigation.
  window.__clearRings = () => { document.querySelectorAll(".__ring").forEach((n) => n.remove()); };
  window.__ring = (node) => {
    make(); window.__clearRings();
    if (!node || !document.body) return;
    const r = document.createElement("div"); r.className = "__ring";
    r.style.cssText = "position:fixed;border:3px solid #ffb020;border-radius:10px;box-shadow:0 0 0 4px rgba(255,176,32,.28);z-index:2147483644;pointer-events:none;transition:opacity .25s";
    document.body.append(r);
    const t0 = performance.now();
    const tick = () => {
      if (!r.isConnected) return;
      const b = node.isConnected ? node.getBoundingClientRect() : null, age = performance.now() - t0;
      if (!b || b.width < 2 || b.height < 2 || age > 700) { r.remove(); return; }
      r.style.left = `${b.left - 6}px`; r.style.top = `${b.top - 6}px`; r.style.width = `${b.width + 12}px`; r.style.height = `${b.height + 12}px`;
      if (age > 450) r.style.opacity = "0";
      requestAnimationFrame(tick);
    };
    tick();
  };
  for (const ev of ["scroll", "resize", "hashchange", "popstate", "pagehide"]) window.addEventListener(ev, () => window.__clearRings?.(), true);
};

export const gs1 = (l, withSerial = true) => `(01)${l.gtin}(17)${l.expiry.replace(/-/g, "").slice(2, 8)}(10)${l.lot}${withSerial ? `(21)${l.serial}` : ""}`;
export const dmPng = async (text) => (await bwip.toBuffer({ bcid: "gs1datamatrix", text, scale: 6, padding: 10, backgroundcolor: "FFFFFF" })).toString("base64");

export class Recorder {
  constructor(mode) {
    this.mode = mode;
    this.work = path.join(ROOT, "demo-video/work", mode);
    this.frameDir = path.join(this.work, "frames");
    this.steps = []; // { seg, u, name, t0, t1, cuts: [[a,b]], ok, error }
    this.shots = []; // { t, file }
    this.cuts = []; this.failed = [];
    this.cx = 960; this.cy = 540;
  }

  async start() {
    fs.rmSync(this.frameDir, { recursive: true, force: true });
    fs.mkdirSync(this.frameDir, { recursive: true });
    this.browser = await chromium.launch();
    this.ctx = await this.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await this.ctx.addInitScript(FAKE_CAM);
    await this.ctx.addInitScript(OVERLAY);
    this.page = await this.ctx.newPage();
    this.page.on("pageerror", (e) => console.log("  pageerror:", e.message));
    this.ctl = await this.browser.newContext();
    await this.page.goto(`${BASE}/`);
    await this.page.waitForSelector("form", { timeout: 20000 });
    this.cdp = await this.ctx.newCDPSession(this.page);
    let n = 0;
    this.cdp.on("Page.screencastFrame", (f) => {
      const file = path.join(this.frameDir, `f${String(n++).padStart(6, "0")}.jpg`);
      fs.writeFileSync(file, Buffer.from(f.data, "base64"));
      this.shots.push({ t: f.metadata.timestamp, file });
      this.cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 82, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
    await sleep(400);
  }
  async stop() {
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    await sleep(300);
    await this.browser.close();
  }
  now() { return Date.now() / 1000; }

  // ---- control (not recorded: used inside cutWait) ----------------------------------------------------------------
  async control(method, p) { const r = await fetch(`${CONTROL}${p}`, { method }); if (!r.ok) throw new Error(`control ${p} ${r.status}`); return r.json(); }
  async apiLogin(who, { storeId = "store-7", domain = "elmstreetrx.example", ctx = this.ctx } = {}) {
    const r = await ctx.request.post(`${BASE}/api/auth/login`, { data: { storeId, email: `${who}@${domain}`, password: PW, trusted: true } });
    if (!r.ok()) throw new Error("login failed " + r.status());
    const j = await r.json();
    if (j.mfaRequired) {
      const c = await (await ctx.request.get(`${BASE}/api/auth/demo-code/${j.challenge}`)).json();
      const v = await ctx.request.post(`${BASE}/api/auth/verify`, { data: { challenge: j.challenge, code: c.code } });
      if (!v.ok()) throw new Error("mfa verify failed");
    }
  }
  async api(method, url, data) {
    const r = await this.ctx.request.fetch(`${BASE}${url}`, { method, data: data ?? undefined });
    return r.ok() ? r.json().catch(() => ({})) : { error: r.status(), body: await r.text() };
  }
  /** Run something off camera: the time is removed from the picture. */
  async cutWait(fn) {
    const a = this.now();
    try { return await fn(); } finally { this.cuts.push([a, this.now()]); this.cur?.cuts.push([a, this.now()]); }
  }
  /** Switch the browser to another signed-in user, off camera. */
  async asUser(who, opts = {}) {
    await this.cutWait(async () => { await this.apiLogin(who, opts); await this.page.goto(`${BASE}/#/`); await this.page.reload(); await this.page.waitForSelector("nav[aria-label='Main']", { timeout: 15000 }); await this.lt(this.ltText); });
  }
  async labels() { this._labels ??= (await this.control("GET", "/labels")).labels; return this._labels; }

  // ---- on-camera primitives ------------------------------------------------------------------------------------------
  /** Remove every highlight ring and wait until a frame without one has been captured. */
  async clearRings(settle = 160) { await this.page.evaluate(() => window.__clearRings?.()).catch(() => {}); if (settle) await sleep(settle); }
  async lt(html) { this.ltText = html; await this.page.evaluate((h) => window.__lt?.(h), html).catch(() => {}); }
  async go(route, waitFor) {
    await this.clearRings(0);
    await this.page.goto(`${BASE}/#${route}`);
    if (waitFor) await this.page.waitForSelector(waitFor, { timeout: 20000 });
    await this.page.waitForTimeout(500);
  }
  async moveTo(x, y) {
    const n = 22; // round 7: glide about 450 ms
    const x0 = this.cx, y0 = this.cy;
    for (let i = 1; i <= n; i++) { const t = i / n, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; await this.page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e); await sleep(20); }
    this.cx = x; this.cy = y; await sleep(80);
  }
  async click(loc, { ring = true } = {}) {
    const el = typeof loc === "string" ? this.page.locator(loc).first() : loc.first();
    await el.waitFor({ timeout: 15000 });
    await el.scrollIntoViewIfNeeded().catch(() => {});
    const b = await el.boundingBox();
    if (b) {
      await this.moveTo(b.x + b.width / 2, b.y + b.height / 2);
      if (ring) await el.evaluate((n) => window.__ring?.(n)).catch(() => {});
    }
    await sleep(150);
    await el.click();
    await sleep(700); // round 7: about 0.7 s after a click
  }
  async type(loc, text) {
    const el = typeof loc === "string" ? this.page.locator(loc).first() : loc.first();
    await this.click(el, { ring: false });
    await el.pressSequentially(text, { delay: 28 });
  }
  async point(loc) { const el = typeof loc === "string" ? this.page.locator(loc).first() : loc.first(); const b = await el.boundingBox(); if (b) await this.moveTo(b.x + b.width / 2, b.y + b.height / 2); }
  async scrollTo(loc) { const el = typeof loc === "string" ? this.page.locator(loc).first() : loc.first(); await this.clearRings(0); await el.scrollIntoViewIfNeeded().catch(() => {}); await sleep(250); }
  async hold(ms) { await sleep(ms); }
  async hasText(t, timeout = 8000) { return this.page.getByText(t).first().waitFor({ timeout }).then(() => true, () => false); }

  /** Run one narrated step. A failing step is logged and the recording goes on. */
  async step(seg, u, name, fn) {
    await this.clearRings();
    const s = { seg, u, name, t0: this.now(), t1: 0, cuts: [], ok: true };
    this.cur = s;
    try { await fn(); } catch (e) { s.ok = false; s.error = String(e).split("\n")[0]; this.failed.push(`${seg}#${u} ${name}: ${s.error}`); console.log("  FAIL", seg, u, name, s.error); await this.page.screenshot({ path: path.join(this.work, `fail-${seg}-${u}.png`) }).catch(() => {}); }
    await this.clearRings(); // the last frame of a step is held or sped past: it must not carry a ring into the next scene
    s.t1 = this.now(); this.steps.push(s); this.cur = null;
    console.log(`  ${s.ok ? "ok  " : "FAIL"} ${seg}#${u} ${name} ${(s.t1 - s.t0).toFixed(1)}s`);
  }

  // ---- composer ------------------------------------------------------------------------------------------------------
  /** Wall time at natural-progress p seconds into a step (cut windows skipped). */
  static wallAt(step, p) {
    let t = step.t0; let left = p;
    const cuts = [...step.cuts].sort((a, b) => a[0] - b[0]);
    for (const [a, b] of cuts) {
      if (t < a) { const seg = a - t; if (left <= seg) return t + left; left -= seg; }
      t = Math.max(t, b);
    }
    return t + left;
  }
  static natural(step) { return step.t1 - step.t0 - step.cuts.reduce((n, [a, b]) => n + (b - a), 0); }

  /** Build the picture: one frame list at 25 fps whose time axis is the audio time axis. */
  compose(timeline, fps = 25) {
    const bySeg = new Map(timeline.segments.map((s) => [s.id, s]));
    const plan = []; // { a, b, step } audio-time windows
    const steps = this.steps;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i], seg = bySeg.get(s.seg);
      const a = seg.units[s.u]?.start ?? seg.start;
      const nx = steps[i + 1];
      let b;
      if (nx && nx.seg === s.seg) b = seg.units[nx.u]?.start ?? seg.end;
      else b = nx ? (bySeg.get(nx.seg).start) : timeline.seconds;
      plan.push({ a, b: Math.max(b, a + 0.2), step: s });
    }
    const total = timeline.seconds;
    const frames = Math.round(total * fps);
    const shots = this.shots.slice().sort((x, y) => x.t - y.t);
    let si = 0, pi = 0;
    const out = []; // source file per output frame
    const speeds = [];
    for (const w of plan) speeds.push({ seg: w.step.seg, u: w.step.u, name: w.step.name, speed: +(Recorder.natural(w.step) / (w.b - w.a)).toFixed(2) });
    for (let n = 0; n < frames; n++) {
      const t = n / fps;
      while (pi < plan.length - 1 && t >= plan[pi + 1].a) pi++;
      const w = plan[pi];
      let wall;
      if (t < w.a) wall = w.step.t0;
      else {
        const nat = Recorder.natural(w.step), win = w.b - w.a;
        const p = nat > win ? (t - w.a) * (nat / win) : Math.min(t - w.a, nat);
        wall = Recorder.wallAt(w.step, p);
      }
      while (si < shots.length - 1 && shots[si + 1].t <= wall) si++;
      out.push(shots[si].file);
    }
    return { out, speeds };
  }

  encode(timeline, mux, outFile, fps = 25) {
    const { out, speeds } = this.compose(timeline, fps);
    const list = path.join(this.work, "frames.txt");
    const lines = []; let i = 0;
    while (i < out.length) { let j = i; while (j + 1 < out.length && out[j + 1] === out[i]) j++; lines.push(`file '${out[i]}'`, `duration ${((j - i + 1) / fps).toFixed(4)}`); i = j + 1; }
    lines.push(`file '${out[out.length - 1]}'`);
    fs.writeFileSync(list, lines.join("\n"));
    const silent = path.join(this.work, "picture.mp4");
    execFileSync(mux.ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", `fps=${fps},scale=1920:1080:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart", silent], { stdio: "inherit" });
    execFileSync(mux.ffmpeg, ["-y", "-loglevel", "error", "-i", silent, "-i", path.join(this.work, "voice.wav"), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", String(timeline.seconds), "-movflags", "+faststart", outFile], { stdio: "inherit" });
    return speeds;
  }
}
