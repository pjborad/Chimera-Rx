# Security and patient data: pilot threat model

Chimera Rx is a sandbox pilot. It holds **synthetic data only** and is **not HIPAA-compliant, not certified and not clinically validated**. This page says what the code does to protect patient data, what it does not, and how to operate the key. Read it as a description of controls, not as a claim of compliance.

## What is encrypted

Patient fields are encrypted **at rest, inside each store's SQLite file**, with AES-256-GCM. Every value gets its own random 12-byte IV. The stored form is a versioned envelope:

```
enc:v1:<keyId>:<iv>:<tag>:<ciphertext>        (iv, tag, ciphertext are base64url)
```

`keyId` is the first 8 hex characters of a hash of the key, so a database can hold values written under several keys and still open all of them. The GCM tag authenticates every value: a flipped bit, a truncated value or the wrong key makes the value fail to open.

Protected columns (`apps/api/src/protect.ts` is the single list):

| Table | Columns |
|---|---|
| `patients` | name, dob, phone, email, allergies, conditions |
| `med_history` | sig |
| `prescriptions` | directions, review_note |
| `dispenses` | contact_json |
| `notifications` | merged_text |
| `outbox` | to_addr, body |
| `prescriber_messages` | body, response_json |
| `outreach_calls` | script, note |
| `audio` | text |
| `rx_findings` | title, body, evidence |
| `audit` | reason |

Both store databases (`chimera-rx.sqlite` and `chimera-rx-store-2.sqlite`) are covered, plus the seed data, the generated 6-month dataset, notifications and the sandbox outbox. A test opens the raw files (and the WAL) and asserts that no synthetic name, phone, email, date of birth, allergy or directions string appears in the bytes.

Left in the clear on purpose:

- Patient ids (`S-0417`), Rx numbers, lot numbers, dates of service, statuses and consent flags. The pharmacy works by these keys, and the audit log is only allowed to hold ids.
- Message subjects (`outbox.subject`, `notifications.subject`). They are fixed templates and some flows look them up in SQL. A recall subject can name a drug, so treat it as low-grade sensitive.
- Staff names and work emails, product and lot data, recall text.

### How it works in code

`Db` (`apps/api/src/db.ts`) is the only data-access path. On write it seals every bound parameter that lands in a protected column (and string literals written to one). On read it opens every `enc:v1:` value in the returned rows. Routes, the web app and partner APIs keep working on plain values. A statement that would put a protected column through an expression or `INSERT ... SELECT` throws instead of storing plaintext. A database opened from an older build is encrypted in place the first time it opens.

If a value fails to open (tampering or a missing key), the read returns the envelope unchanged, never plaintext, and a failure counter goes up. `keys:status` reports values that are unreadable.

### Search

Name, date-of-birth and phone search decrypt patient rows **in memory** and filter there. We did not use an HMAC blind index because it only supports exact match, and the Patients and Register screens need substring search on names. At pilot scale (thousands of patients per store) the cost is a few milliseconds. A production system would add a blind index for exact lookups (phone, date of birth) and a token index for names, keyed with a second key.

## Where the key lives

Provider chosen by `KEY_PROVIDER` (`env`, `file`, `kms`). Default: `env` when `DATA_KEY` is set, otherwise `file`.

| Provider | Key source | Notes |
|---|---|---|
| `env` | `DATA_KEY` (base64, 32 bytes), older keys in `DATA_KEY_PREVIOUS` | `openssl rand -base64 32` makes one |
| `file` | `<DATA_DIR>/.keys/data.key`, mode 0600, created on first start | older keys stay in `retired.keys` (0600). `data/` is gitignored |
| `kms` | placeholder | throws "AWS KMS key provider is not configured" |

Both stores in one data directory share one key. Keys are never logged and never printed by any script. The key sits on the same disk as the database in the `file` provider, so it protects against a copied `.sqlite` file or backup, not against someone with shell access to the host.

### Wiring AWS KMS (not done in this pilot)

`KeyProvider` (`apps/api/src/crypto.ts`) has three methods: `load()` returns the key ring, `beginRotation()` makes the next key durable and returns a ring holding both, `commitRotation()` switches to it. To use KMS:

1. Create a symmetric KMS key and a role that may call `kms:GenerateDataKey` and `kms:Decrypt` on it.
2. Implement `KmsKeyProvider.load()`: on first start call `GenerateDataKey`, store the **encrypted** data key (`CiphertextBlob`) next to the database, and keep the plaintext key in memory only. On later starts call `Decrypt` on the stored blob.
3. Implement `beginRotation()` (generate a second data key, store its blob alongside the first) and `commitRotation()` (mark it current). Rows keep the `keyId` of the data key that sealed them, so the ring needs both.
4. Set `KEY_PROVIDER=kms` plus your key ARN and region (add the variables you choose to `.env.example`).

## Rotating the key

```
pnpm --filter @chimera-rx/api keys:status     # counts of values per key id, plaintext and unreadable values
pnpm --filter @chimera-rx/api keys:rotate     # re-encrypt every protected value under a new key
```

Stop the API first so nothing writes during the run. Rotation:

1. makes the new key durable (the `file` provider appends it to `retired.keys`; the `env` provider needs `NEW_DATA_KEY` set);
2. re-encrypts every protected column of each store inside one transaction per database (all rows or none);
3. makes the new key current (`data.key` is replaced atomically, or you are told to move `NEW_DATA_KEY` into `DATA_KEY` and the old key into `DATA_KEY_PREVIOUS`);
4. writes a `keys.rotate` audit event with the old and new key ids.

A crash or error at any step leaves every row readable, because the ring holds both keys before any row uses the new one. The two stores are separate files, so rotation is atomic per store, not across both. Delete an old key from `retired.keys` only after `keys:status` shows no values under its id and no backup still needs it.

`keys:status` and `keys:rotate` print counts and key ids. They never print values or keys.

## API hardening

Implemented in `apps/api/src/security.ts` and wired in `app.ts`.

