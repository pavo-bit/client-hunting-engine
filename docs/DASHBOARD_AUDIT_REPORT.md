# DASHBOARD_AUDIT_REPORT — Independent Release Audit

> Date: 2026-10-13. Auditor role: release engineer (same session as implementer — independence is procedural: every claim below cites captured evidence, and failures found mid-audit are recorded, not hidden). Target: local build only; no remote, no deploy.

## Executive summary

A coherent, fully navigable dashboard now covers the intended workflow with real local data where a backend exists and explicit unavailable/planned states elsewhere. T-002/T-003 regressions pass (60/60), typecheck and production build are clean, and all 23 routes return the expected statuses over HTTP with DOM-level spot checks and a clean browser console. **One real defect was found by the audit itself** (`/pipeline` 500 from a raw pg DATE child) and fixed with a regression test. No security boundaries were weakened. The app remains local-only (no operator auth) and is **not production-ready**.

**Verdict: PARTIAL** — dashboard acceptance criteria are met (navigation, real-data pages, honest states, regression safety), but the underlying product backend is still at T-003: discovery adapters, resolution ops, research automation, hypothesis engine, and task tracking do not exist, so their pages are truthful status pages rather than functionality.

## Route inventory

| Route | Purpose | Status | Backend dependency |
|---|---|---|---|
| `/` | Redirect to `/agencies` | live | none |
| `/overview` | Live counts + breakdowns | live | `getOverview` (8 real queries) |
| `/activity` | Failures + 20 latest audit events | live | `failure_log`, `audit_log` |
| `/agencies` (+`?q=`) | Directory, TanStack sort/filter | live | `company` |
| `/agencies/new` | Manual entry (RHF+Zod, server authoritative) | live | `POST /api/companies` (T-003) |
| `/discovery` | Intake records + adapter gap note | partial | `discovery_record` (+ T-005 missing) |
| `/resolve` | Status groups + alias list + T-004 note | partial | `company`, `company_alias` (+ T-004 missing) |
| `/research` | Runs + immutable snapshots | partial | `research_run`, `snapshot` (no auto-fetch) |
| `/evidence` (+`?status=`) | Claims + provenance + staleness | live | `claim`→`snapshot`→`source` chain |
| `/hypotheses` | Hypotheses + evidence ± counts | live | `hypothesis`, `hypothesis_evidence` |
| `/projects` | Options, ranges, assumptions, questions | live | `project_option`, capabilities |
| `/scores` | Deterministic ranking + gates | live | `score_run` (weights provisional) |
| `/review` (+`?status=`) | Human review queue | live | `brief` |
| `/commercial` | Cost/effort ranges + limits | partial | `project_option` ranges (D-005 open) |
| `/briefs` | All briefs index | live | `brief` |
| `/briefs/[ref]` | Brief package + drafts + outcomes | live | `brief` + joins; 404 on bad/missing ref |
| `/outreach` | Drafts, human-send-only, copy only | live | `outreach_draft`; NO send path by schema+test |
| `/pipeline` | Outcome groups + manual log | live | `outcome_log` (fixed 500, see below) |
| `/tasks` | Planned status page | planned | none (no schema) |
| `/import` | CSV workspace + batch history | live | T-003 APIs + `import_batch` (unchanged) |
| `/sources` | 12-category registry + policy notes | live | `source` (adapters not built) |
| `/audit` | Full trail + cause breakdown + limits | live | `audit_log`, `failure_log` |
| `/settings` | Read-only disclosures, no editable controls | partial | decisions only |
| `/api/*` (4 routes) | T-003 contracts | live, unchanged | T-003 lib |

## Component and design audit

- Shell: dark navy sidebar (`bg-slate-900`), 6 labeled groups, live/partial/planned badges, mobile menu, header agency search (`?q=`), skip link, local-only banner, footer. Landmark fix applied (`aside`→`nav`).
- Primitives: button/input/label/card/badge/table/alert/skeleton/dialog — consistent variants, visible `:focus-visible`, `prefers-reduced-motion` guard.
- Tables: TanStack v8 (directory, preview) with sort/filter; bounded plain tables elsewhere with counts; empty/filter-empty states everywhere data can be absent.
- Confirm dialog (Radix) gates import commits; no dead buttons found (all controls wired; settings intentionally display-only with no fake controls).
- Synthetic labeling: `.example` domains badged in directory; seed rows labeled synthetic in shell footer and audit notes; no fabricated stats — overview states unavailable analytics explicitly.

