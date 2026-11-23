# Review fix A: F03 read authorization matrix, F07 provider destination policy

Branch `fix/review-2026-11-22`. Synthetic data only. Nothing pushed.

## What changed

F03
- `apps/api/src/access.ts` (new): `ACCESS`, one table of `"METHOD /pattern"` to allowed roles (or `public`, `partner`, `static` with a reason per entry). 129 rows, one per registered route.
- `apps/api/src/app.ts`: an `onRoute` hook records every registered route (`app.routeTable`, used by the test), and the session `preHandler` now applies the table after the session check: 401 without a session, 403 for an unlisted role, 403 `route_unlisted` for a route with no row (default deny). Existing handler checks are untouched and can still be stricter.
- `apps/api/src/today.ts` `todayView`: the Rx Watcher tasks ("Review Rx ... for <patient name>") went to every role, including cashier and admin. They are now built for pharmacist and technician only.
- `apps/api/src/agents/routes.ts`: no per-route edits were needed for F03; reads such as `/api/agents/runs`, `/api/agents/:id` are gated by the table (pharmacist, technician).
- Web (minimal): `apps/web/src/screens/AIAgents.tsx` no longer requests `/api/agents/runs` for the admin and hides "Recent runs" for the admin; `apps/web/src/App.tsx` and `apps/web/src/components/Shell.tsx` take the Recalls screen and its nav item away from the cashier (it called `/api/recalls`, now 403).
- `docs/SECURITY.md`: new section "Read authorization matrix" (and a "Provider destination policy" subsection).

Roles chosen: agent run history, per-agent records, Guardian suggestions, recall list/detail/results/messages, fax inbox, audio, outbox: pharmacist and technician. Voicemail draft, calls, audit PDF, trace export, agent drafts: pharmacist. Cashier keeps today, pickup queue and order (no DOB or allergies, as before), register, lots, deliveries, labels, search. Admin keeps integrations, audit, agents provider, today, me.

F07
- `apps/api/src/agents/destination.ts` (new): `checkDestinationLiteral` (URL class parse; refuses credentials, non-http(s), link-local 169.254/16 and fe80::/10 in every form, IPv4-mapped/compatible/NAT64/translated IPv6 in dotted and hex form, decimal/octal/hex IPv4, trailing dots, upper case, fd00:ec2::/32, `metadata.*` and `instance-data` names) and `assertDestination` (same, then `dns.lookup(all)` for host names; any blocked answer or no answer refuses).
- `apps/api/src/agents/routes.ts` `checkBaseUrl` now calls the shared literal check (422).
- `apps/api/src/agents/providers.ts` `OpenAiCompatibleProvider.complete`: `assertDestination` before the request (so a URL from `OPENAI_BASE_URL` or saved earlier is checked too, and a refused destination gets no request and no key), and `redirect: "error"`. `RuntimeDeps.lookup` and a 5th constructor argument allow a stubbed resolver.
- Localhost, 127.0.0.0/8, `::1`, `::ffff:127.0.0.1` stay allowed (Ollama 11434, LM Studio 1234).

## Tests

`apps/api/test/review-f03-f07.test.ts` (51 tests):
- F03: routes vs matrix both ways (a route with no row, or a row with no route, fails); default deny via a route added to a fresh app; anonymous 401 and unlisted role 403 on every session row; every listed GET is answered for each listed role; cashier and admin reads contain no patient id, allergy key or DOB outside an explicit allowlist with a reason per entry (`PICKUP_READS`); the reviewer's reads (runs, rx-guardian, recalls, recall detail, results, messages, fax, outbox, suggestions, voicemail, calls, report.pdf, trace-export); Today has no patient-naming tasks for cashier and admin; cashier pickup and admin integrations reads still 200; partner rows do not accept a staff session.
- F07: 28 refused and 9 allowed URL forms; numeric (not prefix) checks; settings route 422 for each form and 200 for localhost endpoints; resolution to a blocked address (IPv4, mapped dotted and hex, fe80, fd00:ec2) refused; unresolvable name refused; refused destination gets no fetch call; allowed call uses `redirect: "error"`; an env-supplied bad URL never reaches fetch. All with stubbed fetch and DNS.
- One existing test edited: `apps/api/test/agents.test.ts` "OpenAI-compatible: base URL ..." now passes a stub resolver for the `x.openai.azure.com` call, because the provider resolves host names before calling.

Reviewer file run on this tree (copy, then removed): the 10 F03 cases (4 agent reads, 6 recall reads) pass. The other 4 failures in that file belong to other items (interaction rule "Sold here", recall propagation with a pending row, transfer rollback, slow review vs hold).

## Commands and results
- `pnpm typecheck`: clean.
- `pnpm test`: 21 files, 415 tests passed (before: 364).
- `pnpm build:web`: built.
- API on `API_PORT=4610`, temp `DATA_DIR`, `OFFLINE=1`; stopped by PID.
- `BASE=http://localhost:4610 node scripts/e2e/crawl.mjs`: 160 page visits across all four roles plus store 2, zero `http 4xx` lines. Only a benign `ERR_SOCKET_NOT_CONNECTED` on the first `/` load per context.
- `BASE=http://localhost:4610 node scripts/e2e/demo-e2e.mjs`: 49/49 passed (cashier register sale, pickup, admin flows, cashier 403 on patient records; MFA step skipped because the API ran without MFA=1).

## Not done, or left on purpose
- No sanitized count-only summary endpoint was added: the web needs none (Today already carries counts).
- `POST /api/calls/inbound` (cashier allowed, existing platform test requires it) returns patient id, name and recall id; `POST /api/sms/inbound` (all roles, existing matrix test) returns the patient id. Both left open as before and documented.
- DNS rebinding: the name is resolved for the check and again by `fetch`; pinning needs a custom undici dispatcher. Documented as residual risk.
- Stored credentials are not bound to an approved origin when the base URL changes (the review's third fix clause); not in this item's brief and it changes key handling. Documented as residual risk.
- Partner surfaces (`/v1`, `/mcp`, `/fhir`) keep their own OAuth scope checks; they are in the table as `partner` and the test shows a staff session does not open them. Per-scope behaviour was not changed.
