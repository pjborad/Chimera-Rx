# Devpost submission, ready to paste

Every field of the Kiroween 2026 entry form, in order. Copy each block into the matching box. Items marked **YOU** need the owner (an upload, a post, or a login only the owner has).

## 1. Category and bonus prizes (decided)

| Choice | Decision | Why |
|---|---|---|
| **Category** | **Frankenstein** | Chimera Rx stitches parts that were never meant to fit into one working app: GS1 DataMatrix scanning, browser OCR, openFDA, a regex + LLM lot extractor with a verbatim gate, deterministic Rx rules, NCPDP SCRIPT-shaped change requests, REST, MCP and FHIR R4 behind OAuth, signed webhooks, EPCIS 2.0, text-to-speech voicemail and a hash-chained audit log. That is the Frankenstein brief exactly. |
| Bonus: Social Blitz | **Enter** | Needs one public post that starts with `#KiroweenHackathon26`. Draft in section 9. **YOU** post it. |
| Bonus: Blog | **Enter** | Needs one public blog post that says it was written for Kiroween 2026. Draft in section 10. **YOU** publish it. |
| Bonus: Best Kiro Crew App | Skip | The bonus is for an app built *as* a Kiro Crew app. Chimera Rx used Kiro Crew to build it, but is not a Crew app. |
| Bonus: Startup | Skip | Needs a founder confirmation and a startup website. This is a competition entry, not a startup. |
| Bonus: Best Student | Skip | Needs current student enrolment. |
| Skeleton Crew rule | Not applicable | Only for the Skeleton Crew category. |

## 2. Project name and tagline

**Name:** Chimera Rx

**Tagline:** A modern pharmacy system: one connected ledger for every lot, patient and prescription, AI agents working in the background, and a pharmacist who decides.

## 3. Links

| Field | Value |
|---|---|
| Working app | https://pjborad.github.io/Chimera-Rx/app/ |
| Project website | https://pjborad.github.io/Chimera-Rx/ |
| GitHub repo (public, MIT, `.kiro/` at the root) | https://github.com/pjborad/Chimera-Rx |
| Demo video (YouTube, public) | **YOU**: upload `demo-video/chimera-rx-submission.mp4` (2:55) and paste the link. See section 8. |

## 4. Login and testing instructions (private field, judges only)

```text
Open https://pjborad.github.io/Chimera-Rx/app/ in Chrome, Edge or Firefox on a desktop or laptop. Nothing to install.

Sign in (synthetic staff accounts, shared password moonlight-rx-2026):
  Pharmacist  j.rivera@elmstreetrx.example   (sees everything clinical; start here)
  Technician  k.patel@elmstreetrx.example    (receiving, inventory, fill)
  Cashier     m.diaz@elmstreetrx.example     (pickup and register only; no allergies, DOB or recalls)
  Admin       s.grant@elmstreetrx.example    (partner integrations only)
Second store (pharmacy picker on sign-in): s.okoro@, t.lund@, c.reyes@birchavenuerx.example, same password.

A 3-minute path as the pharmacist:
  1. Today: open work, the recall banner and Rx Guardian suggestions.
  2. Fill & pickup: open the insulin order, read the Rx Guardian evidence, accept a suggestion (the order goes on hold).
  3. AI agents: press Run now on Rx Guardian; see background mode and the provider settings.
  4. Recalls: look up D-0611-2026 to see the units quarantined and the patients who took one home, then draft messages (they only go to the Sandbox outbox).
  5. Integrations: REST, MCP and FHIR partners, OAuth scopes, signed webhooks.
  6. Sign out and sign in as the cashier, then the admin, to see the server-enforced limits.

About this hosted version: it is the real app and API code running inside your browser on a synthetic database, so there is no server to wait for. Data resets when you reload. AI agents use the built-in offline model (no keys in a public page). The camera scan needs a webcam; Receiving also accepts typed codes.

The full server version (same code, real API, live AI providers): one click in GitHub Codespaces from the README, or `docker compose up`, or `pnpm install && pnpm setup && pnpm dev`.

Everything is synthetic. No message reaches a real person. Not for clinical use.
```

## 5. Text description (features and functionality)

