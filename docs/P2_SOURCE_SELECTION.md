# Phase 2 — Source Selection: one verified automated private-sector source

Status: **adapter implemented, tested, registered passively, NOT activated.**
Date of verification: 2026-10-16. Author: agent, pending owner review.

Scope of this phase: one complete, production-shaped source adapter with
correct provenance, guarded transport, repeat-run safety and meaningful tests.
This document is the justification record required before any activation.

---

## 1. Decision

**Selected: the Greenhouse Job Board API** (`boards-api.greenhouse.io`),
registered under the already-approved category **S-07 "Careers/hiring
platforms"** with the source key `greenhouse-job-board`, shipped **disabled**.

It was selected over alternatives because it is the only candidate examined
that satisfies all four hard requirements at once: keyless public access,
an *officially documented* machine-readable API, real dates on records, and
publisher-authored (not inferred) content. See §3 for the comparison and §5
for the one requirement it does **not** satisfy.

---

## 2. Official references

| Fact | Source |
|---|---|
| Endpoint shape, auth, query params, response fields | <https://developers.greenhouse.io/job-board.html> |
| `GET /v1/boards/{board_token}/jobs` | same, "List jobs" |
| "authentication is not required for any GET endpoints" | same, "Authentication" |
| Only the application POST needs Basic Auth | same |
| `?content=true` adds description/departments/offices | same |
| Published API change history | <https://developers.greenhouse.io/> (Harvest Change Log) |
| Legal document index (privacy, MSA, DPA, addenda) | <https://www.greenhouse.io/legal> |
| Privacy policy | <https://www.greenhouse.io/privacy-policy> |

No API-specific licence, terms-of-use page, or data-licence grant was found.
`https://developers.greenhouse.io/` returned no fetchable content in this
session; `https://www.greenhouse.io/terms-of-use` and
`https://www.greenhouse.io/privacy-shield-notice` both return HTTP 301/404.
**This absence is the blocker in §5 — it is not evidence of permission, and
not evidence of prohibition.**

### Live verification (read-only, two requests, no credentials, no DB writes)

| Request | Result |
|---|---|
| `GET /v1/boards/greenhouse/jobs` | 200, `content-type: application/json`, 10,697 bytes |
| `GET /v1/boards/zzz-definitely-not-a-real-board-xyz/jobs` | 404, **empty body** |
| `GET /v1/boards/greenhouse/jobs?content=true` | 200, 205,662 bytes |

Observed top-level keys: `jobs`, `meta{total}`. Observed job keys:
`absolute_url`, `application_deadline`, `company_name`, `data_compliance`,
`first_published`, `id`, `internal_job_id`, `language`, `location{name}`,
`metadata`, `requisition_id`, `title`, `updated_at`.

Two documentation discrepancies found and handled:

1. **The docs' abbreviated list example omits `first_published` and
   `company_name`, but the live list response includes both.** The adapter
   therefore treats `first_published` as optional: it is used when present and
   left NULL when absent. It is never defaulted.
2. **The docs' example `absolute_url` uses `boards.greenhouse.io`; the live
   response uses `job-boards.greenhouse.io`.** This URL is recorded as
   provenance and is **never fetched** by the adapter.

---

## 3. Candidates evaluated

### 3.1 Greenhouse Job Board API — SELECTED

