# PROJECT_SPECIFICATION — Canonical Source of Truth

> Status: LOCKED vision + boundaries; PROPOSAL details marked as such; unverified facts marked TBD. Spec wins over role files on conflict.
> Related: `PROJECT_IMPLEMENTATION.md`, `DATA_MODEL_AND_EVIDENCE.md`, `SOURCE_INTEGRATION_PLAN.md`, `SCORING_AND_OPPORTUNITY_MODEL.md`, `DECISIONS_AND_OPEN_QUESTIONS.md`.

## 1. Purpose and scope

### 1.1 Vision (LOCKED)

Grayscales Business Opportunity Intelligence is an **internal** BD intelligence system for Grayscales | Digital Solutions. It discovers businesses via permitted public sources, builds evidenced business profiles, generates validated software-project hypotheses, and produces reviewable briefs + outreach drafts. The human operator decides and contacts prospects manually.

Differentiator: conversion of **traceable public evidence → specific, feasible, commercially justified software project**. Not a lead list, website auditor, CRM, or message generator alone.

### 1.2 Goals (LOCKED)

- G-001: Canonical company records with duplicate resolution.
- G-002: Full provenance (source → snapshot → claim → hypothesis → brief).
- G-003: Evidence ledger with supporting + contradictory evidence.
- G-004: Deterministic, explainable qualification and ranking.
- G-005: Capability-mapped, feasible project proposals with stated assumptions.
- G-006: Human review queue + briefs + drafts; manual outcome tracking; learning loop.

### 1.3 Non-goals (LOCKED)

- NG-001: No public SaaS in initial release.
- NG-002: No automated outreach or client contact of any kind.
- NG-003: No unauthorized access (scanning, probing, login testing, private-system inspection).
- NG-004: No ML-based lead scoring in MVP.
- NG-005: No microservices/Kafka/Redis without demonstrated requirement.
- NG-006: No Reddit/YouTube discovery integrations; no source/segment expansion without explicit decision.

## 2. Users and segments

- U-001 Operator (primary): runs discovery, reviews briefs, edits/sends outreach manually, records outcomes.
- U-002 Reviewer/admin (may coincide with operator in MVP): manages segment config, capability catalog, scoring thresholds, user access.
- Target segment (DECIDED, D-001): **software and digital agencies worldwide** — including web development agencies, custom software firms, mobile application agencies, ecommerce agencies, automation consultancies, and related digital service providers. Do not expand to every business category without an explicit `D-*` decision.
- Geographic scope (DECIDED, D-002): **worldwide**. The architecture must not be restricted to one country (no single-country prerequisite for MVP, no hardcoded jurisdiction, locale, or registry assumptions).
- Opportunity domain (LOCKED): problems addressable through software, integrations, automation, digital workflows, portals, dashboards, testing systems, reporting, or other appropriate digital solutions.
- Problem confirmation (LOCKED): public research yields signals and hypotheses only. It cannot establish most internal operational problems as facts. Actual requirements must be validated with the agency after a human-led conversation. FR-011 and the scoring confidence limits enforce this.
- Agency classification fields (PROPOSAL, exact schema TBD): `agency_type` (web-dev | custom-software | mobile | ecommerce | automation-consultancy | other-digital — controlled vocabulary), `country` + `region` (free text + ISO code PROPOSAL), `size_band`, `service_lines` (as stated), `tech_signals` (observed only). Opportunity categories (PROPOSAL, TBD): integrations, automation/workflows, portals/dashboards, testing/QA systems, reporting/analytics, ecommerce tooling, mobile delivery support, other-digital-solution.

## 3. Lifecycle (LOCKED)

`Discover → Resolve → Qualify → Research → Record Evidence → Understand → Generate Hypotheses → Validate → Design Project → Evaluate → Review → Prepare Outreach → Human Executes → Record Outcomes → Improve Rules.`

State machine detail: `PROJECT_IMPLEMENTATION.md#state-transitions`.

## 4. Functional requirements

### 4.1 Company intake and resolution

