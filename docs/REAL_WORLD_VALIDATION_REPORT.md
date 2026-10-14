# REAL_WORLD_VALIDATION_REPORT — Validation Pilot (20 Real Agencies)

> Status: **PILOT, explicitly non-sign-off.** Protocol start approvals
> (§12 a–e) were never granted; the user authorized a pilot only. T-014 stays
> NOT STARTED. No approval fabricated, no case invented, no gate bypassed.
> Database: `agency_intel_validation` (isolated scratch; dev pristine).
> Actors: research `validation-pilot`, review `validation-reviewer`
> (single-operator limitation recorded §8).

## Verdict: CONDITIONAL PASS

20/20 agencies researched with real evidence; the workflow performed as
designed (including correct insufficient-evidence and deferral outcomes);
scoring reproduced byte-identically; but orchestration gaps (zero rejections,
single origins, no outcomes by design) and missing owner approvals keep this
a pilot, not a sign-off cohort.

## 1. Cohort register (20/20 researched)

Origins: S = company-site fetch, W = search-web excerpt, G = GLEIF adapter.
Grades: A/B/C observed-or-better, U assumed. Decisions: V validated, D deferred,
R rejected, G generated + request_evidence recorded.

| # | Agency (domain, country, type) | Origins | Claims | Hypotheses → decisions | Proposal | Brief | Score | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | Webveloper (webveloper.com, US, web) | S | 3 (B,B,C) | R-PORTAL-01 → G (evidence requested) | — | — | — | Multi-city US presence; questionnaire-led intake inference |
| 2 | CH Web Agency (chwebagency.com, US, web) | W | 2 (C,C) | R-INTEG → D, R-REPORT → D | — | — | — | Direct fetch 503; single-origin; deferred honestly |
| 3 | M&V Agency (mvagency.co, US, web) | W | 2 (C,C) | none fired | — | — | — | Fetch failed; price/terms captured; insufficient-evidence outcome |
| 4 | Web Developer LLC (webdeveloperllc.com, US, ecom) | S | 3 (B,B,C) | R-INTEG → V, R-PORTAL → V | accepted | approved BR-001 | 77/A, 67/B | Strongest case (fetched portal/ecommerce/pricing) |
| 5 | Agency Partner (agencypartner.com, US, custom) | W | 1 (C) | none fired | — | — | — | Thin evidence; insufficient-evidence outcome |
| 6 | ADA London (appdevelopmentagency.uk, UK, mobile) | S | 3 (B,B,B) | R-PORTAL → V, R-TEST → D | accepted | approved BR-003 | 67/B | Portals/PWAs + cost bands fetched |
| 7 | App Dev (app-dev.co.uk, UK, mobile) | W | 1 (C) | none fired | — | — | — | Thin; insufficient-evidence outcome |
| 8 | MAD (mobileappdevelopersltd.co.uk, UK, mobile) | W | 1 (C) | none fired | — | — | — | Thin; insufficient-evidence outcome |
| 9 | Visionsharp (visionsharp.co.uk, UK, mobile) | W | 1 (C) | R-INTEG → V | accepted | approved BR-004 | 67/B | Weakest validation (single search origin) — flagged, not rejected |
| 10 | Stables (stablesconsulting.co.uk, UK, custom) | S | 3 (B,B,C) | R-TEST → D | — | — | — | Auth-architecture evidence; integration rule did not fire (no keyword) |
| 11 | Thinkideas (thinkideas.de, DE, ecom) | S | 2 (B,B) | R-INTEG → V, R-TEST → D | accepted | approved BR-005 | 67/B | Munich Shopify practice, fetched |
| 12 | PSJN (psjn.eu, DE, ecom) | W | 2 (C,C) | none fired | — | — | — | Migration/conversion focus; no rule keywords — honest miss |
| 13 | Friendventure (friendventure.de, DE, ecom) | W | 1 (C) | none fired | — | — | — | Merged with GLEIF twin (see §2) |
| 14 | 34Devs (34devs.com, DE, ecom) | W | 2 (C,C→disputed) | R-INTEG → D (contradiction open) | — | — | — | Genuine 0-vs-100+ contradiction preserved; validation refused |
| 15 | Latori (latori.com, DE, ecom) | S | 3 (B,B,B) | R-INTEG → V | accepted | approved BR-007 | 77/A | ERP-integration quote fetched; strongest DE case |
| 16 | WDS (wds.com.sg, SG, web) | S | 2 (B,B) | R-TEST → D | — | — | — | In-house/W3C process evidence; no portal/integration text |
| 17 | MediaPlus (mediaplus.com.sg, SG, web) | W | 1 (C) | none fired | — | — | — | Thin; insufficient-evidence outcome |
| 18 | Awebstar (awebstar.com.sg, SG, web) | S | 2 (B,B) | R-INTEG → V | accepted | approved BR-006 | 67/B | Payment/inventory integrations fetched |
| 19 | Web Development Agency (webdevelopmentagency.in, IN, web) | W | 1 (C) | none fired | — | — | — | Directory-only (Noida, 3 staff); thin |
| 20 | Ecom Flow (ecom-flow.de, DE, ecom) | W | 1 (C) | none fired | — | — | — | Directory-only; thin |
| 21 | Friendventure GmbH (LEI 9845004A134DB2A65573, DE) | G | 0 (registry record) | merged into #13 | — | — | — | Live GLEIF discovery; not a 22nd case |

