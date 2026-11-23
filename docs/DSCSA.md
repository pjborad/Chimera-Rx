# DSCSA traceability with GS1 EPCIS

**Sandbox, not a filing.** Chimera Rx does not file, send or submit anything to a regulator, manufacturer or trading partner. It makes no compliance claim. All data is synthetic.

## The gap

Pharmacies must keep product tracing data (lot, serial, expiry, who handled it and when), exchange it with trading partners and answer verification requests. Small pharmacies rarely have a tool that ties package-level lot and serial events to the patients who received them. Chimera Rx already records every lot movement in its ledger (`lot_events`). This feature makes that ledger speak GS1 EPCIS 2.0.

## What is implemented

| Piece | Where |
| --- | --- |
| EPCIS 2.0 JSON-LD ObjectEvents, SGTIN/LGTIN URNs, GS1 Digital Link, CBV mapping, zod validator, parser | `packages/epcis` |
| `GET /api/epcis/export?from&to&lot&gtin` (technician, pharmacist; audited; JSON download) | `apps/api/src/epcis.ts` |
| `POST /api/epcis/import` dry run first, pharmacist confirms; events are advisory and never move stock | same |
| `POST /api/dscsa/verify` synthetic verifier, logged to `verification_requests`, audited | same |
| Suspect product cases with evidence and a plain-text draft | `/api/dscsa/cases` |
| Recall trace: `GET /api/recalls/:id/trace-export` (pharmacist), patient ids only, never names | same |
| MCP tool `lot_trace` (read-only, scope `inventory.read`, no patient ids) | `partner-api.ts` |
| Web: **DSCSA & trace** screen, "Verify with manufacturer (sandbox)" at Receiving, "Export trace (EPCIS)" on the recall review | `apps/web` |

### CBV mapping (sandbox choice, check against the current GS1 CBV before real exchange)

| Ledger event | bizStep | disposition |
| --- | --- | --- |
| Received, Transfer in | receiving | in_progress |
| Shelved, Moved | storing | sellable_accessible |
| Filled | picking | in_progress |
| Sold | dispensing | dispensed |
| Returned | returning | returned |
| Destroyed | destroying | destroyed |
| Quarantined | holding | non_conformant, or recalled for a recall hold |
| Released | inspecting | conformant |
| Transfer out | shipping | in_transit |
| Adjusted | cycle_counting | active |

### Rules the code enforces

- An event is never written without a lot or a real serial, unless it is marked `chimera:inferred` (pharmacy-safety rule 7).
- An inferred serial (an internal `NOSN-` id) is carried only in the extension field `chimera:inferredSerial`. It is never put in `epcList`.
- Exports carry no staff names and no notes. Patient ids appear only when a pharmacist asks (`patients=1`) and in the recall trace, as ids such as `S-0417`, never names.
- Imported events are stored in `trace_imports` as advisory data. Patient ids in an import are dropped. Import never touches `lots`, `packages` or `lot_events`.
- A recalled lot stays blocked (rule 8): its suspect case cannot be closed as cleared, and receiving still refuses it after the case closes.
- A failed verification changes nothing by itself. At Receiving the existing flow (report a problem, quarantine) is unchanged.

## What is a sandbox stand-in

- **The verifier.** It answers from `apps/api/fixtures/dscsa-verifier.json` plus this store's supplier transaction records (`ti_records`). It is not a manufacturer, wholesaler or Verification Router Service response. Answers: `verified`, `not_verified` (serial not commissioned, lot mismatch, expiry mismatch) and `lot_recalled`.
- **Company prefix.** A GTIN-14 does not say where the GS1 company prefix ends. The URN conversion assumes 7 digits (`DEFAULT_COMPANY_PREFIX_LENGTH`).
- **Locations** are synthetic URIs under `chimera-rx.example`, not GLNs.
- **The case draft** is text on a screen. Nothing is sent.

## Sample document (shortened)

```json
{
  "@context": ["https://ref.gs1.org/standards/epcis/2.0.0/epcis-context.jsonld", { "chimera": "https://chimera-rx.example/ns/epcis#", "cbvmda": "urn:epcglobal:cbv:mda:" }],
  "type": "EPCISDocument",
  "schemaVersion": "2.0",
  "creationDate": "2026-11-19T20:18:43.162Z",
  "chimera:notice": "Sandbox, not a filing. Synthetic data. Produced by Chimera Rx for a pilot demo; no compliance is claimed.",
  "epcisBody": {
    "eventList": [
      {
        "type": "ObjectEvent",
        "eventTime": "2026-11-05T14:00:00.000Z",
        "eventTimeZoneOffset": "+00:00",
        "eventID": "urn:chimera-rx:lot-event:store-7:41",
        "action": "OBSERVE",
        "bizStep": "https://ref.gs1.org/cbv/BizStep-receiving",
        "disposition": "https://ref.gs1.org/cbv/Disp-in_progress",
        "epcList": ["urn:epc:id:sgtin:0370004.041705.0000907"],
        "chimera:digitalLink": "https://id.gs1.org/01/00370004417051/21/0000907",
        "cbvmda:lotNumber": "PRORX050925-1",
        "cbvmda:itemExpirationDate": "2027-09-30",
        "readPoint": { "id": "https://chimera-rx.example/sandbox/location/store-7" }
      }
    ]
  }
}
```

## Try it in 60 seconds

1. `pnpm dev`, sign in as the pharmacist (type the email and shared synthetic password from `README.md`; the form is not pre-filled).
2. Open **DSCSA & trace**. Press **Preview**, then **Download .jsonld**.
3. Drop that file back into the import box. The dry run shows events as duplicates or new, and "Stock unchanged".
4. In **Verification requests**, press **Ask the sandbox verifier** with the prefilled `DEMO-OK-01` (verified). Change the serial to `SPOOF-001` (not verified).
5. At **Receiving**, scan a package whose serial is not in the supplier record. Press **Verify with manufacturer (sandbox)**, then **Open a suspect product case**.
6. Back in **DSCSA & trace**, open the case, read the draft ("DRAFT, not a filing, nothing is sent") and quarantine the package.
7. Recalls: confirm a lot, then **Export trace (EPCIS)** on the review step.

Run the tests: `pnpm test` (package property tests in `packages/epcis/test`, API tests in `apps/api/test/dscsa.test.ts`).