```text
Chimera Rx modernizes the pharmacy counter.

Most pharmacies still run on fax machines, phone calls, paper logs and separate systems that never talk to each other. Wholesalers track a package by lot and serial; dispensing software tracks the patient. Nothing links the two, so when a lot is recalled the pharmacy has to warn everyone or no one. Alerts arrive one popup at a time and most are overridden. Chimera Rx replaces those islands with one connected ledger, open standards, and AI agents that watch it all day, with a pharmacist making every decision.

WHAT IT DOES
- One lot ledger. The lot and serial are captured from the GS1 DataMatrix (webcam or USB scanner) or by browser OCR at receiving and again at fill, and tied to the patient.
- Receiving with four checks: invoice, supplier transaction data, expiry and recall. Schedule II receipts need a witness.
- Fill & pickup with deterministic Rx Watcher rules and a prescriber change-request loop (NCPDP SCRIPT-shaped, sandbox).
- A front-store register that also sells a patient's verified prescriptions and refuses recalled lots.
- Recalls end to end: a faxed notice read by OCR or an openFDA lookup, lots extracted by the Coroner, units quarantined, the exact patients found, consent-checked messages drafted, a pharmacist attests and sends to a sandbox outbox.
- Recall-aware refills with adherence (PDC), medication sync and a recall hold.
- DSCSA-style traceability: EPCIS 2.0 export and import, a sandbox verifier and suspect-product cases.
- Two stores with transfers that keep lot and serial, and recalls mirrored across stores.

AI AGENTS (eight, one rule: rules decide, the model explains, a gate checks the model, a pharmacist decides)
- Rx Guardian runs in the background, checks every new order against the patient's whole history and raises suggestions with evidence. A pharmacist accepts or dismisses.
- Coroner reads recall notices; any lot not found verbatim in the source is dropped, even if the model insists.
- Recall and Refill Outreach drafters, Night Watch digest, Stock and Shortage Advisor, Pharmacist Copilot and the Rx Watcher Explainer.
- Providers: Amazon Bedrock (default), Anthropic, any OpenAI-compatible endpoint (including local Ollama or LM Studio), an offline mock, or rules only. Prompts never carry names, phones, emails or dates of birth.

OPEN BY DESIGN
- REST, MCP and FHIR R4 partner APIs behind OAuth 2.0 scopes, and HMAC-signed webhooks.
- A placeholder map for every real-world connection (SMS, email, phone calls, wholesaler EDI and EPCIS, DSCSA verification, e-prescribing, dispensing system, EHR, payer, secrets manager and KMS, SSO): designed seams, sandboxed today, nothing reaches a real person.

SAFEGUARDS
- Patient fields encrypted at rest (AES-256-GCM, key rotation), server-side role checks with default deny, optional MFA, rate limits, and a hash-chained audit log.
- Eleven pharmacy safety rules, each mapped to the code that enforces it and a test that proves it.
- An independent review found eight defects; all are fixed, with acceptance tests in the repo.
- Built with HIPAA-style safeguards, not certified. Synthetic data only; not for clinical use.

TESTED
476 unit, API and property-based tests, plus end-to-end browser runs of the real UI (49 of 49 checks on the server build, 57 of 57 on the hosted browser build).
```

## 6. How Kiro was used (the write-up)