Strata: types web 7 / mobile 4 / ecom 7 / custom 2 (≥4 ✓); countries US 5 /
UK 5 / DE 6 / SG 3 / IN 1 (≥5 ✓); origins S+W everywhere, G once (✓ all
three); identity conflict reviewed 1 merge (shortfall vs 3 — §8); genuine
contradictions 1 + several single-origin deferrals (shortfall vs 3 — §8).

## 2. Identity, evidence, contradiction outcomes

- **Merge (real):** GLEIF `Friendventure GmbH` (LEI …2A65573) vs manual
  `Friendventure` → `name_exact` candidate → human accepted with reason
  (older/manual wins); registry preserved as alias; snapshots stay with
  origin rows; post-merge queue clean, gates independent. Live adapter runs:
  Latori/Thinkideas `ok, found=0` (honest negatives, no forcing).
- **Natural collisions:** none among 20 distinct real agencies (domains all
  unique, names all distinct after normalization). Reject-path review
  unexercised on real data — shortfall, not a gap in the engine (30/30
  resolve tests cover the path synthetically).
- **Contradiction:** 34Devs 0-counters vs 100+ claim → linked `contradicts`,
  claim `disputed`, hypothesis deferred, validation refused. Engine + reviewer
  behaved exactly as specified.
- **Evidence grades:** 38 claims (observed 30+, corroborated 7, disputed 1,
  inferred/assumed embedded with explicit labels); 0 fabricated; 2 fetches
  failed honestly (503/transport) with search-only limitations recorded.

## 3. Workflow outcomes per eligible agency

7 validated hypotheses → 7 accepted proposals → 7 approved briefs → 7
`score_v1` scores → 2 human-only drafts (v1, unverified-points flagged).
10 agencies ended in documented insufficient-evidence states (no rule fired);
7 hypotheses deferred; 1 generated with evidence requested; **0 rejections**
(shortfall — nothing on real data met the reject bar; restraint preferred to
forced rejections). No eligibility gate bypassed anywhere (10 no-fire cases
prove the engine doesn't invent work). No outcomes recorded (no outreach
sent — correct). No weights touched.

## 4. Quality evaluation (rubric G1–G6, reviewer judgment)

- **G1 provenance:** all brief facts trace claim→snapshot→source; reliability/
  credibility separate; 34Devs contradiction shown. PASS (7/7).
- **G2 scoring:** reproducibility 7/7 byte-identical on re-run (AC-004 on
  real data ✓); explanations list factors; gates not overridden; weights
  acknowledged provisional. PASS with observation: **five briefs score
  exactly 67/B** — deterministic and explainable, but thin evidence yields
  low discrimination (calibration-readiness signal, not a defect).
- **G3 integrity:** canonical identities; no duplicate canonicals (1 merge
  correct); transitions audited (156 audit rows across 9 entity types). PASS.
- **G4 authorization:** GLEIF open data + official sites + search excerpts
  only; no scraping of platforms, no probing, no logins. PASS.
- **G5 outreach safety:** drafts human-only with unverified flags; no send
  path; briefs label inferences. PASS.
- **G6 failure/privacy:** fetch failures recorded as limitations; no personal
  data beyond business contacts published by the agencies; no secrets. PASS.
- **Actionability:** briefs name a concrete scoping pilot with assumptions —
  actionable as conversation openers, not as quotes (prices absent by D-005
  provisional). 7/7 reviewer-actionable with 2 findings below.

**Findings (pilot-execution defects, mine — engine innocent):**
F-1. Proposal titles embed a company-ID fragment (`for 0cfa050f`) from my
entry template — cosmetic internal-ID leak into human artifacts; review
catches it, but the template was wrong.
F-2. Two inference claims carry `observed` status with "(inference)" in text —
transparent but imprecise; they should be `inferred` status (protocol §3 grade
precision). No validation rested on the distinction.

## 5. False-positive / unsupported-claim analysis

- False positives (validated-but-unsupported): **0 found**. Weakest link:
  Visionsharp integration (single search origin) — disclosed in-register,
  retained as valid-but-thin, not hidden.
- Unsupported claims in approved briefs: **0** — every brief fact traces to
  assessed evidence; unknowns stay labeled.
- Rejected opportunities: 0 (shortfall noted §3). Missing-evidence patterns:
  single-origin thinness (10 agencies), fetch blocks (2), no hiring signals
  captured (R-HIRING never fired), registry corroboration only via GLEIF (1).

## 6. Effort, scoring, calibration

- **Effort:** ~6 searches + 10 fetches (2 failed) + 5 entry batches + review
  cycles ≈ one working session for 20 agencies at pilot depth (2–3 claims
  each). Production depth (second origins, contact verification) multiplies
  this — first-measurement baseline, no efficiency target set.
- **Scores:** 77/A ×2, 67/B ×5, all `partial:true` (missing inputs listed).
  Distribution + exclusion reasons (10 no-fire, 7 deferred, 1 generated)
  reported above; rankings vs human review agree (reviewer validated exactly
  the rankable set — circular by design at n=7, stated not hidden).
- **Calibration readiness: NOT READY.** 7 reviewed, 0 terminal outcomes;
  protocol needs n≥30 with frozen scores. No tuning performed or proposed.
  Synthetic cases not substituted. Scores make no commercial predictions.

## 7. Limitations (unresolved)

Pilot-only status; zero rejections on real data; reject-path identity review
unexercised; single-operator research+review (bias noted); thin single-origin
evidence for 10 agencies; no outcomes (correct); D-004/005/006/008 + QA +
weights-acceptance still pending; R-05 attestation outstanding; pilot DB kept
as evidence store (`agency_intel_validation` — documented, not scratch).
