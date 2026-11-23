/**
 * What happens on screen for each narration unit of docs/DEMO_VIDEO_SCRIPT.md. Written against the current UI
 * (no Demo guide, no scenario launcher, no prefilled sign-in): staff type credentials, or the recorder swaps the
 * signed-in user off camera (asUser). Every step is [unitIndex, name, async (r) => ...].
 * FULL is keyed by the segment ids of the full script, CUT by the cut ids. Both reuse the same actions.
 */
import { PW, BASE, dmPng, gs1, sleep } from "./video-core.mjs";

const ROLE = { "j.rivera": "Pharmacist", "k.patel": "Technician", "m.diaz": "Cashier", "s.grant": "Admin" };
const tag = (screen, role) => `${screen}${role ? ` <span style="font-weight:500;opacity:.8">· ${role}</span>` : ""}`;
const holdLabel = async (r, label) => { await r.page.evaluate((u) => window.__hold(u), `data:image/png;base64,${await dmPng(label)}`); };
const holdLot = async (r, lot, serial, { withSerial = true } = {}) => {
  const l = (await r.labels()).find((x) => x.lot === lot && (!serial || x.serial === serial));
  if (!l) throw new Error(`no printable label for ${lot} ${serial ?? ""}`);
  await holdLabel(r, gs1(l, withSerial));
};
const feats = (r) => r.page.locator("form").first();