| Requirement | Conclusion |
|---|---|
| Free / no payment / no mandatory credentials | **Yes.** Keyless, no registration, no paid tier required for GET. |
| Records and dates actually returned | Job postings with `id`, `title`, `location.name`, `requisition_id`, **`first_published`**, **`updated_at`**, `absolute_url`. Both dates are real and source-stated. |
| Authentication | None for GET. The adapter sends no headers and holds no secrets. |
| Rate limits | **None published** for the Job Board API (documented limits belong to Harvest, a different, authenticated API). Mitigated by bounded runs, local paging, and `Retry-After`-aware backoff. |
| Pagination / update semantics | The list endpoint has **no pagination parameter**; it returns the whole board. `updated_at` is the only change signal. The adapter pages locally over the single response. |
| Geographic coverage | Worldwide in principle — coverage depends on each employer choosing Greenhouse. Not verifiable from the API itself. |
| Identity mapping | **The API exposes no company domain, registry id, or country code.** `company_name` is a free-text label, not identity proof. Identity comes from an operator-declared board-token → company link. |
| Signal relevance | Yes: an open requisition is dated, first-party evidence of hiring, which S-07 explicitly targets ("growth, role mix, tech requirements (observed postings only — never infer internal pain as fact)"). |
| Attribution | Required in practice for display: the stored `absolute_url` points at the employer's own posting page. No separate licence attribution requirement was found. |

### 3.2 Ashby — REJECTED

- **No POST access.** Its API (`developers.ashbyhq.com`, `api.ashbyhq.com`) is
  authenticated: every documented endpoint carries `"security": [{"BasicAuth":
  []}]`. The public posting API documentation could not be retrieved —
  `developers.ashbyhq.com/posting-api`, `/docs/posting-api` and
  `docs.ashbyhq.com/posting-api` all returned 404.
- It fails the zero-credential requirement on the evidence available, and I
  will not assume a credential-free route exists. **Marked unresolved, not
  approved.**

### 3.3 Employer-hosted job feeds generally — REJECTED AS A CLASS

No single employer-hosted feed was pursued beyond Greenhouse. Reasons:
each employer is a separate integration with its own robots/terms posture;
coverage would be a hand-maintained allowlist rather than an API; and it
would amount to scraping directories, which this phase explicitly excludes.

---

## 4. What the adapter deliberately does NOT do

- Does **not** create or merge companies. A posting is not a company record.
- Does **not** fetch `absolute_url` (different host; provenance only).
- Does **not** request `content=true`: it inflates responses ~19× (10.7 KB →
  205.7 KB for 17 jobs) and adds untrusted employer-authored HTML this product
  must not store.
- Does **not** copy job `metadata` custom fields into evidence: they are
  untrusted and may contain personal data.
- Does **not** derive country from `office.location` strings.
- Does **not** record a posting's disappearance as a closure, withdrawal or
  negative signal. Absence of a posting is not evidence of anything.
- Does **not** treat hiring as proof of intent to subcontract. Every claim
  text states this explicitly.
- Does **not** run on a schedule, in the background, or unattended.

---

## 5. BLOCKER — commercial use, storage, and retention are NOT verified

**`greenhouse-job-board` must remain disabled until the owner records a
licensing decision.** This is not a formality; it is the reason the source
ships off.

What is verified: the API is public and keyless, and the documentation
explicitly invites building "careers pages with a unique look and feel" and
"department-level pages" — that is an **oriented grant for job display**.

What is **not** verified anywhere I could reach: any right to retain, store,
or use employer-published job data for **commercial business-intelligence
analysis** — inferring which agencies to approach about partnership. The
legal index at `greenhouse.io/legal` lists a privacy policy, an MSA, a DPA, a
SLA, a professional-services addendum, a **sourcing automation addendum**, and
an AI addendum. It does not publish a general data licence for API consumers.
The MSA and addenda bind Greenhouse *customers*, not third-party readers of
public job boards, so they do not grant us anything — and they equally do not
tell us what a third-party reader may do.

Two further cautions, recorded because they are evidence, not speculation:

- Greenhouse's own **MyGreenhouse User Agreement** prohibits "use of automated
  means, including spiders, robots, crawlers, or similar means or processes"
  against *that* service. It governs a different service and does not bind the
  Job Board API, but it shows the vendor's general posture toward automated
  collection and should inform the owner's risk view.
- A **"Sourcing automation addendum"** exists, implying automation of sourcing
  is a paid, contractually-governed capability in some form.

**Owner decision required (D-OPEN).** Options, none of which the agent may
choose:

- (a) Obtain written permission from Greenhouse for commercial BD use, then
  activate. Cost unknown; may violate the ₹0 constraint.
