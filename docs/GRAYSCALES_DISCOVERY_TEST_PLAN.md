# GRAYSCALES DISCOVERY TEST PLAN

> Design-only (Prompt 3). Conventions (verified): loopback-host guard +
> `new Pool({max: 3})`; fixture namespaces prefixed `ddisc-` (never colliding
> with t3/t10/rx-/m2*/HRB-/auth001); cleanup in `finally` + `beforeAll`;
> sequential files (`fileParallelism: false`); real PG + real container paths
> where honesty requires it, fixtures elsewhere. No validation thresholds
> invented — bounds below are existing engine values.

## A. Unit (pure, no DB)

- **T-DISC-U1 key canonicalization:** inputs (source, record, company variants
  incl. case/whitespace/unicode/punctuation) → stable `opp:<pipeline>:…` keys;
  reposts (identical content hash) → same key. Asserts: byte-identical keys,
  distinct keys across pipelines for same record.
- **T-DISC-U2 normalization guards:** shared-host domains, malformed
  identifiers, overlong fields rejected with codes (existing validators).
- **T-DISC-U3 counting taxonomy:** classifier maps item outcomes to the six
  §4A measures; fixtures assert each bucket exactly once. (Structure now;
  full wiring BLOCKED O3 for release.)

## B. Integration (real test DB)

- **T-DISC-I1 eligibility transitions:** fixture opportunity through
  observed→eligible→promoted + ineligible-with-gate-IDs + needs_info paths.
  Expects: version rows appended (never edited), audit rows per transition,
  gate reason IDs present. (Content BLOCKED O10; structure now.)
- **T-DISC-I2 freshness/provenance/contradictions:** expired basis → stale
  handling; contradicting observation → polarity link + surfaced; validation
  blocked while open. Expects: statuses, links, explanatory reasons.
- **T-DISC-I3 new-vs-promoted counting:** seed one known + one novel record;
  run refresh; expects `new_eligible=1`, `promoted` only after explicit
  promotion call, duplicates tallied not created. (Release BLOCKED O3.)
- **T-DISC-I4 pipeline targets:** per-pipeline tallies separate; shortfall
  rows explicit; transfer attempt rejected (no endpoint exists — assert 404).
  (Release BLOCKED O1/O2.)
- **T-DISC-I5 permissions/revocation:** disabled adapter (code-registry +
  `source.enabled` per B-D5 outcome) → run refused with code before any
  fetch; revoked mid-plan → `partial` with cause. (Wiring BLOCKED B-D5.)
- **T-DISC-I6 idempotency + concurrency:** same plan twice → second run zero
  new entities, history rows +2; 10 parallel identical ingests → one entity.
- **T-DISC-I7 rollback/partial:** poisoned batch → full rollback, zero rows;
  mid-run adapter failure → `partial`, completed items kept, error recorded.
- **T-DISC-I8 migration compatibility:** scratch-DB bootstrap → all
  migrations → seed ×2 → verify green (existing `seed.test.ts` pattern).
- **T-DISC-I9 preservation:** pre-existing companies/claims/briefs/audit
  byte-identical before/after refresh runs (count + hash spot-checks).
- **T-DISC-I10 <50 refresh:** fixture adapter yielding 3 eligible → run
  reports `new_eligible=3` + shortfall row (target 50, reason low_yield);
  asserts NO padding, NO transfer, NO invented records.
- **T-DISC-I11 ≥50 refresh:** fixture adapter yielding 60 eligible across
  pages → `new_eligible=60`, per-domain caps respected, all rows addressable
  via paginated collection reads. (Counting release BLOCKED O3.)
- **T-DISC-I12 reproducibility:** identical plan twice → identical counters +
  identical key sets (history row IDs excepted).

## C. Security

- **T-DISC-S1 auth:** anonymous refresh/run/collection calls → 401/307;
  bad bearer → 401; CSRF-less cookie POST → 403 (existing guard tests extend).
- **T-DISC-S2 SSRF/redirects:** adapter fetch to private-range URL refused by
  fetch-guard; redirect off-allowlist refused; both logged with cause, no
  exception text leaked (existing fetch-guard tests + new redirect cases).
- **T-DISC-S3 oversized/malformed:** over-limit payload → quarantine with
  cause + bounded excerpt stored, run continues; malformed record → `invalid`
  item, run completes.
- **T-DISC-S4 rate limits/timeouts:** 429 from source → backoff + `partial`
  with cause; run timeout → `time_stop`-class finalization, no hung rows
  (B-D6 reaping asserted separately).

## D. End-to-end + UI

- **T-DISC-E1 manual refresh flow:** plan → run → review queue shows
  candidates → human decision → collection reflects it; asserts each hop's
  DB state + audit actor.
- **T-DISC-E2 accumulated-records access:** 60 seeded opportunities across
  runs → paginated reads return all 60 with stable totals; no cap hides rows.
- **T-DISC-E3 failure/shortfall UI:** `partial` run + shortfall rows render
  with reasons; empty/error/loading states covered.

## E. Status ledger

BUILDABLE NOW: U1–U3(structure), I6–I9, I12, S1–S4, E1–E3(structure).
BLOCKED (O-tags, never silently skipped): I1-content(O10), I3-release(O3),
I4(O1/O2), I5-wiring(B-D5), I10/I11-release(O2/O3), planner-driven cases(O4).
