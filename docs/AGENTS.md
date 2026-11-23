# AI agents

Eight agents, one rule: **rules decide, the model explains, a gate checks the model, a pharmacist decides.** Output is labelled "AI advisory, a pharmacist decides". Code is in `apps/api/src/agents/`; the screen is **AI agents** in the sidebar.

Every agent has three parts:

1. A deterministic core that always runs (rules, regex, SQL).
2. An optional model layer that explains or adds a lower-confidence note.
3. A gate after the model. Anything the rules or the source text do not back up is dropped and listed.

With provider `none`, or when a call fails, the agent shows the core output labelled "rules only". Every run is stored (latest 300) with provider, model, latency, the de-identified prompt, the raw answer, the gated answer and the dropped list. Each run a person starts is audited (`agent.run`).

## The agents

| Agent | Who may run it | Input | Core (always) | Model may | Gate |
|---|---|---|---|---|---|
| Coroner | pharmacist, technician, admin | notice text | regex lots and NDCs | read the notice a second time | A lot must appear verbatim in the notice. Others are dropped and shown. Lots under 0.95 confidence or without expiry still need a pharmacist to confirm one by one. |
| Rx Watcher Explainer | pharmacist | Rx number | the Rx Watcher rule findings | write a summary, up to 3 notes, a prescriber message draft | Rule hits are copied through unchanged. A summary that calls the order fine while a hit exists is dropped. Notes are severity `monitor`, labelled "AI suggestion". Notes that try to undo a hit are dropped. Extra fields (such as `removeRules`) are ignored and listed. Nothing is saved to the prescription. |
| Recall Outreach Drafter | pharmacist | recall number | the approved SMS, email and voicemail templates | rewrite the four templates with placeholders | A piece is dropped (default used) if it names anyone, carries another phone or an email, uses an unknown placeholder, lacks the pharmacy phone, or breaks the voicemail rules (no medicine, reason or patient ID). STOP is appended to texts. Drafts go to `ai_drafts` (status `draft`). There is no send path. Sending stays in Recalls, with the pharmacist's attestation and a consent check. |
| Refill Outreach | pharmacist, technician | none (today's refill worklist) | the approved refill-reminder templates for patients whose refill is due | reword the four templates with placeholders | Same gates as the Recall Outreach Drafter, plus: a patient whose last fill came from a recalled or quarantined lot, and any Schedule II drug, never get a reminder; a text must carry the pharmacy phone and STOP; a voicemail never names the medicine. Drafts go to `ai_drafts` (recall id `REFILL`). There is no send path in the agent: a pharmacist attests and sends from Refills, and consent is read again then. See `docs/REFILLS.md`. |
| Night Watch | pharmacist, admin | none | digest of open recalls, shortages, expiring lots, held orders | write the summary | Every number must exist in the digest. No claim that anything was confirmed, sent or ordered. It never confirms a lot. The scheduler runs it daily at 06:00 UTC and once at start-up. |
| Stock and Shortage Advisor | pharmacist, technician | none | `stockhelp.ts` reorder, expiry risk, shortages | one sentence per item | A sentence with a number not in its item is dropped. Numbers are never read back from the model. |
| Pharmacist Copilot | pharmacist, technician | a question | a keyword router calls one read-only tool | call up to three read-only tools, then answer | Tool names outside the list are never run. The answer may only contain lots, patient IDs and numbers from tool results or the question. Otherwise the rules-only answer shows. |
| Rx Guardian | pharmacist runs it; a pharmacist or admin switches it on | none (sweeps open orders) or one Rx | rules over the patient's whole history (below) | explain each hit, add one lower-confidence note | Every rule hit stays. A sentence with a number the hit's facts lack, a note citing a history fact that does not exist, or "this is fine" wording is dropped. |

Copilot tools: `lot_lookup`, `units_on_shelf`, `patients_for_lot` (pharmacist only, IDs only), `open_recalls`. None writes.

## Background mode and Rx Guardian

Four agents can run on their own once a pharmacist or admin switches them on (AI agents screen, `POST /api/agents/:id/enable` and `/disable`, audited): Rx Guardian (every new or changed order, checked each minute, and at least every 5 minutes), Night Watch, Stock Advisor and Refill Outreach (daily). The existing minute tick in `server.ts` drives `backgroundTick` (`agents/background.ts`); a run never blocks a request, a provider failure degrades to "rules only", and one failing agent never stops the loop. Each agent shows enabled, last run, next run and runs today. `AGENTS_BACKGROUND=0` turns the scheduler off (Run now still works). With `SEED_SYNTHETIC` on (the default), the seed switches Rx Guardian on.

Rx Guardian (`agents/guardian.ts`) checks an order against fills, lots, allergy class codes, active medicines, age band and earlier suggestions: duplicate therapy, drug-drug interaction (Rx Watcher's table plus a small synthetic demo table), allergy class, dose or days supply against the directions, early refill, non-adherence (PDC from `refills.ts`) and late refills, a recalled or quarantined lot in the history, a Schedule II pattern (early fill, three or more prescribers) and a dose above a demo age-band ceiling. Rx Watcher findings are reused with the same severity. The interaction and age-band tables are synthetic demo tables, not clinical content. Prompts carry the patient ID, drug names, dates, lot numbers, an age band and class codes (an allergy appears only as a code such as PCN).

Each finding is a suggestion (`/api/suggestions`) with evidence, an explanation and a status (open, accepted, dismissed, or resolved by the system when the history no longer backs it). The agent never changes an order. A pharmacist accepts (the order goes on hold with the reason), dismisses (a reason is required) or sends a prescriber change request through the existing path. A technician can read suggestions; a cashier and an admin get 403. Evidence, explanation, title and decision reason are stored encrypted.

**The 60-second path:** sign in as the pharmacist and stay on Today. The seed switches the Rx Guardian on; within about a minute the Suggestions card lights up for the seeded orders (or press Run now on Rx Guardian on the AI agents screen). Open an order on Fill & pickup, read the evidence, accept one suggestion, and the order is on hold.

The scripted "Agent catches it" case (a new insulin order, Rx 0072301, for a patient with late fills, an active semaglutide pen and a last fill from recalled lot GX4471C) is a fixture in `apps/api/test/scenario-fixtures.ts`, run by `apps/api/test/guardian.test.ts` and `pnpm e2e`. The product has no scenario launcher.

## MCP

Three read-only tools on the existing `/mcp` endpoint: `agent_night_watch_digest`, `agent_stock_advisor`, `agent_copilot`. They need the new scope `agents.read`. The seeded partners lack it, so their tool lists are unchanged. The copilot runs at technician level there, so partners never get patient IDs, and the MCP output filter redacts them anyway.

## Switching provider

On the AI agents screen: pick a provider, model, region or base URL, paste a key, **Save**, then **Test connection**. Only a pharmacist or admin can change it. Each change is audited without the key.

At start-up the provider comes from `LLM_PROVIDER` (empty means `bedrock`). All settings are in `.env.example`.

| Provider | Settings |
|---|---|
| `bedrock` (default) | Converse API. `AWS_REGION`, `BEDROCK_MODEL_ID`. Credentials come from the default AWS chain: `AWS_PROFILE`, environment keys, SSO or a role. |
| `anthropic` | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |
| `openai-compatible` | `OPENAI_BASE_URL`, `OPENAI_API_KEY` (optional for local servers), `OPENAI_MODEL`. Covers OpenAI, Azure OpenAI, Ollama (`http://localhost:11434/v1`), LM Studio (`http://localhost:1234/v1`) and vLLM. |
| `mock` | Deterministic and offline. No key. Use for demos without network. |
| `none` | Rules only. |

**Keys.** A key pasted in the UI lives in server memory only. It is not written to disk, not logged, not returned (the screen shows the last four characters), and it is scrubbed from error text. A restart forgets it. After a failed call the provider pauses for 60 seconds so agents fall back to rules only quickly; Test connection ignores the pause. The OpenAI-compatible base URL must be http(s), with no credentials in it and not in the link-local range.

## Adding a provider (about 20 lines)

In `apps/api/src/agents/providers.ts`:

```ts
export class MyProvider implements ProviderClient {
  readonly id = "my-provider" as const;   // add it to ProviderId and PROVIDER_IDS
  readonly name = "my-provider";
  constructor(private apiKey: string, readonly model: string, private fetchFn: typeof fetch = fetch) {}
  async complete(system: string, user: string): Promise<string> {
    const res = await this.fetchFn("https://api.example.com/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, system, input: user }),
      signal: AbortSignal.timeout(30_000)
    });
    if (!res.ok) throw new Error(`my-provider returned HTTP ${res.status}`); // never put the body or key in an error
    return String((await res.json()).text ?? "");
  }
}
```

Then add the id to `DEFAULT_MODELS` and `PROVIDER_LABELS`, and a `case` in `AgentRuntime.build()`. The gates and records need no change.

## How PHI stays out of prompts

- Prompts carry patient IDs (`S-0417`), drug, directions, quantities, lot numbers and rule titles. Never a name, phone, email, date of birth or allergy list.
- The outreach model writes templates with `{first_name}`. First names are merged after the model answers, one recipient per draft, and stored as templates (placeholders only).
- A pharmacist's free-text question is de-identified first: names, phones, emails and dates of birth are replaced.
- Before any call, `LlmCall.ask` scans the prompt against the patient table. If it finds a name, phone, email or date of birth, the call is not made and the run is "rules only" with the reason. The recall-notice text for the Coroner is a public FDA source and is exempt.
- Stored raw model output has phone numbers and emails masked.
- Tests: a spy provider records every prompt from every agent and every prescription, and checks them against all patients (`apps/api/test/agents.test.ts`).

This is a pilot sandbox with synthetic data. It is not a compliance claim.
