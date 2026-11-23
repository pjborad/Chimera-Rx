# Project-Level Rules

> Project-specific specialisation and corrections. Loaded after `org.md` and
> `team.md` as strict-additive guidance.
> Populated by practices-discovery and the self-learning loop.
>
> Use sparingly: most teams don't need a project layer. Reach for it
> only when this specific project needs stable, durable guidance beyond the
> team practice (for example, package-specific release checks or an additional
> regression suite for a legacy component).

## Way of Working

<!-- Project-specific specialisation. Example: -->
<!-- This monorepo requires package-scoped branch names and a package owner -->
<!-- review in addition to the team's normal merge policy. -->
<!-- A project that merges into another branch than team.md names says so on its own line, read before team.md's: -->
<!-- - **Integration branch**: develop -->

## Walking Skeleton

<!-- Project-specific specialisation. Example: -->
<!-- The walking skeleton must exercise the legacy service adapter as well -->
<!-- as the new service boundary. -->

## Testing Posture

<!-- Project-specific specialisation. -->

## Guard Policy

<!-- Project-specific. Mode: strict, relaxed, or off. Strict here holds for every intent, whatever one person asks in chat; relaxed or off here applies to every intent whose policy came from its scope, unless the person sets another; changing this line changes it. A section under the retired Change Control heading, written by an earlier release, is still read. -->

## Deployment

<!-- Project-specific specialisation. -->

## Code Style

<!-- Project-specific specialisation. -->

## Tech Stack

<!-- Technology choices locked for this project. -->

## Decided

<!-- Decisions made in earlier stages that should not be re-asked. -->
<!-- Format: DECIDED: [decision] (Stage [slug], [date]) -->

## Scope Overrides

<!-- Custom scope rules for this project. -->

## Forbidden

<!-- Populated by practices-discovery affirmation gate. -->
<!-- Format: - NEVER [behavior] (affirmed [date]) -->
<!-- Example: - NEVER throw exceptions across service layer boundaries (affirmed 2026-05-17) -->

- NEVER git push to any remote; commit everything locally only (learned 2026-11-16) <!-- cid:261116-judge-ready-pilot:intent-capture:dbc5b94ff44ab44f27667492f59427bf72b7d10bebd4021c8b6a5d91bb93ab19 -->

- NEVER write any company or employer name anywhere in the project (learned 2026-11-16) <!-- cid:261116-judge-ready-pilot:intent-capture:0aaa5451408c7820c4d2b56be3db8682d43391c6de133cf7e477564f7330ca0e -->

- NEVER git push to any remote; commit everything locally only (project.md, learned 2026-11-16). (affirmed 2026-11-18)

- NEVER push, open a pull request, or send anything to GitHub until the person does it together with the agent (interview Q1 and Q8). (affirmed 2026-11-18)

- NEVER write any company name anywhere in the project (project.md, learned 2026-11-16). (affirmed 2026-11-18)

- NEVER add real patient data, a real messaging or telephony provider, or real pharmacy, wholesaler, payer or Surescripts connections (pharmacy-safety.md rules 1 and 2, product.md non-goals). (affirmed 2026-11-18)

- NEVER claim clinical validity, regulatory compliance, HIPAA compliance or certification (pharmacy-safety.md rule 11). (affirmed 2026-11-18)

- NEVER show an inferred serial as scanned, and NEVER auto-confirm a lot under 0.95 confidence or with no expiry (pharmacy-safety.md rules 5 and 7). (affirmed 2026-11-18)

- NEVER let a recalled lot pass receiving or fill, even after the recall closes (pharmacy-safety.md rule 8). (affirmed 2026-11-18)

- NEVER let `packages/gs1`, `packages/summoner` or `packages/coroner` import from `apps/*` (tech.md). (affirmed 2026-11-18)

## Mandated

<!-- Populated by practices-discovery affirmation gate. -->
<!-- Format: - ALWAYS [behavior] (affirmed [date]) -->
<!-- Example: - ALWAYS use Result<T,E> for fallible operations in service layer (affirmed 2026-05-17) -->

- ALWAYS start every commit message with a type prefix (feat, fix, chore, docs or test), plus the requirement ID when there is one, for example COR-3: ... (interview Q7). (affirmed 2026-11-18)

- ALWAYS use synthetic data only: patient IDs like `S-0417`, phones `(555) 010-01xx`, emails at `example.com` (pharmacy-safety.md rule 1). (affirmed 2026-11-18)

- ALWAYS route SMS and email to the sandbox outbox only, with the pharmacist's attestation and a consent check at send time (pharmacy-safety.md rule 2). (affirmed 2026-11-18)

- ALWAYS let a pharmacist decide recall lot confirmation, fill verification, flagged-prescription approval and patient messages (pharmacy-safety.md rule 3). (affirmed 2026-11-18)

- ALWAYS emit only lots found verbatim in the source text; drop an LLM answer that fails the check (pharmacy-safety.md rule 4, COR-3). (affirmed 2026-11-18)

- ALWAYS show the persistent demo notice on every staff page (pharmacy-safety.md rule 10). (affirmed 2026-11-18)

- ALWAYS record every person-made state change through `audit()` and every lot movement through `lotEvent()` (tech.md). (affirmed 2026-11-18)

- ALWAYS enforce role checks on the server (tech.md). (affirmed 2026-11-18)

- ALWAYS pin exact dependency versions (tech.md). (affirmed 2026-11-18)

## Corrections

<!-- Project-specific corrections from human feedback. -->
<!-- Format: NEVER/ALWAYS [behavior] (learned [date]) -->