- **Headers** on every response: a Content-Security-Policy that fits the Vite build (own scripts and the OCR worker, inline styles, Google Fonts, no `unsafe-eval`, `frame-ancestors 'none'`, `object-src 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (camera allowed for self only; microphone, geolocation, payment, usb off), `X-Frame-Options: DENY`, COOP and CORP same-origin, `Cache-Control: no-store` on API responses, HSTS when `COOKIE_SECURE=1`.
- **Sign-in throttling**: an account locks for 15 minutes after 5 wrong passwords or codes. On top of that, failures are counted per IP (20 per 15 minutes) and per account name, **including names that do not exist** (10 per 15 minutes), and the answer is `429` with `Retry-After`. Counters are in memory and reset on restart.
- **Cookie**: `HttpOnly`, `SameSite=Lax`, `Secure` when `COOKIE_SECURE=1`. Set it whenever TLS terminates in front of the API.
- **Session idle timeout**: 30 minutes without a request (`SESSION_IDLE_MINUTES`, 0 turns it off), on top of the absolute 2 hour or 12 hour (trusted workstation) expiry.
- **CORS and CSRF**: only origins in `CORS_ORIGINS` (default: local dev) may call the API from a browser, and a state-changing request that names a foreign `Origin` gets `403`.
- **Validation**: every route that takes a body parses it with zod; routes that take no body refuse one.
- **Logging**: one JSON line per request with method, route pattern, status, timing, actor id, store id and IP. It never contains the URL, query string, body, names or phone numbers.
- **Errors**: responses are built from a fixed vocabulary. Validation errors name the field and the rule, never the value sent (zod's own enum message quotes the input, so it is replaced). Unknown errors become `{"error":"Something went wrong."}`.
- **Roles** are checked on the server in each route.
- **Audit log** (hash chained, `GET /api/audit/verify`) holds patient ids, Rx numbers and counts, never names, phones or dates of birth. It records profile views with the reason (`patient.view`), order views (`phi.view`), and key rotation (`keys.rotate`). The free-text reason is encrypted at rest.

## Read authorization matrix

One table decides who may call each route: `ACCESS` in `apps/api/src/access.ts` (key `METHOD /route/pattern`, value the allowed roles). A `preHandler` in `app.ts` applies it after the session check: no session is 401, a role that is not listed is 403, and a route with no row is 403 `route_unlisted` (default deny). A handler may be stricter than its row (a pharmacist-only action inside a route open to technicians), never looser. `apps/api/test/review-f03-f07.test.ts` walks the live route table for anonymous and all four roles, fails on any route without a row or any row without a route, and fails if a cashier or admin can read a patient id, allergy or date of birth outside the listed pickup and audit reads.

Reads, by who may call them:

| Who | Reads |
| --- | --- |
| Anyone signed in | `/api/me`, `/api/voice`, `/api/today` (counts and generic tasks; tasks that name a patient or an Rx Watcher flag go to pharmacist and technician only), `/api/search` (lots; fill-queue rows except for the admin), `/api/agents` (agent names and what the caller may run) |
| Pharmacist, technician, cashier | `/api/rx` and `/api/rx/:rx` (cashier: pickup columns, no allergies, DOB or email), `/api/lots`, `/api/deliveries`, `/api/demo/labels` |
| Pharmacist, cashier | `/api/register/*` |
| Pharmacist, technician | Agent run history `/api/agents/runs`, per-agent records `/api/agents/:id`, `/api/suggestions`, `/api/recalls`, `/api/recalls/:id`, `/results`, `/messages`, `/api/fax`, `/api/audio/:id`, `/api/outbox`, `/api/patients*`, `/api/refills*`, `/api/dscsa/*`, `/api/epcis/*`, `/api/stock-help`, `/api/rx/:rx/review`, `/api/prescriber-messages`, `/api/demo/scenarios` |
| Pharmacist only | Recall voicemail draft, call list, audit PDF and trace export; agent drafts; `/api/rx/:rx/change-draft`; `/api/stores` |
| Pharmacist, admin | `/api/audit`, `/api/audit/verify`, `/api/integrations` |
| Pharmacist, technician, admin | `/api/agents/provider` |
| Admin only | `/api/audit/export` |

A cashier or admin gets 403 on every clinical read. Where a role needs a number, the Today screen already carries counts without names. Partner surfaces (`/v1`, `/mcp`, `/fhir/r4`, `/oauth/token`, `/hooks/sink`) do not use sessions: they check an OAuth bearer and its scopes in `partner-api.ts`, and the test confirms a staff session alone does not open them. `/fax/:file` serves synthetic fax images and no patient data.

Not changed on purpose: `POST /api/calls/inbound` (the front desk takes a callback) and `POST /api/sms/inbound` (a simulated STOP reply) stay open to the roles listed in the table because the pickup desk and the sandbox use them; they return an id, a name and a recall id, not clinical history.

### Provider destination policy

The OpenAI-compatible provider calls a URL an operator typed. `apps/api/src/agents/destination.ts` refuses credentials in the URL, any scheme but http(s), link-local addresses (169.254.0.0/16 and fe80::/10) in every spelling the URL parser can produce (IPv4-mapped IPv6 in dotted and hex form, decimal, octal and hex IPv4, trailing dot, upper case, bracketed hosts, NAT64 and IPv4-compatible forms), and the metadata addresses and names (169.254.169.254, fd00:ec2::/32, `metadata.*`). It runs in the settings route and again before every request; for a host name it resolves with `dns.lookup` and refuses if any answer is blocked. Redirects are not followed (`redirect: "error"`). Localhost and 127.0.0.0/8 stay allowed for Ollama and LM Studio.

Residual risk: DNS rebinding. The name is resolved for the check and resolved again by `fetch`, so a hostile resolver could answer differently the second time. Pinning the checked address needs a custom HTTP dispatcher and is not done. A stored key is also not bound to an origin: an operator who changes the base URL sends the same key to the new host.

## What is NOT covered

- **No TLS in the app.** The API speaks HTTP. Put it behind a TLS-terminating proxy and set `COOKIE_SECURE=1` and `TRUST_PROXY=1`. Traffic between browser and API is unprotected without it.
- **No KMS or HSM.** The default key sits on the same host as the data. The KMS provider is a stub.
- **No encryption of everything.** Columns not in the table above (including message subjects, patient ids, lot and Rx numbers) are plaintext. SQLite page-level encryption (SQLCipher) is not used, so the file layout, table names and row counts are visible.
- **Memory and process.** Decrypted values exist in server memory and in browser memory while a screen is open. Swap files, core dumps and the sandbox outbox endpoint (`/api/outbox`) show plaintext to a signed-in user by design.
- **Backups and logs of other tools** (reverse proxy, container runtime) are outside the code.
- **Rate limits are per process.** Several API instances would each count separately.
- **No per-user field-level access control** beyond roles, no data retention or deletion workflow, no breach notification process, no independent security review or penetration test.
- **Staff passwords** use the existing salted hash; there is no password rotation policy.
- The sandbox SMS, email and voice providers never contact a real person.

Report a problem by opening an issue on the repository. Do not put real patient data anywhere in it.
