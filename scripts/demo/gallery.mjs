// Renders the Devpost image gallery (1500x1000, 3:2, JPG) into docs/media/gallery/.
// Each card: a caption on the left, a real screenshot of the app on the right.
// Usage: node scripts/demo/gallery.mjs
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(root, "docs/media/gallery");
mkdirSync(out, { recursive: true });
// Inline as data URLs: a page built with setContent cannot read file:// images.
const shot = (f) => `data:image/${f.endsWith(".png") ? "png" : "jpeg"};base64,${readFileSync(path.join(root, f)).toString("base64")}`;

const cards = [
  { file: "01-today", img: "docs/evidence/screens/browser-pharmacist-today.png", kicker: "Today", title: "One screen for the whole shift",
    body: "Open work, refills due, Rx Guardian suggestions and lot-capture rate, read from one connected ledger." },
  { file: "02-receiving", img: "docs/evidence/screens/browser-pharmacist-receiving.png", kicker: "Receiving", title: "The lot is captured when it is in your hand",
    body: "GS1 DataMatrix by webcam or USB scanner, OCR for labels with no barcode, and four checks before a package reaches the shelf." },
  { file: "03-fill", img: "docs/evidence/screens/browser-fill-order.png", kicker: "Fill & pickup", title: "Rx Guardian reads the whole history",
    body: "Deterministic rules first, then an AI explanation with evidence. The pharmacist accepts or dismisses; the agent never changes an order." },
  { file: "04-agents", img: "docs/evidence/screens/browser-agents-run.png", kicker: "AI agents", title: "Agents advise. A pharmacist decides.",
    body: "Eight agents, four in background mode. Rules decide, the model explains, a gate checks the model. Bedrock, Anthropic, OpenAI-compatible or local models." },
  { file: "05-recall", img: "docs/img/recall-impact.jpg", kicker: "Recalls", title: "From a faxed notice to the exact patients",
    body: "The Coroner keeps only lots printed in the notice. Units are quarantined and the patients who took one home are listed, ready to reach." },
  { file: "07-register", img: "docs/evidence/screens/browser-cashier-register.png", kicker: "Cashier view", title: "Each role sees only its job",
    body: "The cashier gets pickup and the register, never allergies, birth dates or recalls. An admin sees partner access only. The server enforces it." },
  { file: "08-dscsa", img: "docs/evidence/screens/browser-pharmacist-dscsa.png", kicker: "DSCSA & trace", title: "Package-level traceability",
    body: "EPCIS 2.0 export and import, a sandbox verifier and suspect-product cases, built on the same lot ledger." },
  { file: "09-integrations", img: "docs/evidence/screens/browser-pharmacist-integrations.png", kicker: "Integrations", title: "Open to other systems",
    body: "REST, MCP and FHIR R4 behind OAuth scopes, HMAC-signed webhooks, and designed seams for SMS, e-prescribing, EHR, payer and KMS." },
  { file: "10-refills", img: "docs/evidence/screens/browser-pharmacist-refills.png", kicker: "Refills", title: "Refills that know the lot",
    body: "Adherence (PDC), medication sync, and a hold on any refill whose last fill came from a recalled lot." }
];

const html = (c) => `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0}
  body{width:1500px;height:1000px;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#ECEDF2;
    background:radial-gradient(ellipse at 85% 10%,#2a2160 0%,#14112b 45%,#0B0D12 80%)}
  .copy{position:absolute;left:80px;top:90px;width:470px}
  .brand{display:flex;align-items:center;gap:12px;font-weight:700;font-size:22px;color:#BDAEFF}
  .k{margin-top:70px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#9E8BFF;font-size:22px}
  h1{margin:16px 0 0;font-size:56px;line-height:1.08;letter-spacing:-.02em;font-weight:800}
  p{margin:28px 0 0;font-size:25px;line-height:1.5;color:#C9CBD6}
  .foot{position:absolute;left:80px;bottom:70px;font-size:18px;color:#8B90A0}
  .shot{position:absolute;left:600px;top:120px;width:1000px;height:760px;object-fit:cover;object-position:left top;border-radius:18px 0 0 18px;
    border:2px solid #3a3360;border-right:0;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 8px rgba(139,115,255,.10)}
</style>
<div class="copy">
  <div class="brand"><svg width="30" height="30" viewBox="0 0 200 200"><defs><mask id="m"><rect width="200" height="200" fill="#fff"/><circle cx="128" cy="86" r="62" fill="#000"/></mask></defs><circle cx="90" cy="104" r="72" fill="#9E8BFF" mask="url(#m)"/></svg>Chimera Rx</div>
  <div class="k">${c.kicker}</div>
  <h1>${c.title}</h1>
  <p>${c.body}</p>
</div>
<img class="shot" src="${shot(c.img)}" alt="">
<div class="foot">Real app, synthetic data · pjborad.github.io/Chimera-Rx</div>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  for (const c of cards) {
    await page.setContent(html(c), { waitUntil: "load" });
    const file = path.join(out, `${c.file}.jpg`);
    await page.screenshot({ path: file, type: "jpeg", quality: 88 });
    console.log("wrote", file);
  }
} finally {
  await browser.close();
}
