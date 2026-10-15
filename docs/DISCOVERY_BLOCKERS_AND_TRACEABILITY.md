# DISCOVERY BLOCKERS AND TRACEABILITY

> **Confirmed current 2026-10-15 (second pass):** every row below re-read
> against its canonical register; no status changed, no owner reply arrived,
> no new blockers found. B-D1…B-D13 stand as written. Full re-verification in
> `docs/PART1_OWNER_DECISION_PACKET.md` §§10–13.

## 1. Implementation blocker register

| ID | Blocker | Blocks | Owner decision | Unblocks when |
|---|---|---|---|---|
| B-D1 | Missing `.docx` canonical spec | Any claim of spec compliance | (docs) Supply file or confirm brief+repo canonical | File supplied or written confirmation |
| B-D2 | Direct-client scope unresolved | Pipeline schema, taxonomy, briefs, reports for direct clients | O1 | O1 decided (either direction) |
| B-D3 | Allocation + counting undefined | 50-target judging, tallies, UI | O2 + O3 | O2/O3 decided |
| B-D4 | Planner scope undefined | Coverage/stopping implementation | O4 | O4 decided (incl. deferral) |
| B-D5 | `source.enabled` unwired | Permission-off switch semantics | (technical) Wire flag or document code-registry as gate | **BUILT (Prompt 5)** — DB flag is the sole gate |
| B-D6 | Crashed runs stuck `running` | Accurate run history/counts | (technical) Reap/restart semantics | **BUILT (Prompt 5)** — operator-triggered reaper |
| B-D7 | Eligibility screen absent | Per-refresh eligibility at discovery | O10 | O10 decided, then built |
| B-D8 | Opportunity-key/relationship/repost model absent | Repost + collision handling | (technical per §4E) | **BUILT (Prompt 4)** — M2 + `keys.ts`/`opportunities.ts` |
| B-D9 | Policy-version snapshots absent | Brief reproducibility vs policy drift | (technical per §4D) | **BUILT (Prompt 4)** — M3/M4 + `eligibility.ts` |
| B-D10 | Formal pilot prerequisites open | Any sign-off validation | O11 (T-014 §12) | Five approvals recorded |
| B-D11 | Conflicted discoveries were dropped (no review artifact) | Provenance of refused records | (technical, fixed Prompt 5) | **BUILT** — M7 `identity_conflict` + run capture |
| B-D12 | Source records inherit the adapter's declared source key | Provenance accuracy across adapters | (technical, fixed Prompt 5) | **BUILT** — `manifest.sourceKey` used for records |
| B-D13 | Service-identity policy undefined for bearer credentials (raised by F9/F10, 2026-10-15) | Audit-grade attribution of machine callers; "who" stands behind a conflict captured through the service token | (owner policy) — deliberately NOT invented | Dated owner decision on the service-identity mapping |

> **Status note (2026-10-15 completion gate):** the matrix in §2 below is
> superseded by `docs/GRAYSCALES_DISCOVERY_TEST_TRACEABILITY.md`; the prioritized
> findings register is now `docs/GRAYSCALES_DISCOVERY_FINDINGS_REGISTER.md`;
> executed evidence is in `docs/GRAYSCALES_DISCOVERY_FINAL_VERIFICATION_REPORT.md`.
> Both original tables are preserved here as audit records.
>
> Technical blockers closed in that gate: planning atomicity (F5/F6),
> provenance fail-closed (F13), route security coverage (F14), identity-based
> schema verification including the Discovery structures (F11/F17), report
> freshness (F12). B-D13 was **opened**, not resolved.

> Status note (Prompt 5): B-D5/B-D6/B-D8/B-D9/B-D11/B-D12 code exists AND its
> database-backed tests have executed (Docker was brought back up mid-session).
> B-D1/B-D2/B-D3/B-D4/B-D7/B-D10 remain owner-blocked. See
> `docs/DISCOVERY_READINESS_REPORT_PROMPT5.md` §4 for per-item evidence and
> §7 for the defects that execution surfaced.
>
> B-D5 shape: `public.source.enabled` is the sole run gate (amendment §4F);
> adapters declare `manifest.sourceKey`; refusal happens before any write
> (409 `source_disabled` / 422 `unknown_source`), fail-closed on unknown keys.
> B-D6 shape: explicit operator action with an operator-stated threshold and
> dry-run (`POST /api/discovery/reap`); no scheduler, no resume, no deletion.