export const A = {
  // ---- sign-in page ----------------------------------------------------------------------------------------------
  async idea(r) { await r.lt(tag("Chimera Rx", "")); await r.page.waitForSelector("li"); const li = r.page.locator("ul li"); const n = await li.count(); for (let i = 0; i < Math.min(n, 3); i++) { await r.point(li.nth(i)); await r.hold(900); } },
  async gap(r) { await r.lt(tag("The gap between lot and patient", "")); await r.point(r.page.locator("ul li").first()); await r.hold(1200); await r.point("form"); },
  async solution(r) { await r.lt(tag("One ledger, agents on top", "")); await r.point(r.page.locator("ul li").nth(1)); await r.hold(1000); await r.point(r.page.locator("ul li").nth(2)); },
  async notice(r) { await r.lt(tag("Demo notice on every screen", "")); await r.page.mouse.move(960, 14); await r.moveTo(960, 16); await r.hold(1800); },
  async signinType(r) {
    await r.lt(tag("Sign in", ""));
    await r.type("input[type=email], #email", "j.rivera@elmstreetrx.example");
    await r.type("input[type=password], #password", PW);
    await r.click(r.page.getByRole("button", { name: /^Sign in/ }));
    await r.page.waitForSelector("text=Enter your code", { timeout: 10000 });
  },
  async showCode(r) {
    await r.lt(tag("Second step: six-digit code", ""));
    await r.click(r.page.getByRole("link", { name: /Show the code/ }).or(r.page.getByRole("button", { name: /Show the code/ })));
    await r.page.locator("[role=status]").first().waitFor();
    await r.hold(1200);
  },
  async codeRefuseThenOk(r) {
    await r.type("#code", "000000");
    await r.click(r.page.getByRole("button", { name: "Verify and sign in" }));
    await r.page.waitForSelector("text=/not right|expired/", { timeout: 8000 }).catch(() => {});
    await r.hold(900);
    const code = (await r.page.locator("[role=status]").first().innerText().catch(() => "")).match(/\d{6}/)?.[0];
    await r.page.locator("#code").fill("");
    await r.type("#code", code ?? "000000");
    await r.click(r.page.getByRole("button", { name: "Verify and sign in" }));
    await r.page.waitForSelector("nav[aria-label='Main']", { timeout: 10000 });
  },
  async rolesNav(r) { await r.lt(tag("Roles are enforced on the server", "Pharmacist")); for (const t of ["Receiving", "Fill & pickup", "Patients", "Integrations"]) { await r.point(r.page.locator("nav[aria-label='Main']").getByText(t, { exact: false }).first()); await r.hold(500); } },

  // ---- today ----------------------------------------------------------------------------------------------------------
  async todayPharm(r) { await r.go("/", "text=Good "); await r.lt(tag("Today", "Pharmacist")); await r.point("text=Start recall"); await r.hold(900); },
  async todayCards(r) { await r.point(r.page.locator("section[aria-labelledby=sugg]")); await r.scrollTo("text=Deliveries to check in"); await r.point("text=Fridge F1"); await r.hold(700); },
  async todayTech(r) { await r.asUser("k.patel"); await r.lt(tag("Today", "Technician")); await r.go("/", "text=Good "); await r.hold(900); await r.point("text=Deliveries to check in"); },
  async todayCashier(r) { await r.asUser("m.diaz"); await r.lt(tag("Today", "Cashier")); await r.go("/", "text=Good "); await r.hold(900); },
  async todayAdmin(r) { await r.asUser("s.grant"); await r.lt(tag("Today", "Admin")); await r.go("/", "nav[aria-label='Main']"); await r.hold(900); },

  // ---- receiving ---------------------------------------------------------------------------------------------------
  async recvOpen(r) { await r.asUser("k.patel"); await r.lt(tag("Receiving", "Technician")); await r.go("/receiving", "text=Check in delivery from"); await r.click(r.page.getByRole("button", { name: "Scan with camera" })); await r.page.getByRole("button", { name: "Stop camera" }).waitFor(); },
  async recvScan(r) { await holdLot(r, "AMX0926B", "10443850"); await r.page.waitForSelector("text=Transaction information verified", { timeout: 20000 }); await r.hold(500); await r.point("text=Transaction information verified"); },
  async recvPutAway(r) { await r.point(r.page.locator("text=/Aisle \\d · Bay/").first()); await r.hold(500); await r.click(r.page.getByRole("button", { name: "Confirm put-away" })); await r.page.waitForSelector("text=/36 of 38/", { timeout: 8000 }); await r.page.evaluate(() => window.__lower()); },
  async recvBad(r) {
    await r.cutWait(() => sleep(2300));
    const bad = { ...(await r.labels()).find((x) => x.lot === "OX25L072") }; bad.serial = "99999999";
    await holdLabel(r, gs1(bad));
    await r.page.waitForSelector("text=not in the supplier", { timeout: 20000 });
    await r.point(r.page.getByRole("button", { name: "Confirm put-away" })); await r.hold(700);
    await r.page.evaluate(() => window.__lower());
    await r.click(r.page.getByRole("button", { name: "Report a problem" }));
    await r.click(r.page.getByRole("radio", { name: "Suspect product" }));
    await r.click(r.page.getByRole("button", { name: "Quarantine & log problem" }));
    await r.page.waitForSelector("text=Problem logged", { timeout: 8000 });
  },
  async recvOcr(r) {
    await r.cutWait(() => sleep(2200));
    await r.page.evaluate(() => window.__holdText(["NDC 70004-226-01  Amoxicillin 500 mg", "LOT AMX0626C", "EXP 01/2028", "SN 10440999"]));
    await r.click(r.page.getByRole("button", { name: "Read label text (OCR)" }));
    await r.cutWait(() => r.page.waitForSelector("text=OCR read this", { timeout: 90000 }));
    await r.point("#ocr-lot"); await r.hold(900); await r.point("#ocr-ndc"); await r.hold(500);
  },
  async recvChecks(r) { await r.page.evaluate(() => window.__lower()); await r.page.mouse.move(900, 300); await r.hold(1200); },

  // ---- inventory ---------------------------------------------------------------------------------------------------
  async invOpen(r) { await r.asUser("j.rivera"); await r.lt(tag("Inventory", "Pharmacist")); await r.go("/inventory", "text=Inventory by lot"); await r.hold(1500); },
  async invFilters(r) {
    for (const re of [/^Expiring/, /^Refrigerated/, /^Controlled/]) { await r.click(r.page.getByRole("button", { name: re }).or(r.page.getByRole("tab", { name: re }))); await r.hold(500); }
  },
  async stockHelp(r) { await r.lt(tag("Stock help", "Pharmacist")); await r.go("/stock", "text=Stock help"); await r.hold(600); await r.point("text=Reorder (1)"); await r.hold(800); await r.scrollTo("text=Expiry risk"); await r.hold(800); },

  // ---- fill & pickup -------------------------------------------------------------------------------------------------
  async fillQueue(r) { await r.asUser("k.patel"); await r.lt(tag("Fill & pickup", "Technician")); await r.go("/fill", "text=Queue ·"); await r.point(r.page.locator("text=Review").first()); await r.hold(1200); },
  async fillLinda(r) { await r.click(r.page.getByRole("button", { name: /Linda Chen/ })); await r.page.waitForSelector("text=Linda Chen"); await r.point("text=Rx Watcher"); await r.hold(900); },
  async fillWrong(r) {
    await r.click(r.page.getByRole("button", { name: "Scan with camera" })); await r.page.getByRole("button", { name: "Stop camera" }).waitFor();
    await holdLot(r, "GX4471C", "0000907");
    await r.page.waitForSelector("text=/Wrong drug|wrong drug/", { timeout: 15000 }); await r.hold(1200);
    await r.page.evaluate(() => window.__lower());
  },
  async fillRight(r) {
    await r.cutWait(() => sleep(2300));
    await holdLot(r, "AT24K118", "24118006");
    await r.page.waitForSelector("text=Print label", { timeout: 15000 }); await r.point("text=Lot"); await r.hold(900);
    await r.page.evaluate(() => window.__lower());
  },

  // ---- watcher, guardian, change request ----------------------------------------------------------------------
  async watcherFlags(r) { await r.asUser("j.rivera"); await r.lt(tag("Rx Watcher", "Pharmacist")); await r.go("/fill?rx=0072210", "text=Rx Watcher"); await r.page.waitForSelector("text=Unusual frequency for insulin glargine", { timeout: 12000 }); await r.point("text=Unusual frequency for insulin glargine"); await r.hold(700); await r.point("text=about 34 days"); await r.hold(500); },
  async watcherOptions(r) { for (const n of ["Ask prescriber to change", "Approve as written…", "Reject…"]) { await r.point(r.page.getByRole("button", { name: n })); await r.hold(700); } },
  async guardianPanel(r) { await r.lt(tag("Rx Guardian", "Pharmacist")); await r.scrollTo("text=/Rx Guardian found/"); await r.point("text=/Rx Guardian found/"); await r.hold(900); await r.scrollTo("text=Evidence from the history"); await r.hold(1200); },
  async guardianDecide(r) {
    await r.point(r.page.getByRole("button", { name: "Accept: hold the order" }).first()); await r.hold(500);
    const d = r.page.getByRole("button", { name: "Dismiss…" }).first();
    await r.click(d);
    await r.type(r.page.getByLabel("Reason for dismissing"), "Reviewed with the prescriber; no change needed");
    await r.click(r.page.getByRole("button", { name: "Dismiss", exact: true }));
    await r.hold(900);
  },
  async guardianRoles(r) {
    await r.asUser("k.patel"); await r.lt(tag("Rx Guardian", "Technician")); await r.go("/fill?rx=0072210", "text=Rx Watcher");
    await r.scrollTo("text=/Rx Guardian found/"); await r.hold(1000);
    await r.asUser("m.diaz"); await r.lt(tag("Same order", "Cashier")); await r.go("/fill?rx=0072210", "text=Daniel Brooks"); await r.hold(1400);
  },
  async requestCompose(r) {
    await r.asUser("j.rivera"); await r.lt(tag("Change request", "Pharmacist")); await r.go("/fill?rx=0072210", "text=Rx Watcher");
    await r.click(r.page.getByRole("button", { name: "Ask prescriber to change" })); await r.page.waitForSelector("#cr-dir"); await r.point("#cr-dir"); await r.hold(700);
    await r.click(r.page.getByRole("button", { name: "Send change request" }));
    await r.page.waitForSelector("text=/Waiting for Dr\\. A\\. Nwosu/", { timeout: 8000 }); await r.hold(600);
  },
  async requestApprove(r) {
    await r.click(r.page.getByRole("button", { name: "Prescriber approved" }));
    await r.page.waitForSelector("text=Rx 0072210-R1", { timeout: 8000 }); await r.page.waitForSelector("text=All checks clear", { timeout: 8000 }).catch(() => {}); await r.hold(900);
  },

  // ---- serials and refusals ----------------------------------------------------------------------------------------
  async serialNever(r) {
    await r.asUser("k.patel"); await r.lt(tag("Scan: serial never received", "Technician")); await r.go("/fill?rx=0072210-R1", "text=Daniel Brooks");
    const l = (await r.labels()).find((x) => x.lot === "GX4471C");
    await r.type("#typed", gs1({ ...l, serial: "5550001" })); await r.click(r.page.getByRole("button", { name: "Check", exact: true }));
    await r.page.waitForSelector("text=/never received/", { timeout: 10000 }); await r.hold(1000);
  },
  async serialInferred(r) {
    await r.lt(tag("Scan without a serial", "Technician"));
    const l = (await r.labels()).find((x) => x.lot === "GX4471C");
    await r.page.locator("#typed").fill("");
    await r.type("#typed", gs1(l, false)); await r.click(r.page.getByRole("button", { name: "Check", exact: true }));
    await r.page.waitForSelector("text=No serial was scanned", { timeout: 10000 }); await r.point("text=No serial was scanned"); await r.hold(1200);
  },
  async serialSendBack(r) {
    await r.asUser("j.rivera"); await r.lt(tag("Send back and rescan", "Pharmacist")); await r.go("/fill?rx=0072210-R1", "text=Daniel Brooks");
    await r.click(r.page.getByRole("button", { name: "Send back", exact: true }).first()); await r.type(r.page.getByLabel("Reason to send back"), "Rescan with the real serial");
    await r.click(r.page.getByRole("button", { name: "Send back", exact: true }).last()); await r.hold(900);
    const l = (await r.labels()).find((x) => x.lot === "GX4471C" && x.serial === "0000907");
    await r.type("#typed", gs1(l)); await r.click(r.page.getByRole("button", { name: "Check", exact: true }));
    await r.page.waitForSelector("text=Print label", { timeout: 10000 }); await r.point("text=Serial"); await r.hold(900);
  },
  async serialTwice(r) {
    await r.lt(tag("Already filled", "Pharmacist"));
    const res = await r.api("POST", "/api/rx/0072210-R1/scan", { code: "(01)00370004623153(17)271231(10)GX4471C(21)0000907", source: "typed" });
    await r.hold(600); await r.point("text=Print label"); await r.hold(1400);
  },
  async controlled(r) { await r.lt(tag("Controlled drugs", "Pharmacist")); await r.go("/inventory?filter=controlled", "text=Inventory by lot"); await r.hold(2200); },

  // ---- verify & pickup ----------------------------------------------------------------------------------------------------
  async pickLabel(r) {
    await r.asUser("k.patel"); await r.lt(tag("Print label", "Technician")); await r.go("/fill?rx=0072210-R1", "text=Daniel Brooks");
    await r.click(r.page.getByRole("button", { name: /Print label/ })); await r.page.waitForSelector("text=/Waiting for a pharmacist/", { timeout: 10000 }); await r.hold(900);
  },
  async pickVerify(r) {
    await r.asUser("j.rivera"); await r.lt(tag("Verify", "Pharmacist")); await r.go("/fill?rx=0072210-R1", "text=Pharmacist check");
    const boxes = r.page.locator("input[type=checkbox]"); const n = await boxes.count();
    for (let i = 0; i < n; i++) { await r.click(boxes.nth(i), { ring: false }); await r.hold(250); }
    await r.click(r.page.getByRole("button", { name: /^Approve as/ })); await r.page.waitForSelector("text=Pickup at register", { timeout: 10000 });
  },
  async pickSell(r) {
    await r.lt(tag("Pickup", "Pharmacist"));
    const boxes = r.page.locator("input[type=checkbox]"); const n = await boxes.count();
    for (let i = 0; i < n; i++) { await r.click(boxes.nth(i), { ring: false }); await r.hold(250); }
    await r.click(r.page.getByRole("button", { name: "Complete sale" })); await r.page.waitForSelector("text=/Sold to/", { timeout: 10000 }); await r.hold(1200);
  },

  // ---- register -----------------------------------------------------------------------------------------------------------
  async regSale(r) {
    await r.asUser("m.diaz"); await r.lt(tag("Register", "Cashier")); await r.go("/register", "text=Mark paid and print receipt");
    await r.click("section[aria-labelledby='otc'] li button, section[aria-labelledby='otc'] ul button");
    await r.click(r.page.getByRole("button", { name: "Mark paid and print receipt" })); await r.page.waitForSelector("section[aria-label='Receipt']", { timeout: 8000 }); await r.hold(900);
  },
  async regMenu(r) { await r.point(r.page.locator("nav[aria-label='Main']")); await r.hold(800); await r.go("/patients", "text=Not available for your role"); await r.hold(1200); },
  async regOrder(r) { await r.lt(tag("An order", "Cashier")); await r.go("/fill?rx=0072187", "text=Grace Miller"); await r.hold(1800); },

  // ---- recalls --------------------------------------------------------------------------------------------------------------
  async recFax(r) {
    await r.asUser("j.rivera"); await r.lt(tag("Recalls: fax", "Pharmacist")); await r.go("/recalls", "text=Fax inbox");
    await r.click(r.page.getByRole("button", { name: "Read this fax with OCR" }));
    await r.cutWait(() => r.page.waitForSelector("text=Already with patients", { timeout: 120000 })); await r.hold(500);
  },
  async recLots(r) { await r.lt(tag("Recalls: lots read from the fax", "Pharmacist")); await r.point("text=PRORX050925-1"); await r.hold(700); await r.point("text=PRORX050925-3"); await r.hold(600); },
  async recConfirm(r) {
    await r.lt(tag("Recalls: confirm one lot at a time", "Pharmacist"));
    const c = r.page.getByRole("button", { name: "Confirm lot" });
    for (let n = await c.count(); n > 0; n = await c.count()) { await r.click(c.first()); await r.hold(500); }
  },
  async recQuarantine(r) { await r.lt(tag("Recalls: quarantine and impact", "Pharmacist")); await r.point("text=/Moved to quarantine/"); await r.hold(800); await r.scrollTo("text=Affected patients"); await r.point("text=Affected patients"); await r.hold(700); },
  async recWhy(r) { await r.point("text=Matched by lot recorded at fill"); await r.hold(1600); },
  async recMessages(r) {
    await r.lt(tag("Recalls: messages and voicemail", "Pharmacist"));
    await r.click(r.page.getByRole("button", { name: "Continue to patient messages" })); await r.page.waitForSelector("text=Text message"); await r.hold(500);
    await r.click(r.page.getByRole("button", { name: /Hear it as a patient would/ }));
    await r.cutWait(() => r.page.waitForSelector("text=/Preview for .* · (recorded with|read by)/", { timeout: 60000 })); await r.hold(900);
  },
  async recSend(r) {
    await r.click(r.page.getByLabel(/I am the pharmacist/)); await r.hold(400);
    await r.click(r.page.getByRole("button", { name: /^Start \d+ calls/ }));
    await r.cutWait(() => r.page.waitForSelector("text=Patients contacted for recall", { timeout: 60000 })); await r.hold(500);
  },
  async recLog(r) { await r.scrollTo("text=Call log"); await r.point("text=Call log"); await r.hold(900); await r.point(r.page.getByText("Download audit report")); await r.hold(900); await r.lt(tag("Sandbox outbox", "Pharmacist")); await r.go("/outbox", "text=Sandbox outbox"); await r.hold(1500); },

  // ---- agents ---------------------------------------------------------------------------------------------------------------
  async agentsOpen(r) {
    await r.cutWait(async () => { await r.control("POST", "/scenario/agent-catches-it"); await r.apiLogin("j.rivera"); await r.page.goto(`${BASE}/#/`); await r.page.reload(); await r.page.waitForSelector("nav[aria-label='Main']"); });
    await r.lt(tag("AI agents", "Pharmacist")); await r.go("/agents", "text=Rules decide. The model explains."); await r.hold(1200);
  },
  async agentsList(r) { for (const t of ["Coroner", "Rx Watcher Explainer", "Rx Guardian"]) { await r.scrollTo(r.page.locator(`article[aria-label="${t}"]`)); await r.point(r.page.locator(`article[aria-label="${t}"]`)); await r.hold(500); } },
  async agentsGate(r) {
    await r.cutWait(async () => { await r.api("POST", "/api/agents/provider", { provider: "openai-compatible", baseUrl: "http://127.0.0.1:4693/v1", model: "stand-in-model" }); await r.page.reload(); await r.page.waitForSelector("text=Rules decide."); });
    await r.lt(tag("Coroner with a stand-in model", "Pharmacist"));
    const card = r.page.locator('article[aria-label="Coroner"]'); await r.scrollTo(card);
    await r.click(card.getByRole("button", { name: "Run with sample input" }));
    await r.page.waitForSelector("text=What the gate dropped", { timeout: 30000 }); await r.scrollTo("text=What the gate dropped"); await r.point("text=What the gate dropped"); await r.hold(1800);
    await r.cutWait(async () => { await r.api("POST", "/api/agents/provider", { provider: "mock" }); });
  },
  async agentsProvider(r) { await r.go("/agents", "text=Rules decide."); await r.scrollTo(r.page.locator("section[aria-label='Provider']")); await r.point(r.page.locator("section[aria-label='Provider'] select").first()); await r.hold(1500); },
  async agentsBackground(r) { await r.lt(tag("Background mode", "Pharmacist")); const g = r.page.getByRole("group", { name: "Rx Guardian background mode" }); await r.scrollTo(g); await r.point(g); await r.hold(900); await r.click(g.getByRole("button", { name: "Run now" })); await r.hold(1200); },
  async agentsToday(r) {
    await r.lt(tag("Today: Suggestions", "Pharmacist")); await r.go("/", "section[aria-labelledby=sugg]");
    await r.point("section[aria-labelledby=sugg]"); await r.hold(900);
    await r.go("/fill?rx=0072301", "text=/Rx Guardian · \\d+ suggestion/"); await r.scrollTo("text=Evidence from the history"); await r.point("text=Evidence from the history"); await r.hold(900);
  },
  async agentsAccept(r) {
    await r.click(r.page.getByRole("button", { name: "Accept: hold the order" }).first()); await r.click(r.page.getByRole("button", { name: "Put order on hold" })); await r.hold(1500);
  },
  async agentsRuns(r) { await r.lt(tag("Recent runs", "Pharmacist")); await r.go("/agents", "text=Rules decide."); await r.scrollTo("section[aria-label='Recent runs']"); await r.hold(1800); },

  // ---- refills -------------------------------------------------------------------------------------------------------------
  async refillsOpen(r) {
    await r.cutWait(async () => { await r.control("POST", "/scenario/recall-aware-refill"); await r.apiLogin("j.rivera"); await r.page.goto(`${BASE}/#/`); await r.page.reload(); await r.page.waitForSelector("nav[aria-label='Main']"); });
    await r.lt(tag("Refills", "Pharmacist")); await r.go("/refills", "text=Refill worklist"); await r.hold(700); await r.scrollTo("section[aria-labelledby=ad]"); await r.hold(900); await r.scrollTo("section[aria-labelledby=sy]"); await r.hold(500);
  },
  async refillsDraft(r) { await r.click(r.page.getByRole("button", { name: "Draft reminders" })); await r.hold(1800); },
  async refillsSched2(r) { await r.scrollTo("text=Need a new prescription"); await r.point("text=Need a new prescription"); await r.hold(1200); },
  async refillsRecall(r) {
    await r.lt(tag("Recalls: look up D-0611-2026", "Pharmacist")); await r.go("/recalls", "text=Fax inbox");
    await r.type("#rn", "D-0611-2026"); await r.click(r.page.getByRole("button", { name: "Look up recall" }));
    await r.cutWait(() => r.page.waitForSelector("text=/Already with patients|Affected patients/", { timeout: 60000 })); await r.hold(500);
    await r.lt(tag("Refills: recall hold", "Pharmacist")); await r.go("/refills", "text=Refill worklist"); await r.page.waitForSelector("text=Recall hold", { timeout: 10000 }); await r.point("text=Recall hold"); await r.hold(1500);
  },

  // ---- blocked at fill -----------------------------------------------------------------------------------------------------------
  async blockedScan(r) {
    await r.lt(tag("Fill: recalled lot", "Pharmacist")); await r.go("/fill?rx=0072210", "text=Rx Watcher");
    await r.click(r.page.getByRole("button", { name: "Approve as written…" })); await r.type("#dec-reason", "Reviewed, patient confirmed once daily dosing");
    await r.click(r.page.getByRole("button", { name: /^Approve as/ })); await r.hold(900);
    const l = (await r.labels()).find((x) => x.lot === "GX4471C" && x.serial === "0000907");
    await r.type("#typed", gs1(l)); await r.click(r.page.getByRole("button", { name: "Check", exact: true }));
    await r.page.waitForSelector("text=/Recalled lot/", { timeout: 10000 }); await r.point("text=/Recalled lot/"); await r.hold(1200);
  },
  async blockedClosed(r) { await r.hold(1800); },

  // ---- dscsa ----------------------------------------------------------------------------------------------------------------------
  async dscsaExport(r) {
    await r.lt(tag("DSCSA & trace", "Pharmacist")); await r.go("/dscsa", "text=Verification requests");
    await r.click(r.page.getByRole("button", { name: "Preview" })); await r.hold(1200); await r.point(r.page.getByRole("link", { name: "Download .jsonld" })); await r.hold(500);
    await r.scrollTo("text=Import trace"); await r.point("text=Import trace (advisory)"); await r.hold(700);
  },
  async dscsaVerify(r) {
    await r.scrollTo("text=Verification requests");
    const sec = r.page.locator("section[aria-label='Verification requests']"); const inputs = sec.locator("input");
    for (const s of ["DEMO-OK-01", "SPOOF-001"]) { await inputs.nth(1).fill(""); await r.type(inputs.nth(1), s); await inputs.nth(3).fill("2028-02-29"); await r.click(sec.getByRole("button", { name: "Ask the sandbox verifier" })); await r.hold(1500); }
  },
  async dscsaSuspect(r) { await r.scrollTo("section[aria-label='Suspect product cases']"); await r.point("section[aria-label='Suspect product cases']"); await r.hold(1600); },

  // ---- stores ----------------------------------------------------------------------------------------------------------------------
  async transfer(r) {
    await r.lt(tag("Transfers", "Pharmacist")); await r.go("/transfers", "#lot");
    const opt = await r.page.locator("#lot option").nth(1).getAttribute("value"); await r.page.selectOption("#lot", opt); await r.hold(500);
    await r.click(r.page.getByRole("button", { name: "Move stock" })); await r.page.waitForSelector("text=Recorded in both audit logs", { timeout: 8000 }); await r.hold(1200);
  },
  async store2(r) {
    await r.cutWait(async () => { await r.apiLogin("s.okoro", { storeId: "store-2", domain: "birchavenuerx.example" }); await r.page.goto(`${BASE}/#/`); await r.page.reload(); await r.page.waitForSelector("nav[aria-label='Main']"); });
    await r.lt(tag("Birch Avenue Pharmacy · Store 2", "Pharmacist")); await r.hold(1800);
  },

  // ---- integrations / security --------------------------------------------------------------------------------------------------
  async intPartners(r) { await r.asUser("s.grant"); await r.lt(tag("Integrations & API", "Admin")); await r.go("/integrations", "text=Connected partners"); await r.point("text=Connected partners"); await r.hold(1500); },
  async intMcp(r) {
    await r.click(r.page.getByRole("tab", { name: "MCP server" }));
    await r.click(r.page.getByRole("button", { name: /Rotate int-rx-concierge and fill in/ })); await r.click(r.page.getByRole("button", { name: "Send request" }));
    await r.page.waitForSelector("text=/\"recalled\": true/", { timeout: 10000 }); await r.hold(900); await r.page.waitForSelector("text=get_recall_status", { timeout: 10000 }).catch(() => {}); await r.scrollTo("text=get_recall_status"); await r.hold(900);
  },
  async intPlaceholders(r) { await r.scrollTo("text=Outbound connections"); await r.point("text=Outbound connections"); await r.hold(2500); },
  async secAudit(r) { await r.lt(tag("Audit chain", "Admin")); await r.go("/integrations", "text=Audit chain"); await r.point("text=Audit chain"); await r.hold(1500); },
  async docPage(r, file, name) { const html = `file://${file}`; await r.page.goto(html); await r.hold(100); },
};

