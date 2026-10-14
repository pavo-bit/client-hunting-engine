# SOURCE_INTEGRATION_PLAN — 12 Adapters

> LOCKED: 12 categories below; Reddit + YouTube excluded. No API existence claimed without verification — each source lists what to **investigate**. Priority PROPOSAL in §5 (D-003); worldwide agency scope per [DECISIONS_AND_OPEN_QUESTIONS.md](DECISIONS_AND_OPEN_QUESTIONS.md) D-001/D-002.

## 0. Worldwide design rules (LOCKED)

- Adapters accept `country`/`region` parameters and must not hardcode a single jurisdiction, language, or registry. Unicode company names and international domains supported.
- No single-country prerequisite for MVP. Jurisdiction variance is handled per adapter (config + manual fallback), never by narrowing global scope.
- Incremental evaluation: prioritize adapters by permitted access, data quality, cost, and qualified-opportunity yield — worldwide scope does not require building all 12 at once.

## 1. Shared adapter interface {#adapter-interface}

Documented shape (unchanged): `key()`, `category()`, `isEnabled(ctx)`, `discover(query, ctx) → Candidate[]`, `normalize(raw) → CompanyFields`, `provenance(raw) → {source, version, url, fetchedAt, hash}`. Registry: enable/disable per adapter + per-segment allowlist. Contract tests use recorded fixtures; live calls never in CI. Failures return typed errors (`rate_limited | auth | terms_block | parse | network | injection_suspect`).

IMPLEMENTED T-005 (`lib/discovery/`, contract version 1, D-013): typed
`SourceAdapter` (manifest with stable id/version/category/capabilities/
limitations/access requirements, `validateConfig`, `discover` with
AbortSignal, pure `normalize`/`provenance`, non-invasive `health`),
deterministic `AdapterRegistry` (register/get/list, duplicate + manifest
validation, config + capability gating, clamped limits, timeout wrapper;
registration and listing never execute or fetch), versioned
`NormalizedDiscovery` (modelVersion 1, explicit missingFields/warnings),
extended failure causes (`cancelled`, `timeout`, `misconfigured`) with
retryable flags, and a fetch-URL guard (SSRF denylist) that future live
adapters must apply before any outbound request. Supported capabilities:
`discover`, `lookup` (declared; no implementation yet), `health`.
Fixture: `agency-directory-fixture` (S-05) — synthetic labeled records,
ok/empty/partial/malformed/error scenarios, no network, never registered in
production. Deferred: live connectors (T-006+, individually evaluated),
`lookup` implementations, DNS-resolve-and-revalidate at connect time
(documented TOCTOU limitation), multi-tenant or remote plugin loading
(forbidden).

## 2. Fetching policy {#fetching-policy}

Controlled public-page fetching only when justified: respect robots/terms, identify with contact UA (TBD), rate-limit per host (PROPOSAL defaults in config), store hashed immutable snapshots, minimize PII. Authenticated/paid access only with recorded decision + human credentials.

## 3. Source categories

### S-01 Search engines — PROPOSAL first-wave candidate

- Purpose/signals: broad discovery; site footprint, tech mentions, news.
- Access to investigate: search provider TOS + official APIs (existence/cost TBD); no scraping against terms.
- Limits/cost/fallback: quotas TBD; fallback = manual query log + manual entry.
- Normalize/provenance/failure: domain-normalized candidates; query + timestamp + snapshot; quota errors → backoff + queue.

### S-02 Official company registries

- Purpose/signals: corroborating identity (legal name, ID, status, officers where public) **per jurisdiction**. Under worldwide scope, no single registry is a universal gate.
- Access: jurisdiction registry portals/APIs configured per country (availability/cost TBD each); high reliability prior (A) where applicable.
- Limits/fallback: per-registry throttles/fees TBD; fallback = manual lookup log.
- Priority: PROPOSAL corroboration role (not MVP-first) given worldwide variance.
- LIVE CONNECTOR (T-006, D-014): `gleif-api` — GLEIF LEI Index over the T-005 contract. Keyless public open-data API (verified 2026-10-13); bounded runs; records map LEI→registry (`lei` type), legal name, jurisdiction/country. Agency yield expected low (LEI skew); additional registries need individual evaluation.

### S-03 Startup/business directories

- Purpose/signals: vertical, stage, funding mentions, tech stack tags.
- Access: directory APIs/exports vs. terms-limited pages (verify per directory).
- Fallback: manual entry from observed listing (quote + snapshot).

### S-04 Product-launch platforms

- Purpose/signals: launch recency, traction hints, maker links.
- Access: official API where offered (verify); else manual curation.
- Fallback: manual launch log.

### S-05 Agency/service-provider directories

- Purpose/signals: **primary listing of the target segment** — agency type, service lines (as stated), size bands, client lists (as stated), geographies served.
- Access: verify export/API vs. page terms.
- Fallback: manual entry.
- Priority: PROPOSAL first wave (with S-01/S-08) for worldwide agency discovery.

### S-06 Developer/open-source ecosystems

- Purpose/signals: public repos, hiring of engineers, stack signals, contribution recency.
- Access: official APIs (rate limits TBD — do not invent numbers); public-event data only.
- Fallback: manual repo/profile notes with links.

### S-07 Careers/hiring platforms

- Purpose/signals: growth, role mix, tech requirements (observed postings only — never infer internal pain as fact).
- Access: official APIs/job feeds vs. terms-limited pages (verify per platform).
- Fallback: manual posting log + snapshot.

### S-08 Company-owned sites/announcements

- Purpose/signals: offerings, changelog, pricing pages, public roadmaps.
- Access: fetching policy §2; never treat absent feature as proven internal problem.
- Fallback: manual page notes.

### S-09 LinkedIn

- Purpose/signals: company size band (as stated), hiring signals, posts (as published).
- Access: **official/permitted means only; no scraping in violation of rules.** Capability TBD — do not assume API coverage. High restriction; expect manual-note fallback as primary in MVP.
- Fallback: manual notes of publicly visible page facts with URL + date.

### S-10 X

- Purpose/signals: announcements, customer complaints/praise (as posted), recency.
- Access: official API tiers (cost/rate TBD — verify); respect rules.
- Fallback: manual post log.

### S-11 Instagram

- Purpose/signals: brand activity, offering showcases, recency.
- Access: official APIs with auth scope (verify); no scraping against terms.
- Fallback: manual notes.

### S-12 Facebook

- Purpose/signals: business page info, reviews (as posted), activity.
- Access: official APIs with page/data permissions (verify); respect platform policy.
- Fallback: manual notes.

## 4. Explicitly excluded

Reddit and YouTube: no adapters, no backlog rows, no "future phase" hooks in MVP. Reintroduction requires explicit project decision.

## 5. Enablement priority (PROPOSAL, D-003)

Revised investigation order for worldwide agencies: S-05 (agency directories) + S-01 (breadth) + S-08 (owned sites) → S-07/S-06 (hiring/tech) → S-03/S-04 (directories/launches) → S-02 per-jurisdiction corroboration → S-10/S-11/S-12/S-09 (social, most restricted). MVP ships a small number only, evaluated incrementally by permitted access, data quality, cost, and qualified-opportunity yield; rest remain disabled with manual fallback.