```text
Chimera Rx was built with Kiro from a written spec and HTML mockups, with a person directing each step. The honest account, including what was not done, is in docs/KIRO_USAGE.md in the repo.

KIRO IDE, CLI AND CREW, AND HOW THEY DIFFERED
- Kiro IDE built the first product: specs, steering, hooks, and turning six HTML mockups into React screens. One agent, one conversation, a person steering every step.
- Kiro Crew ran the later rounds as a team. A team-lead agent took a goal ("harden security", "add AI agents", "fix the eight review findings"), split it into items, wrote a brief per item and dispatched background worker agents in parallel, each with its own files and port range. The lead then re-ran the tests and read the diffs itself before anything was pushed. The difference: in the IDE you drive; in Crew you hand over a goal and the lead keeps several workers busy and checks their claims instead of trusting them.
- Kiro CLI ran the AI-DLC planning workflow (intent, feasibility, requirements, user stories), with hooks that refuse to advance a gate without the owner. Kiro Web was not used.

CUSTOM AGENTS
.kiro/agents/coroner.json is scoped to packages/coroner and packages/gs1, preloads the GS1 and safety steering plus the Coroner spec, and must run the property tests before it finishes. That kept lot-extraction work from leaking into the app and from weakening the rule "never invent a lot". The AI-DLC personas in .kiro/agents (product, architect, developer, quality and others) produced the planning record. In Kiro Crew, workers got a per-item brief instead of a fixed persona, and a separate reviewer agent audited the API and the web app.

AGENT HOOKS
- phi-guard: runs before shell commands and blocks any git commit whose staged files look like real patient data. Every worker commits through it, so "synthetic data only" is enforced, not just requested.
- pbt-on-save: runs the Coroner and GS1 property tests whenever those files are saved.
- usage-log: appends each finished spec task to a log.
- The AI-DLC hooks record each human turn and guard state changes, so no agent can approve a planning gate on its own.

SPEC-DRIVEN DEVELOPMENT VS VIBE CODING
The Coroner (recall lot extraction) and Summoner (openFDA client) were built from EARS requirements in .kiro/specs, with requirements.md, design.md and tasks.md. Each requirement has an ID that travels into the tests, for example COR-3: "never emit a lot that is not in the source text". That made the most dangerous rule testable and it survived every later LLM change. The app modules built faster from a plan and mockups, without per-module specs, drifted more: an independent review found eight defects, all in those modules and none in the spec-driven packages. That is our clearest comparison: specs cost time up front and paid it back where mistakes are expensive.

STEERING
.kiro/steering/pharmacy-safety.md loads on every request and ranks above any feature request; tech.md and product.md load with it, and gs1-standards.md loads only for the GS1 package. The strategy that made the biggest difference was writing rules as checkable facts rather than intentions: the exact phone format (555) 010-01xx, the exact demo notice text, "never show an inferred serial as scanned", "a lot under 0.95 confidence needs a pharmacist". Workers and reviewers could check their own output against them, and the review used them as acceptance criteria.

MCP
Kiro Crew's MCP servers carried the team work: dispatching and steering worker agents, the work ledger, and memory recall across sessions, which made multi-day parallel rounds possible without re-explaining context. In the product itself, Chimera Rx exposes its own MCP endpoint (POST /mcp, JSON-RPC) so a partner's AI agent can ask about recalls and stock, with tools filtered by OAuth scope and patient IDs redacted.

PROPERTY-BASED TESTING
fast-check runs where one wrong answer is dangerous:
- COR-3: the Coroner never emits a lot that is not in the notice, even when a stub model lies.
- The ledger: under random sequences of receive, fill, return, adjust and recall, on hand always equals received minus dispensed, returned and adjusted, and no serial is dispensed twice.
- GS1 check digits, NDC to GTIN round trips and element strings with FNC1.
PBT caught what unit tests missed: about 1 in 97 seeded historical fills had no package, which broke the ledger invariant. Real openFDA records then found three Coroner defects that hand-written cases had missed.

KIRO POWERS
None were used for this build.
```

## 7. Project story, built with, links and gallery

- **Project story (About the project):** paste [DEVPOST_STORY.md](DEVPOST_STORY.md) as is. It is Markdown with LaTeX, and its images load from the project website.
- **Built with (25 tags, the limit):** typescript, node.js, react, vite, fastify, sqlite, zod, tesseract.js, bwip-js, webassembly, fast-check, vitest, playwright, amazon-bedrock, anthropic, openai, ollama, kokoro, openfda, gs1, epcis, fhir, mcp, oauth, kiro
- **Try it out links:** https://pjborad.github.io/Chimera-Rx/app/ · https://pjborad.github.io/Chimera-Rx/ · https://github.com/pjborad/Chimera-Rx
- **Image gallery (3:2, upload in this order):** `docs/media/gallery/00-cover.png`, then `01-today.jpg` to `10-refills.jpg`. Re-render with `node scripts/demo/gallery.mjs`.

## 8. YouTube upload (**YOU**)

- **File:** `demo-video/chimera-rx-submission.mp4` (2:55, 1920x1080). It is the same as `docs/media/chimera-rx-demo.mp4`.
- **Visibility:** Public, not Unlisted or Private. Audience: "No, it's not made for kids".
- **Captions:** upload `demo-video/chimera-rx-submission.srt` under Subtitles.
- **Thumbnail:** `docs/media/thumbnail-youtube.png` (1280x720). The Devpost project thumbnail is `docs/media/thumbnail-devpost.png` (1500x1000, 3:2). Re-render both with `node scripts/demo/thumbnail.mjs`.
- **Title:** Chimera Rx: a modern pharmacy system with AI agents (Kiroween 2026)
- **Description:**

