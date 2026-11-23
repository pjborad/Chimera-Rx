# Demo script

A 3-minute path for the video and for a judge, an 8-minute path for a longer look, and a table for when something fails.

Timestamps are **targets**, not measurements. `pnpm e2e` proves every step works (40 of 40 checks), but nobody has timed a person doing this on camera. Rehearse once and adjust. Judges need not watch past 3:00, so the story is front-loaded.

## Before you start

```bash
pnpm install --frozen-lockfile
pnpm setup                # once; needs network for the OCR model
pnpm dev                  # API :4000, web :5173
```

Or `docker compose up` and open http://localhost:4000 (the Docker image was not built on the machine that wrote this repo).

- Use Chrome on `localhost` (the camera needs `localhost` or HTTPS).
- Sign in as the pharmacist, `j.rivera@elmstreetrx.example` / `moonlight-rx-2026`. Other accounts are in the [README](../README.md#demo-accounts).
- For a model-free run with sensible text, start the API with `LLM_PROVIDER=mock` (the Docker image uses `none`, which shows "rules only"). To use a real model, see the README's AI agents section.
- Reset between takes: restart the API (the seed is rebuilt on a fresh data directory).
- Optional: open **Test labels** on a phone or print it, so you can hold codes up to the webcam. Without a camera, paste a code into the scan box.

## Demo tools

The product screens carry no demo content, and there is no Demo guide page or scenario launcher. Sign in by typing the account (README, demo accounts). The recording pipeline lives in `scripts/demo/` (`pnpm demo:record:submission`, see [DEMO_VIDEO_SCRIPT.md](DEMO_VIDEO_SCRIPT.md)); it runs its own copy of the app on ports 4660 to 4663. The demo notice (pharmacy-safety rule 10) stays on every staff page.

## 3-minute path

Start on a fresh seed. The seeded state has the recall fax D-0417-2026 waiting.

| Time | Screen | Do and say |
| --- | --- | --- |
| 0:00 | Sign-in | "When a drug lot is recalled, a pharmacy knows who got the drug, not which lot. So it warns everyone, or no one." Point at the demo notice. Sign in as the pharmacist. |
| 0:15 | Today | The red banner: recall fax D-0417-2026 arrived. "197 units on the shelf, 17 patients took one home." Say the path: recall notice, quarantined lots, patients, messages. |
| 0:30 | Recalls | **Start recall**, then **Read this fax with OCR**. The browser reads the image, openFDA confirms the record, the Coroner pulls both lots. "A lot is kept only if it is printed in the notice. The model cannot add one." |
| 0:55 | Recalls | Review impact: units moved to quarantine, the patient list, the channels per consent. |
| 1:10 | Recalls | Messages: press **Use AI draft** (agent output is labelled "AI advisory, a pharmacist decides"), tick the attestation, send. "Nothing leaves this laptop: it goes to a sandbox outbox." Open **Sandbox outbox** to show a text carrying the pharmacy phone and STOP. |
| 1:40 | AI agents | Run the Coroner and the Rx Watcher Explainer on their sample input. Show a dropped item in the run detail. "Rules decide, the model explains, a gate checks the model, a pharmacist decides." Mention the provider switch (Bedrock default, Anthropic, OpenAI-compatible, mock, none). |
| 2:05 | DSCSA & trace | **Download .jsonld** for a lot and **Ask the sandbox verifier**. "Package-level lot and serial events as EPCIS 2.0, so the recall trace can be exchanged. A sandbox, not a filing." |
| 2:25 | Refills | Open the worklist: due refills, adherence, med sync. "A refill for a patient whose last fill came from a recalled lot is held, and stays held after the recall closes." (The red recall-hold row appears in the *Recall-aware refill* scenario, in the 8-minute path.) |
| 2:40 | Integrations or Transfers | One sentence: partner REST, MCP and FHIR with scoped keys; two stores with transfers that keep lot and serial. |
| 2:50 | Kiro | Show `.kiro/`: steering with the safety rules, specs, hooks. "Built with Kiro. Eleven safety rules are tested one by one." |

## 8-minute path

Do the 3-minute path, then add these in order. Each scenario resets the data, so do them after the recall steps.

| Time | Screen | Do and say |
| --- | --- | --- |
| 3:00 | Receiving | Start the camera (or paste a code from Test labels) on the amoxicillin label. Four checks pass: invoice, transaction information, expiry, recall. Confirm. "The lot and serial are now in the ledger." |
| 3:30 | Receiving | Scenario **Suspect product**: scan the label marked suspect. The TI/TS check fails and only **Report a problem** works. On DSCSA & trace it appears as a suspect case. |
| 4:00 | Fill & pickup | Rx 0072210 (insulin). Rx Watcher flags twice-daily dosing written as a 90-day supply. The order can't be scanned until a pharmacist approves, rejects or sends a change request. Approve, then scan the pen. "The lot is saved on the prescription. That is the link nobody records today." |
| 4:40 | Today | Scenario **Class I recall**: Recalls, look up `D-0611-2026`. Lot GX4471C is confirmed, pens are quarantined, patients listed. |
| 5:20 | Refills | Scenario **Recall-aware refill**, then look up `D-0611-2026`. Priya's row turns red and links to the recall. Draft reminders: the recalled row gets none. |
| 6:00 | Transfers | Move a package to Store 2. Both audit logs record it. Sign in as `s.okoro@birchavenuerx.example` to see it arrive and the mirrored recall. |
| 6:40 | Register | Sell an over-the-counter item and one verified prescription. A recalled lot is blocked by name. |
| 6:50 | Today | Scenario **Agent catches it**: stay on Today. Rx Guardian is on in the background; within about a minute the Suggestions card shows late insulin fills, a GLP-1 pen interaction and a recalled lot in the history (or press Run now on AI agents). Open the order, read the evidence, accept one: the order goes on hold. The agent never changes an order. |
| 7:10 | Roles and audit | Sign in as the cashier: no allergies or birth dates, no outbox. Then `GET /api/audit/verify` returns the chain as intact. |
| 7:40 | Security | Open `docs/SECURITY.md`: what is encrypted, how the key rotates, what is not covered. |

## If something fails

| Symptom | Cause | Fix |
| --- | --- | --- |
| Blank page after rebuilding | Old tab holding stale assets | Hard-reload. The API reads the web build from disk on every request, so no restart is needed. |
| Sign-in or any POST says "That origin is not allowed." | The web app runs on a port not in the CORS list | Set `CORS_ORIGINS=http://localhost:<web port>` and restart the API. |
| AI agent shows "rules only" | Provider is `none`, or the model call failed and the provider is paused for 60 s | Choose `mock` on the AI agents screen, or fix the credentials and press **Test connection**. |
| Bedrock test fails | No AWS credentials, wrong region or no model access | Set `AWS_REGION`, `AWS_PROFILE`, `BEDROCK_MODEL_ID`, or switch to `mock`. Live Bedrock was checked once on 2026-11-20; model IDs are retired over time, so list current ones with `aws bedrock list-inference-profiles`. |
| Camera does not start | Not on `localhost` or HTTPS, or permission denied | Paste a code from Test labels into the scan box, or use a USB scanner. |
| OCR slow the first time | The first read loads a 4 MB model | Read once before recording. If `apps/web/public/ocr` is empty, run `pnpm setup` (needs network). |
| openFDA unreachable | No network | The app falls back to the recall fixtures and says so. |
| The Today screen shows data from a previous take | State persists in `DATA_DIR` | **Reset demo** on Today. |
| Port 4000 or 5173 is busy | Another run | `API_PORT=4530 pnpm dev:api` and `pnpm --filter @chimera-rx/web exec vite --port 5530`, with `API_URL=http://127.0.0.1:4530` and `CORS_ORIGINS=http://localhost:5530`. |
| `pnpm install` complains about the lockfile | Wrong pnpm version | Use pnpm 12 (`packageManager` in `package.json`). |
| Account locked | Five wrong passwords | Wait 15 minutes, or restart the API (counters are in memory). |

## Rehearse without a camera

```bash
pnpm dev          # one terminal
pnpm e2e          # another; BASE=http://localhost:5173 by default, resets the data
```

This drives the real UI in Chromium with a fake webcam and real OCR, from receiving to messages sent, plus AI agents, refills, DSCSA, register, transfers and cashier restrictions. The MFA check runs only when the API is started with `MFA=1`. It does not test a physical webcam, lighting or print quality. Run `npx playwright install chromium` once if the browser is missing.