## Feature verification matrix

| Feature | Result | Evidence |
|---|---|---|
| Manual creation | PASS | T-003 suite + HTTP 201 smoke (earlier phase) |
| Directory + search | PASS | HTTP 200, 3 seed rows, `?q=` filters server-side |
| CSV preview/confirm/partial success | PASS | 18 integration tests incl. 5000/5001, race, idempotency |
| Duplicate/conflict handling | PASS | 409 + preview flags + commit recheck (tested live) |
| Staging/idempotent retry | PASS | Double-confirm + concurrent-confirm tests |
| Audit/RLS behavior | PASS | T-002 suite 6/6 + anon/auth 42501 + REST read/write denial |
| No-send boundary | PASS | Schema has no delivery columns; static scan of app+lib+components passes |
| Score transparency | PASS | Version, components, gates shown; weights labeled provisional |
| 404/empty/error states | PASS | `/nope`→404, bad brief ref→404, `error.tsx`, empty states |
| Import confirm dialog | PASS | Rendered in DOM build; commit path unchanged (regression suite) |
| Discovery adapters | BLOCKED | Page states T-005 gap (no backend phase started for show) |
| Merge/split ops | BLOCKED | T-004; constraints only |
| Task tracking | PLANNED | Status page, no schema |
| Charts | OMITTED | No genuine series; documented, not a gap |

## Test evidence

- `npx vitest run`: **5 files, 60/60 pass** (35 unit + 18 T-003 integration + 7 dashboard: read contracts, nav↔route inventory both directions, DATE regression).
- `npx tsc --noEmit`: clean. `npm run build`: clean (22 pages + 4 APIs).
- `supabase db reset` (target local, never linked): 7/7 migrations + seed; T-002 suite 6/6 re-passed.
- HTTP smoke (production build): 23/23 expected statuses (22×200 + API 200 + 2×404); full manual→preview→confirm→cleanup round-trip verified earlier; DOM checks (h1, landmarks, skip link, table rows, badges, file input) + clean browser console. Screenshots unavailable (headless, no visible window) — no visual claim made.
- **Audit-found defect:** `/pipeline` 500 — raw pg DATE object rendered as React child. Fixed by formatting at render; regression test pins driver behavior. Rebuilt, re-smoked 200.
- **Audit-found nit:** sidebar used `<aside>` for primary nav → `<nav>`; rebuilt.
- Transient infra notes (not defects): one `db reset` storage-container health-check flake (DB work completed; clean on retry); one `db reset` container-exit flake during parallel npm install (clean on retry).

## Security review

- No operator auth: bannered in-app, disclosed in settings + footer; local-only verdict stands.
- RLS: enabled, zero policies, explicit revokes (T-002 evidence re-confirmed); service key server-side only; no `.env` committed; new read paths are server components (no secret reaches the browser).
- No-send: re-verified after UI work (static scan incl. `components/`; schema unchanged).
- Untrusted content: snapshots render excerpts as quoted text; React escapes all output; formula cells flagged, never evaluated.
- No new source access, scraping, scanning, or remote linking. No secrets generated.

## Known gaps

Backend (out of scope by design): T-004+ adapters, merge tooling, research automation, hypothesis engine, task schema. UI: no pagination past 500-row bounds, no agency detail/edit view, no dark mode, no ESLint config, no automated a11y scan (landmarks/labels/focus implemented manually). Decisions still open: D-004/005/006/008, operator auth, remote setup. `zod@4.6.7` installed (major bump incidental via `zod@latest`-style spec) — schemas use basic API, verified by suite; Next kept at patched 15.5.27.

## Acceptance verdict

**PARTIAL** — the dashboard is coherent, fully navigable, regression-safe, and honest about every gap; full PASS is blocked only by future backend phases (T-004+), which this task correctly did not fabricate.