- FR-001 Manual company entry: operator creates a company with name + at least one identifier (domain, registry ID, or social URL). Validation errors enumerated. Acceptance: invalid entries rejected with field-level messages; valid entries get canonical ID + provenance `manual`.
- FR-002 CSV import: upload ≤ TBD rows (D-007), per-row validation report, atomic-per-row import (one bad row doesn't abort batch), duplicate preview before commit.
- FR-003 Canonical resolution: deterministic match keys (normalized domain, registry ID, exact social handle) + fuzzy candidates (name similarity + location) queued for human merge/split. Acceptance: no two canonical records share the same verified domain/registry ID; merges preserve full audit history.
- FR-004 Agency-segment focus: one active agency-segment configuration at a time (agency-type/country filters are views on the worldwide agency segment, not separate segments). Qualification and queue ordering filter on it. Expansion to non-agency business categories requires an explicit `D-*` decision.

### 4.2 Discovery (adapters)

- FR-005 Modular adapters per the 12 locked categories (see `SOURCE_INTEGRATION_PLAN.md` S-01…S-12). Each adapter independently enable/disable/testable behind a shared interface. MVP ships a **small number** of permitted integrations first (priority TBD, D-003).
- FR-006 Every discovered candidate records: source, adapter version, query, retrieval timestamp, raw snapshot ref. No record without provenance.
- FR-007 Adapter failures are logged (cause class, retry count) and degrade to manual fallback; poison items quarantined.

### 4.3 Research and evidence

- FR-008 Controlled public-page fetching when justified (robots/terms respected, rate-limited, hashed snapshots). See `SOURCE_INTEGRATION_PLAN.md#fetching-policy`.
- FR-009 Evidence ledger: every material claim has claim status (`observed`/`corroborated`/`inferred`/`assumed`), source reliability (A–D) and information credibility (1–5) recorded **separately**, timestamps, freshness/expiry. Detail: `DATA_MODEL_AND_EVIDENCE.md`.
- FR-010 Contradiction handling: contradictory evidence linked to the same claim/hypothesis and surfaced in briefs; suppression is a defect.
- FR-011 Anti-false-negative rules: missing website feature ≠ internal problem; missing API docs ≠ no API; observable agency signals ≠ proven internal operational problems. Such inferences must be labeled `assumed` with corroboration required before validation passes, and briefs must present them as hypotheses with validation questions for the human-led conversation — never as established facts.
- FR-012 Prompt-injection defense: external content stored/quoted as data; imperative content never executed; suspected injections logged, excluded, escalated.

### 4.4 Understanding and hypotheses

- FR-013 Agency business profile per qualified company: agency type (per §2 PROPOSAL vocabulary), service lines (as stated), offerings, observable digital presence, hiring/product signals, country/region — each bullet traceable to evidence IDs. Internal operational claims require corroboration per FR-011 or stay labeled hypotheses.
- FR-014 Hypothesis generation: each hypothesis links ≥1 supporting evidence item and, where contradictory evidence is available, links it as well; each carries validation status (`proposed`/`evidenced`/`validated`/`rejected`/`stale`). A hypothesis about an agency's internal operations stays below `validated` until confirmed via the human-led conversation or independent corroboration.
- FR-015 Validation gates: evidence-sufficiency + freshness + contradiction-review must pass before `validated`. Scores never override gates.

### 4.5 Capability mapping and project design

- FR-016 Grayscales capability catalog (PROPOSAL structure; content TBD D-004): service lines with entry criteria. Every project option links to ≥1 catalog entry + ≥1 hypothesis.
- FR-017 Project options include: scope in/out, milestones, effort range, dependencies, technical feasibility rating + rationale, Grayscales capability fit, impact/benefit assumptions, commercial assumptions (ranges), and validation questions for the human-led agency conversation. Prices/timelines as **ranges with assumptions**, never point promises.
- FR-018 Technical feasibility rubric: data availability, integration surface (observed), operational fit, risk list. Infeasible-but-valuable items flagged, not silently dropped.

### 4.6 Qualification, scoring, ranking

- FR-019 Transparent deterministic scoring only (MVP). Weights provisional; every score reproducible with factor breakdown. Detail: `SCORING_AND_OPPORTUNITY_MODEL.md`.
- FR-020 Ranking orders the review queue but never hides contradictory evidence or bypasses eligibility gates.

### 4.7 Review, briefs, outreach drafts

- FR-021 Review queue: ordered, filterable (segment, score band, freshness, evidence completeness), with state transitions audited.
- FR-022 Opportunity brief (per brief): agency summary (type, country/region, service lines), evidence table, hypotheses + validation, project options (with feasibility, capability fit, commercial assumptions, validation questions), risks/contradictions, provenance appendix, outreach draft ref. Incomplete-evidence briefs labeled as such; unconfirmed internal-problem claims labeled hypotheses, never facts.
- FR-023 Outreach drafts: personalized, grounded in evidenced claims, labeled `DRAFT — HUMAN SEND ONLY`. System must not contain any send path (no SMTP/DM/form-post code in MVP).

### 4.8 Outcomes and learning {#failures-and-learning}

- FR-024 Manual outcome recording: sent date/channel, reply, meeting, win/loss, deal range (optional), rejection reason (controlled vocabulary + free text), failure class.
- FR-025 Rejection/failure log + basic learning reports: win/reply rates by segment/source/hypothesis type; top rejection reasons; stale-evidence rate. Reports inform rule/threshold tuning via recorded decisions — no automatic weight changes in MVP.

## 5. Non-functional requirements

- NFR-001 Traceability: any brief field traceable to evidence → snapshot → source.
- NFR-002 Explainability: any score/rank reproducible with inputs + version.
- NFR-003 Auditability: state transitions, merges, reviews, outcome edits appended to immutable history.
- NFR-004 Security: secrets via env/secret manager; no secrets in docs/logs; least-privilege DB roles; see `PROJECT_IMPLEMENTATION.md#configuration-and-secrets`.
- NFR-005 Privacy: business data minimized; personal data minimized; opt-out/takedown honored; retention per `DATA_MODEL_AND_EVIDENCE.md#retention`.
- NFR-006 Reliability: bounded retries, idempotent intake, quarantine on repeated failure.
- NFR-007 Performance (PROPOSAL, TBD calibration): p95 brief render < 3 s on seed data; imports of 500 rows < 60 s. Mark TBD until measured.
- NFR-008 Accessibility (operator UI): keyboard-navigable review queue and briefs; contrast/text minima per project decision (TBD which standard version — default WCAG 2.2 AA PROPOSAL).
- NFR-009 Observability: structured logs, error records, auditable transitions (see implementation doc).

## 6. Security, privacy, failure behavior

- Authorized read-only public access by default; authenticated/paid APIs only with recorded decision + human credentials.
- Failures: classify (rate-limit, auth, terms-block, parse, network, injection-suspect), retry bounded with backoff, then quarantine + surface. Never silently drop.
- Injection handling per [SECURITY_AND_SCOPE.md](../agents/SECURITY_AND_SCOPE.md) §2.

## 7. Acceptance criteria (MVP)

- AC-001 20 high-quality briefs manually researched + reviewed before scaling automation (quality bar: G1–G6 gates pass; no requirement that all convert).
- AC-002 All FR-001…FR-025 demonstrable on seed data with provenance intact.
- AC-003 No auto-send path exists (code search + QA attestation).
- AC-004 Scoring reproducibility check passes (same inputs → same outputs + explanations).
- AC-005 Docs consistency audit passes (checklist in master prompt §14).

## 8. Future extensions (out of MVP)

- Additional adapters beyond initial priority (evaluated by permitted access, data quality, cost, qualified-opportunity yield); operation in additional agency-type/country slices of the worldwide agency segment; outcome-driven threshold proposals; optional governed LLM assistance; hosted observability. Expansion to non-agency business categories or new source categories requires a `D-*` decision.