// ---- the full video ------------------------------------------------------------------------------------------------------------------
export const FULL = {
  problem: [[0, "idea", A.idea], [2, "gap", A.gap], [4, "solution", A.solution]],
  safety: [[0, "notice", A.notice], [1, "synthetic", (r) => r.hold(2500)]],
  signin: [[0, "type", A.signinType], [1, "show", A.showCode], [2, "verify", A.codeRefuseThenOk], [3, "roles", A.rolesNav]],
  today: [[0, "pharm", A.todayPharm], [1, "cards", A.todayCards], [2, "tech", A.todayTech], [3, "cashier", A.todayCashier], [4, "admin", A.todayAdmin]],
  receiving: [[0, "open", A.recvOpen], [1, "scan", A.recvScan], [2, "putaway", A.recvPutAway], [3, "bad", A.recvBad], [4, "ocr", A.recvOcr], [5, "gate", A.recvChecks]],
  inventory: [[0, "open", A.invOpen], [1, "filters", A.invFilters], [2, "stock", A.stockHelp]],
  fill: [[0, "queue", A.fillQueue], [1, "linda", A.fillLinda], [2, "wrong", A.fillWrong], [3, "right", A.fillRight]],
  watcher: [[0, "flags", A.watcherFlags], [1, "options", A.watcherOptions]],
  guardian: [[0, "panel", A.guardianPanel], [1, "decide", A.guardianDecide], [2, "roles", A.guardianRoles]],
  request: [[0, "compose", A.requestCompose], [1, "approve", A.requestApprove]],
  serials: [[0, "never", A.serialNever], [1, "inferred", A.serialInferred], [2, "sendback", A.serialSendBack], [3, "twice", A.serialTwice], [4, "controlled", A.controlled]],
  pickup: [[0, "label", A.pickLabel], [1, "verify", A.pickVerify], [2, "sell", A.pickSell]],
  register: [[0, "sale", A.regSale], [1, "menu", A.regMenu], [2, "order", A.regOrder]],
  recalls: [[0, "fax", A.recFax], [1, "lots", A.recLots], [2, "confirm", A.recConfirm], [3, "quarantine", A.recQuarantine], [4, "why", A.recWhy], [5, "messages", A.recMessages], [6, "send", A.recSend], [7, "log", A.recLog]],
  agents: [[0, "open", A.agentsOpen], [1, "list", A.agentsList], [2, "gate", A.agentsGate], [3, "provider", A.agentsProvider], [4, "background", A.agentsBackground], [5, "today", A.agentsToday], [6, "accept", A.agentsAccept], [7, "runs", A.agentsRuns]],
  refills: [[0, "open", A.refillsOpen], [1, "draft", A.refillsDraft], [2, "sched2", A.refillsSched2], [3, "recall", A.refillsRecall]],
  blocked: [[0, "scan", A.blockedScan], [1, "closed", A.blockedClosed]],
  dscsa: [[0, "export", A.dscsaExport], [1, "verify", A.dscsaVerify], [2, "suspect", A.dscsaSuspect]],
  stores: [[0, "transfer", A.transfer], [1, "store2", A.store2]],
  integrations: [[0, "partners", A.intPartners], [1, "mcp", A.intMcp], [2, "placeholders", A.intPlaceholders]],
  security: [[0, "audit", A.secAudit], [3, "review", (r) => r.hold(3000)]],
  future: [[0, "mod", (r) => r.hold(3000)]],
  kiro: [[0, "kiro", (r) => r.hold(3000)]],
  close: [[0, "today", async (r) => { await r.asUser("j.rivera"); await r.go("/", "text=Good "); await r.hold(1500); }]],
};

export const CUT = {
  gap: [[0, "idea", A.idea], [1, "solution", A.solution]],
  receive: [[0, "type", A.signinType], [1, "verify", async (r) => { await A.showCode(r); await A.codeRefuseThenOk(r); }]],
  fill: [[0, "flags", A.watcherFlags], [1, "scan", async (r) => { await A.guardianPanel(r); }]],
  recall: [[0, "fax", A.recFax], [1, "confirm", A.recConfirm], [2, "messages", A.recMessages]],
  agents: [[0, "open", A.agentsOpen], [1, "today", A.agentsToday]],
  security: [[0, "audit", A.secAudit]],
  kiro: [[0, "kiro", (r) => r.hold(2500)]],
  close: [[0, "today", async (r) => { await r.go("/", "text=Good "); await r.hold(1500); }]],
};
