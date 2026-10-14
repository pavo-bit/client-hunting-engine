# PROJECT_CONTEXT — Compact Canonical Summary

> Full requirements: `../docs/PROJECT_SPECIFICATION.md`. This file is a pointer + summary, not a fork.

## Project

**Grayscales Business Opportunity Intelligence** — internal BD intelligence system for Grayscales | Digital Solutions. Converts traceable public evidence into specific, feasible, commercially justified software-project opportunities.

## Lifecycle (canonical)

Discover → Resolve → Qualify → Research → Record Evidence → Understand → Generate Hypotheses → Validate → Design Project → Evaluate → Review → Prepare Outreach → Human Executes → Record Outcomes → Improve Rules.

## MVP essentials (see spec § MVP)

Canonical agency records + dedup; source/snapshot provenance; evidence ledger (observed/corroborated/inferred/assumed; reliability separate from credibility); manual entry + CSV import; small number of permitted discovery integrations evaluated incrementally (access/quality/cost/yield); worldwide software/digital agency segment (agency-type/country as filters, not separate segments); agency profiles; hypotheses with supporting + contradictory evidence (where available); capability catalog; project mapping with feasibility, capability fit, commercial assumptions, validation questions; transparent scoring; human review queue; briefs + outreach drafts (human-send-only); manual outcome tracking; rejection/failure logging + learning reports. Validation target: 20 high-quality agency briefs manually reviewed before scaling automation (no assumption all 20 convert; internal problems never stated as fact without human-led validation).

## Locked constraints

- Internal tool; manual-only outreach (drafts only, human sends); permitted public sources only.
- Target: software/digital agencies worldwide (D-001/D-002 decided). No expansion to non-agency categories without a `D-*` decision.
- 12 supported source categories (see `../docs/SOURCE_INTEGRATION_PLAN.md`); Reddit + YouTube excluded.
- Deterministic explainable scoring; no ML scoring in MVP.
- Stack direction: Next.js + TypeScript frontend; PostgreSQL via Supabase; modular monolith; simplest adequate background jobs; optional isolated LLM; structured logs + auditable transitions.
- Current repo state (2026-10-12 audit): **empty workspace, no git, no manifests, no code** — all stack/schema/API items are PROPOSAL until implemented.

## Key doc pointers

- Requirements: `../docs/PROJECT_SPECIFICATION.md`
- Build design: `../docs/PROJECT_IMPLEMENTATION.md`
- Data/evidence: `../docs/DATA_MODEL_AND_EVIDENCE.md`
- Sources: `../docs/SOURCE_INTEGRATION_PLAN.md`
- Scoring: `../docs/SCORING_AND_OPPORTUNITY_MODEL.md`
- Tasks: `../docs/LOW_LEVEL_PLANNING.md`
- Open decisions: `../docs/DECISIONS_AND_OPEN_QUESTIONS.md` (source priority, catalog, pricing, weights, retention, stack — all still TBD/OPEN; segment + scope decided)
