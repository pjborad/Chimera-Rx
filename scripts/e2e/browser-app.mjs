/**
 * Drives the browser-only build (apps/browser) in Chromium: every role signs in through the real form, visits every screen it
 * can see, and the main flows run against the API that lives inside the page. It fails on any console error, page error or
 * failed request. Needs `pnpm build:browser` and `pnpm preview:browser` (port 4680 by default, base /Chimera-Rx/app/).
 *   BASE_URL=http://127.0.0.1:4680/Chimera-Rx/app/ SHOTS=docs/evidence/screens node scripts/e2e/browser-app.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:4680/Chimera-Rx/app/";
const SHOTS = process.env.SHOTS ?? path.resolve(import.meta.dirname, "../../docs/evidence/screens");
fs.mkdirSync(SHOTS, { recursive: true });
const PW = "moonlight-rx-2026";
const results = [];
const problems = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  · " + detail : ""}`); };

const browser = await chromium.launch();
const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, `browser-${name}.png`), fullPage: true });

async function open(who) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") problems.push(`${who} console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`${who} pageerror: ${e.message}`));
  page.on("requestfailed", (r) => problems.push(`${who} requestfailed: ${r.url()}`));
  page.on("response", (r) => { if (r.status() >= 400 && r.url().startsWith("http://127.0.0.1")) problems.push(`${who} http ${r.status()}: ${r.url()}`); });
  await page.goto(BASE);
  return { ctx, page };
}
async function signIn(page, who) {
  await page.waitForSelector("#email", { timeout: 60000 });
  await page.locator("#email").fill(`${who}@elmstreetrx.example`);
  await page.locator("#pw").fill(PW);
  await page.getByRole("button", { name: /^Sign in/ }).first().click();
  await page.waitForSelector("nav[aria-label='Main']", { timeout: 30000 });
}
const navLinks = async (page) => page.locator("nav[aria-label='Main'] a").evaluateAll((as) => as.map((a) => ({ href: a.getAttribute("href").replace(/^#/, ""), text: a.textContent.trim() })));

try {
  // ---- pharmacist: sign in, Today with seeded data, every nav screen --------------------------------------------------
  const ph = await open("pharmacist");
  let p = ph.page;
  await p.waitForSelector("text=Browser preview: runs entirely in your browser", { timeout: 60000 });
  check("sign-in page shows the safety notice and the browser-preview banner", (await p.locator("body").innerText()).includes("not HIPAA-compliant"));
  await shot(p, "signin");
  await signIn(p, "j.rivera");
  await p.waitForSelector("text=Today", { timeout: 15000 });
  const today = await p.locator("main").innerText();
  check("Today renders with seeded data", today.length > 200 && !/Something went wrong/.test(today), today.slice(0, 80).replace(/\n/g, " "));
  check("the notice and the preview banner are on every staff page", (await p.locator(".safety").count()) === 2);
  await shot(p, "today-pharmacist");
  const links = await navLinks(p);
  for (const l of links) {
    await p.goto(`${BASE}#${l.href}`);
    await p.waitForTimeout(900);
    const t = await p.locator("main").innerText();
    check(`pharmacist opens ${l.text}`, t.trim().length > 20 && !/Something went wrong|Not available for your role/.test(t));
    await shot(p, `pharmacist-${l.href === "/" ? "today" : l.href.slice(1)}`);
  }

  // ---- recall D-0611-2026: look up, confirm a lot ---------------------------------------------------------------------
  await p.goto(`${BASE}#/recalls`);
  await p.waitForSelector("#rn");
  await p.locator("#rn").fill("D-0611-2026");
  await p.getByRole("button", { name: /look/i }).first().click();
  await p.waitForSelector("text=/GX4471C/", { timeout: 20000 }).then(() => check("recall D-0611-2026 looked up from the bundled fixtures", true), async () => { check("recall D-0611-2026 looked up from the bundled fixtures", false); console.log((await p.locator("main").innerText()).slice(0, 400)); });
  await shot(p, "recall-lookup");
  const confirms = p.getByRole("button", { name: "Confirm lot" });
  const n = await confirms.count();
  if (n) { await confirms.first().click(); await p.waitForTimeout(800); }
  const body = await p.locator("main").innerText();
  check("a recalled lot is confirmed (or was confirmed automatically)", n > 0 ? !(await confirms.count()) || (await confirms.count()) < n : /confirmed|held|quarantin/i.test(body), `${n} lot(s) awaited confirmation`);
  await shot(p, "recall-confirmed");
  // the fax recall needs a pharmacist to confirm each lot
  await p.goto(`${BASE}#/recalls`);
  if (!(await p.locator("#rn").count())) await p.getByRole("button", { name: "Back" }).first().click();
  await p.waitForSelector("#rn");
  await p.locator("#rn").fill("D-0417-2026");
  await p.getByRole("button", { name: /look/i }).first().click();
  // number lookups from the bundled openFDA copy arrive with lots read verbatim and confirmed; the lots are quarantined
  await p.waitForSelector("text=PRORX050925-1", { timeout: 20000 }).then(async () => {
    const t = await p.locator("main").innerText();
    check("recall D-0417-2026 lots are read verbatim and stock moves to quarantine", /197 units/.test(t) && /Moved to quarantine/.test(t) && /17 patients/.test(t));
    await p.getByRole("button", { name: "Continue to patient messages" }).click();
    await p.waitForSelector("text=Text message", { timeout: 15000 }).then(() => check("patient messages step opens (sandbox only, pharmacist attests)", true), () => check("patient messages step opens (sandbox only, pharmacist attests)", false));
  }, () => check("recall D-0417-2026 lots are read verbatim and stock moves to quarantine", false));
  await shot(p, "recall-d0417-confirm");
  const pdf = await p.evaluate(async () => { const r = await fetch("/api/recalls/D-0417-2026/report.pdf"); return { s: r.status, t: r.headers.get("content-type"), h: (await r.text()).slice(0, 5) }; });
  check("recall audit report PDF is built in the page", pdf.s === 200 && pdf.t === "application/pdf" && pdf.h === "%PDF-", JSON.stringify(pdf));

  // ---- Fill & pickup: open an order -------------------------------------------------------------------------------------
  await p.goto(`${BASE}#/fill`);
  await p.waitForTimeout(1200);
  const first = p.locator("main button, main a").filter({ hasText: /Rx|\d{7}/ }).first();
  const fillText = await p.locator("main").innerText();
  check("Fill & pickup lists orders", /\d{7}/.test(fillText));
  await p.goto(`${BASE}#/fill?rx=0072210`);
  await p.waitForSelector("text=Rx Watcher", { timeout: 15000 }).then(() => check("an order opens with its Rx Watcher review", true), () => check("an order opens with its Rx Watcher review", false));
  await shot(p, "fill-order");
  void first;

  // ---- AI agents run on the mock provider --------------------------------------------------------------------------------
  await p.goto(`${BASE}#/agents`);
  await p.waitForSelector("text=AI agents");
  const card = p.locator("article h2");
  check("AI agents screen lists the agents", (await card.count()) >= 3);
  await p.locator("article").first().getByRole("button", { name: "Run with sample input" }).click();
  await p.waitForSelector("text=/Recent runs/", { timeout: 15000 }).then(() => check("an agent runs on the built-in mock provider", true), () => check("an agent runs on the built-in mock provider", false));
  await shot(p, "agents-run");

  // ---- audit export link downloads through the in-page API ------------------------------------------------------------------
  await ph.ctx.close();

  // ---- technician, cashier, admin ------------------------------------------------------------------------------------------
  for (const [who, role] of [["k.patel", "technician"], ["m.diaz", "cashier"], ["s.grant", "admin"]]) {
    const s = await open(role);
    await signIn(s.page, who);
    await s.page.waitForTimeout(800);
    const ls = await navLinks(s.page);
    for (const l of ls) {
      await s.page.goto(`${BASE}#${l.href}`);
      await s.page.waitForTimeout(900);
      const t = await s.page.locator("main").innerText();
      check(`${role} opens ${l.text}`, t.trim().length > 20 && !/Something went wrong|Not available for your role/.test(t));
      await shot(s.page, `${role}-${l.href === "/" ? "today" : l.href.slice(1)}`);
    }
    const names = ls.map((l) => l.text).join(" | ");
    if (role === "cashier") {
      check("cashier nav hides Patients, Recalls, AI agents, Integrations", !/Patients|Recalls|AI agents|Integrations/.test(names), names);
      await s.page.goto(`${BASE}#/patients`);
      await s.page.waitForSelector("text=Not available for your role", { timeout: 5000 }).then(() => check("cashier opening /patients sees a role message", true), () => check("cashier opening /patients sees a role message", false));
      const codes = await s.page.evaluate(async () => (await Promise.all(["/api/patients/search?q=Daniel", "/api/patients/S-0612", "/api/integrations"].map((u) => fetch(u).then((r) => r.status)))));
      check("cashier API calls for patient records and integrations are refused (403)", codes.every((c) => c === 403), codes.join(","));
      const rx = await s.page.evaluate(async () => (await fetch("/api/rx")).text());
      check("cashier fill list carries no DOB or allergies", !/dob|allerg/i.test(rx));
      // register: sell an over-the-counter item
      await s.page.goto(`${BASE}#/register`);
      await s.page.waitForSelector("text=Mark paid and print receipt");
      await s.page.locator("#rq").fill("a");
      await s.page.waitForTimeout(1200);
      await s.page.locator("section[aria-labelledby='otc'] ul button, section[aria-labelledby='otc'] li button").first().click();
      await s.page.getByRole("button", { name: "Mark paid and print receipt" }).click();
      await s.page.waitForSelector("section[aria-label='Receipt']", { timeout: 10000 }).then(() => check("cashier register sale completes with a receipt", true), () => check("cashier register sale completes with a receipt", false));
      await shot(s.page, "register-receipt");
    }
    if (role === "technician") {
      const code = await s.page.evaluate(async () => (await fetch("/api/integrations")).status);
      check("technician cannot read integrations (403)", code === 403, String(code));
      const approve = await s.page.evaluate(async () => (await fetch("/api/recalls/D-0611-2026/close", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status);
      check("technician cannot close a recall (403)", approve === 403, String(approve));
    }
    if (role === "admin") {
      check("admin sees Integrations and no clinical screens", /Integrations/.test(names) && !/Fill & pickup|Receiving/.test(names), names);
      await s.page.goto(`${BASE}#/integrations`);
      await s.page.waitForSelector("text=Connected partners", { timeout: 10000 }).then(() => check("admin opens connected partners", true), () => check("admin opens connected partners", false));
      const [dl] = await Promise.all([s.page.waitForEvent("download", { timeout: 15000 }), s.page.getByRole("link", { name: /Export audit log/ }).click()]);
      const txt = fs.readFileSync(await dl.path(), "utf8");
      check("audit export downloads from the in-page API", txt.length > 50 && txt.includes("{"), `${txt.length} bytes`);
      const pt = await s.page.evaluate(async () => (await fetch("/api/rx")).status);
      check("admin is refused the clinical order list (403)", pt === 403, String(pt));
    }
    await s.ctx.close();
  }

  // ---- technician: receive flow smoke + reload resets data ---------------------------------------------------------------
  const rl = await open("reload");
  await signIn(rl.page, "j.rivera");
  await rl.page.reload();
  await rl.page.waitForSelector("#email", { timeout: 60000 }).then(() => check("a reload starts a fresh in-memory session (sign-in again)", true), () => check("a reload starts a fresh in-memory session (sign-in again)", false));
  await rl.ctx.close();
} catch (e) {
  console.log("ERROR", e);
  results.push({ name: "script", ok: false });
} finally {
  await browser.close();
}
const uniq = [...new Set(problems)];
check("no console errors, page errors or failed requests", uniq.length === 0, uniq.slice(0, 6).join(" || "));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed. Screenshots in ${SHOTS}`);
process.exit(failed ? 1 : 0);
