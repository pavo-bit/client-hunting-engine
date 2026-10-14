# Agents Directory — README

## Purpose

This directory holds instruction files for coding agents working on Grayscales Business Opportunity Intelligence. It separates stable universal rules from compact context and role-specific duties so agents load only what a task needs.

## Hierarchy

1. `AGENTS.md` (repo root) — entry point, boundaries, reading order.
2. `agents/` shared files — apply to all roles:
   - `AGENT_RULES.md` — universal behavior and permissions.
   - `PROJECT_CONTEXT.md` — compact canonical summary (full requirements live in `docs/`).
   - `SECURITY_AND_SCOPE.md` — data boundaries and threat rules.
   - `EXECUTION_PROTOCOL.md` — how to work and report.
   - `QUALITY_GATES.md` — mandatory checks.
3. `agents/roles/*.md` — one file per logical responsibility.
4. `docs/*.md` — authoritative specification and plans (loaded selectively).

## Role selection

| Task | Role file |
|---|---|
| Task routing, dependency management, integration, final verification | `roles/orchestrator.md` |
| Source adapters, company intake, dedup | `roles/discovery-agent.md` |
| Snapshots, claims, provenance, evidence quality | `roles/evidence-agent.md` |
| Hypotheses, validation, qualification input | `roles/opportunity-agent.md` |
| Capability matching, scope, feasibility, commercial assumptions | `roles/project-architect-agent.md` |
| Review queue, briefs, outreach drafts, outcome recording | `roles/review-and-sales-agent.md` |
| Tests, authZ, policy checks, threat review | `roles/qa-security-agent.md` |

Assign the smallest relevant role. If a task spans roles, the orchestrator sequences them; do not load all role files at once.

## Loading policy

- Always: `AGENTS.md` + assigned role file + the specific `docs/` sections the role file lists.
- Usually: `AGENT_RULES.md`, `SECURITY_AND_SCOPE.md` (mandatory for source/web/outreach tasks).
- Rarely: entire `docs/` tree. Prefer section links (e.g. `../docs/PROJECT_SPECIFICATION.md#evidence-model`).
- Never duplicate full requirements into role files or outputs; link to them.

## Adding or changing instructions

- Keep universal rules in `AGENT_RULES.md`; keep role-only rules in that role's file.
- Point to `../docs/PROJECT_SPECIFICATION.md` for requirements; do not fork them.
- Record scope/architecture changes in `../docs/DECISIONS_AND_OPEN_QUESTIONS.md` — agents never change locked scope silently.