B-D5/B-D6/B-D8/B-D9 were buildable without owner words; B-D1/B-D2/
B-D3/B-D4/B-D7/B-D10 require owner words first. Nothing else is approved to build.

## 2. Requirement-to-test traceability matrix

Status key: TESTED (suite-green per last verified report — not re-run here),
PARTIAL (code exists, thin/absent tests), MISSING (no test), BLOCKED (needs owner).

| Requirement (amendment §) | Implementation | Test | Status |
|---|---|---|---|
| Run lifecycle + bounds (25×3, 120 s) | `lib/discovery/run.ts` | `tests/gleif.test.ts` (19, incl. live smoke) | TESTED (re-verified 2026-10-14) |
| Idempotent ingest + reruns | `run.ts` dedup + unique index | `tests/gleif.test.ts`, E14 | TESTED (re-verified) |
| Conflict handoff, no auto-merge | run→resolve handoff | `tests/resolve.test.ts` (30) | TESTED |
| Registry/contract/fixtures | `lib/discovery/*` | `tests/adapters.test.ts` (19) | TESTED |
| Permission manifests + SSRF guard | adapter manifests, `fetch-guard.ts` | contract tests | PARTIAL (DNS TOCTOU documented) |
| Run history/items APIs + UI | routes + `/discovery` | `tests/gleif.test.ts` (static contract) | PARTIAL |
| Manual refresh API + UI (§4C shape) | `lib/discovery/refresh.ts`, `POST /api/discovery/refreshes`, `components/refresh-plan-form.tsx` | `tests/discovery_e2e.test.ts` E1 + live HTTP refresh | TESTED |
| Counting measures §4A (structure) | `refreshSummary` six measures + live vs frozen split | E2/E3/E4/E5 + live idempotent re-run | TESTED (structure); **content** still blocked (B-D3/O3) |
| Pipeline tallies/allocation §4B | shortfall rows per pipeline, never transferred | E2 shortfall assertions | STRUCTURE ONLY (blocked B-D2/B-D3) |
| Planner/stopping rules §4C | `evaluateStops`, caller-stated thresholds, no defaults | `tests/discovery_coverage.test.ts` (8) | STRUCTURE ONLY (blocked B-D4) |
| Eligibility screen + explanations §4D | `lib/discovery/eligibility.ts` versioned decisions | `tests/discovery_eligibility.test.ts` (3) | STRUCTURE ONLY (blocked B-D7/O10) |
| Merge/relationship/keys/reposts §4E | `keys.ts` + `opportunity`/`business_relationship` (M2) | `tests/discovery_{keys,opportunities}.test.ts` (15) | TESTED |
| `source.enabled` wiring §4F | `lib/discovery/sources.ts`, gated in `run.ts`, `manifest.sourceKey` | `tests/discovery_sources.test.ts` (8) + E11 | TESTED |
| Crashed-run reaping | `lib/discovery/reap.ts`, `POST /api/discovery/reap`, UI card | reap policy tests + E-B-D6 (2) | TESTED |
| Identity conflicts never auto-merged | `lib/resolve/conflicts.ts` (M7), run capture | `tests/identity_conflict.test.ts` (3) + `tests/gleif.test.ts` conflict case | TESTED |
| Malformed path ids refused | uuid guards on both `[id]` routes | `tests/discovery_http_contract.test.ts` (2) + live 422 | TESTED |
| Retention classes §4G | `retention_class` stored, no jobs | policy tests | PARTIAL (windows open, D-008) |
| Pilot/thresholds §4H + R-05 | protocol + template docs | `tests/docs_consistency.test.ts` (NOT STARTED guard) | BLOCKED (B-D10) |
| No Reddit/YouTube | constraint + zero refs | category CHECK | TESTED |
| No EIP/VaultForge | absence | scope-cleanup audit | TESTED (absence verified) |
