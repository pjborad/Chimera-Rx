/**
 * Review crawl: signs in as each role, visits every screen at two viewports and reports console errors/warnings,
 * failed requests, horizontal overflow, the persistent demo notice and role leaks. Screenshots go to SHOTS.
 * Usage: BASE=http://localhost:5510 SHOTS=/tmp/shots node scripts/e2e/crawl.mjs   (the API must run with MFA unset or MFA=1)
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE ?? "http://localhost:5173";
const SHOTS = process.env.SHOTS ?? "/tmp/lg-crawl";
fs.mkdirSync(SHOTS, { recursive: true });
const PW = "moonlight-rx-2026";
const NOTICE = "Demo environment · synthetic data only · not for clinical use · not HIPAA-compliant · a pharmacist approves every message";
const ROUTES = ["/", "/receiving", "/inventory", "/fill", "/register", "/patients", "/recalls", "/refills", "/dscsa", "/agents", "/stock", "/transfers", "/integrations", "/outbox"];
const ACCOUNTS = [
  ["store-7", "j.rivera@elmstreetrx.example"], ["store-7", "k.patel@elmstreetrx.example"], ["store-7", "m.diaz@elmstreetrx.example"], ["store-7", "s.grant@elmstreetrx.example"],
  ["store-2", "s.okoro@birchavenuerx.example"]
];
const browser = await chromium.launch();
const out = [];
for (const [storeId, email] of ACCOUNTS) {
  for (const vp of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }]) {
    const ctx = await browser.newContext({ viewport: vp });
    const r = await ctx.request.post(`${BASE}/api/auth/login`, { data: { storeId, email, password: PW, trusted: true } });
    let j = await r.json().catch(() => ({}));
    if (j.mfaRequired) {
      const c = await (await ctx.request.get(`${BASE}/api/auth/demo-code/${j.challenge}`)).json();
      const v = await ctx.request.post(`${BASE}/api/auth/verify`, { data: { challenge: j.challenge, code: c.code } });
      j = v.ok() ? {} : { err: v.status() };
    }
    if (!r.ok() || j.err) { out.push({ email, vp: vp.width, fatal: `login ${r.status()} ${JSON.stringify(j).slice(0, 120)}` }); await ctx.close(); continue; }
    const page = await ctx.newPage();
    const logs = [];
    page.on("console", (m) => { if (["error", "warning"].includes(m.type())) logs.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
    page.on("pageerror", (e) => logs.push("pageerror: " + e.message));
    page.on("response", (res) => { if (res.status() >= 400) logs.push(`http ${res.status()} ${res.request().method()} ${new URL(res.url()).pathname}`); });
    for (const route of ROUTES) {
      logs.length = 0;
      await page.goto(`${BASE}/#${route}`);
      await page.waitForTimeout(1500);
      const info = await page.evaluate((notice) => {
        const t = document.body.innerText;
        const over = [];
        document.querySelectorAll("main *").forEach((el) => { if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === "visible" && el.clientWidth > 0 && el.children.length === 0) over.push(el.tagName + ":" + (el.textContent || "").slice(0, 40)); });
        return { notice: t.includes(notice), hscroll: document.documentElement.scrollWidth > window.innerWidth + 2, over: over.slice(0, 3), loading: /Loading…/.test(t), dob: /\bDOB\b|Date of birth|allerg/i.test(t), h1: (document.querySelector("h1,h2")?.textContent ?? "").slice(0, 40), url: location.hash };
      }, NOTICE);
      const tag = `${email.split("@")[0]}-${vp.width}-${route === "/" ? "today" : route.slice(1)}`;
      await page.screenshot({ path: path.join(SHOTS, tag + ".png"), fullPage: false });
      out.push({ email: email.split("@")[0], vp: vp.width, route, ...info, logs: [...new Set(logs)] });
    }
    await ctx.close();
  }
}
await browser.close();
for (const o of out) {
  if (o.fatal) { console.log("FATAL", o.email, o.vp, o.fatal); continue; }
  const bad = !o.notice || o.hscroll || o.over.length || o.loading || o.logs.length;
  if (bad) console.log(`${o.email} ${o.vp} ${o.route} -> ${o.url} notice=${o.notice} hscroll=${o.hscroll} over=${JSON.stringify(o.over)} loading=${o.loading} dobOrAllergy=${o.dob}\n   ${o.logs.join("\n   ")}`);
}
fs.writeFileSync(path.join(SHOTS, "crawl.json"), JSON.stringify(out, null, 1));
console.log("done", out.length);