- (b) Seek counsel on whether reading an employer's own public postings for
  B2B analysis requires permission, then record the ruling.
- (c) Keep the adapter disabled permanently and use manual observation
  (Phase 1) instead, which needs no licence because the operator supplies and
  owns the extract.
- (d) Restrict use to a board whose employer has consented, evidenced in the
  ledger per company.

Until one of these is recorded and dated, the correct state of this system is
exactly what it is now: implemented, tested, registered, **disabled**.

---

## 6. Transport security — implementation and tests, not claims

Every gap below was found by inspecting `lib/discovery/http.ts`, fixed in
implementation, and covered by an executed test in
`tests/greenhouse_adapter.test.ts`.

| Control | Before | After | Test |
|---|---|---|---|
| Per-request timeout | none (only caller signal) | 15 s default, chained to caller signal | `enforces a per-request timeout and honours cancellation` |
| Response body cap | **none** — `res.json()` buffered unbounded | 2 MB default, enforced **per chunk while reading**, stream cancelled on breach, with a hard 1 KB floor | `refuses an oversized body…`, `keeps the body cap from being disabled by an absurd caller value` |
| Content-type validation | none | present-but-non-JSON refused before parsing | `refuses an oversized body and a non-JSON content-type…` |
| Retry-After | ignored | parsed (delta-seconds + HTTP-date, capped 300 s) and honoured | `honours Retry-After without leaking bodies`, `Retry-After parsing` |
| Retry bound / classification | fixed ladder | bounded; 429/5xx retry, 401/403/404 permanent | `maps a 404 board token…`, `maps 403…`, `recovers when a transient 5xx…` |
| SSRF / private destinations | hostname check once per hop | unchanged **plus** a fixed-host allowlist: the adapter can only ever construct `https://boards-api.greenhouse.io/...` | `never exposes arbitrary hosts: only the fixed API host is requested` |
| Redirects | manual, https + same host, max 2 | unchanged, tested for metadata + cross-host targets | `blocks cross-host and private redirects` |
| Run bounds | none | `limit` ≤ 100, `maxPages` ≤ 3, local paging, 120 s run timeout | `pages locally with an offset token…`, `respects the page limit…` |
| Diagnostics | no bodies | no bodies; asserted by test | `honours Retry-After without leaking bodies` |

### Known, unresolved limitations (stated, not hidden)

1. **DNS rebinding is not eliminated.** `validateFetchUrl` checks the hostname
   once per hop. A hostile DNS server could still answer with a private
   address. Mitigated-but-not-solved by the fixed-host allowlist: the adapter
   only ever requests one hardcoded hostname over HTTPS with TLS validation, so
   a rebind would have to compromise name resolution *and* present a valid
   certificate for `boards-api.greenhouse.io`. Closing this properly requires a
   pinned-IP or proxy transport, which is infrastructure this phase may not
   add. **Recorded as an accepted, visible limitation.**
2. **Local paging re-fetches.** Because the endpoint is unpaginated, page 2+
   repeats the same HTTP request and slices onward. One board run therefore
   costs up to `maxPages` requests. Documented in the adapter's `limitations`.
3. **Content-type is lenient when absent.** A response with no content-type
   header at all falls back to JSON parsing plus the adapter's own shape
   validation. Chosen so the existing GLEIF test doubles keep working.
4. **No company identity from the source.** Identity is operator-declared, so
   coverage depends entirely on linking boards to known companies.

---

## 7. Verification performed

Commands and results are recorded in the Phase 2 final report. Summary:
`npx tsc --noEmit` clean; 34 new tests passing across two new files; the full
suite re-run to confirm no regression from the `http.ts` hardening; production
build compiled. The opt-in live smoke test
(`GREENHOUSE_LIVE_SMOKE=1`) is excluded from the default run and issues exactly
one read-only request.

**This source is not production-ready.** It is correct, bounded, tested
against recorded and live-verified response shapes — and it is switched off.