// Renders the Devpost (3:2) and YouTube (16:9) thumbnails from docs/media/thumbnail.html.
// Usage: node scripts/demo/thumbnail.mjs
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = pathToFileURL(path.join(root, "docs/media/thumbnail.html")).href;
const sizes = [
  { name: "thumbnail-devpost.png", w: 1500, h: 1000, cls: "tall" },
  { name: "thumbnail-youtube.png", w: 1280, h: 720, cls: "wide" }
];

const browser = await chromium.launch();
try {
  for (const s of sizes) {
    const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
    await page.goto(src);
    await page.evaluate(([w, h, cls]) => { document.body.classList.add(cls); document.body.style.setProperty("--w", `${w}px`); document.body.style.setProperty("--h", `${h}px`); }, [s.w, s.h, s.cls]);
    await page.waitForLoadState("networkidle");
    const out = path.join(root, "docs/media", s.name);
    await page.screenshot({ path: out });
    console.log("wrote", out);
    await page.close();
  }
} finally {
  await browser.close();
}