```text
Chimera Rx modernizes the pharmacy counter: one connected ledger for every lot, patient and prescription, AI agents working in the background, and a pharmacist who decides. A walkthrough of all fourteen tabs of the pharmacist's workspace.

Try it: https://pjborad.github.io/Chimera-Rx/app/
Code: https://github.com/pjborad/Chimera-Rx
Built with Kiro for Kiroween 2026 (Frankenstein category).

Synthetic data only. Not for clinical use. Narration voices: Kokoro (open-source text-to-speech). No music.
```

- **Rights check:** no music; narration is Kokoro-82M (Apache-2.0); all screens are our own app with synthetic data. No third-party logos appear.
- After upload, send the link and it goes into the README and the website.

## 9. Social Blitz post (**YOU** post it, during the submission period)

The hashtag must be the first thing in the post.

```text
#KiroweenHackathon26 My favourite thing about Kiro: steering files that every agent has to obey.

I built Chimera Rx, a pharmacy system where AI agents work in the background and a pharmacist decides. I wrote eleven pharmacy safety rules once, as checkable facts ("never invent a lot number", "nothing reaches a real patient"), and every Kiro agent and reviewer followed them on every request. Then Kiro Crew ran the build as a team: a lead agent split each goal into tasks, ran workers in parallel and re-checked their work before anything shipped.

It changed how I build: I spend my time on rules and specs, not on re-explaining.

Try it: https://pjborad.github.io/Chimera-Rx/
```

## 10. Blog post (**YOU** publish it, during the submission period)

Suggested home: dev.to, Medium, Hashnode or LinkedIn Articles. Keep the first line.

```markdown
# Stitching a modern pharmacy together with Kiro

*Written as part of the Kiroween 2026 hackathon.*

Most pharmacies still run on fax machines, phone calls and separate systems that never talk to each other. The wholesaler knows which lot is in a box. The dispensing system knows which patient took a box home. Nothing connects the two, so when a lot is recalled, the pharmacy warns everyone or no one.

For Kiroween's Frankenstein category I built **Chimera Rx**: one ledger that captures the lot from the barcode at receiving and at fill, with AI agents that watch it in the background and a pharmacist who makes every decision. Try it in your browser: https://pjborad.github.io/Chimera-Rx/app/

## Steering first
Before any code, I wrote eleven pharmacy safety rules in a steering file that loads on every request. The trick was writing them as checkable facts, not intentions: the exact fake phone format, the exact notice text, "never show an inferred serial as scanned". Every agent could check its own work against them.

## Specs where mistakes are expensive
The recall reader ("the Coroner") was built from EARS requirements. Requirement COR-3, "never emit a lot that is not in the source text", became a property-based test that feeds the extractor a lying model and checks it still never invents a lot. The parts I built faster, without specs, are where an independent review later found all eight of its defects.

## A team of agents
Later rounds ran in Kiro Crew. A lead agent took goals like "fix the eight review findings", split them into items, dispatched workers in parallel and re-ran the tests itself before anything was pushed. Hooks blocked any commit that looked like real patient data.

## Agents in the product
The app has eight agents with one rule: rules decide, the model explains, a gate checks the model, a pharmacist decides. The Rx Guardian checks every new order against the patient's history and raises suggestions with evidence. The Coroner drops any lot it cannot find word for word in the notice.

## What I learned
Specs and steering cost time up front and paid it back where a mistake could hurt someone. And a sandbox clearly labelled as a sandbox is worth more than a claim.

Code: https://github.com/pjborad/Chimera-Rx · Synthetic data only, not for clinical use.
```

## 11. Final checklist

| Requirement | Status |
|---|---|
| Built with Kiro, `.kiro/` at the repo root with specs, hooks, steering and agents | Done |
| No `.kiro` path in `.gitignore` | Done (removed in PR #9) |
| Public GitHub repo with source, assets and instructions | Done |
| Open source licence visible in the About section | Done (MIT, detected by GitHub) |
| Working app URL | Done: https://pjborad.github.io/Chimera-Rx/app/ |
| Login details and instructions in the private form field | Section 4: **YOU** paste |
| Text description | Section 5: **YOU** paste |
| Video under 3:00, real app on screen, no music or third-party marks | Done (2:55) |
| Video on YouTube, public, link in the form | **YOU** (section 8) |
| Category and bonus categories | Frankenstein; Social Blitz and Blog (section 1) |
| How Kiro was used write-up | Section 6: **YOU** paste |
| Social Blitz post with the hashtag first | **YOU** (section 9) |
| Blog post that mentions Kiroween 2026 | **YOU** (section 10) |
| Submit before the deadline | **YOU**: confirm the date on the Rules tab |
