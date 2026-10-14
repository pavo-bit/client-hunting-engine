# EXECUTION_PROTOCOL — Inspect, Plan, Edit, Validate, Report

## 1. Standard sequence

1. **Inspect.** Confirm working directory is project root. Read assigned role file, relevant `docs/` sections, and target code regions. Check `../docs/DECISIONS_AND_OPEN_QUESTIONS.md` for applicable `D-*` items. Never edit blind.
2. **Plan.** State objective, prerequisites, files likely affected, expected result, verification method. Reference `T-*` task IDs from `../docs/LOW_LEVEL_PLANNING.md` when applicable. For multi-role work, orchestrator sequences assignments.
3. **Edit.** Smallest safe change meeting the task. No unrelated refactors. Derive replacements from current file content. One writer per file at a time.
4. **Validate.** Run applicable checks from `QUALITY_GATES.md`. Execute tests/links verification where relevant; report actual commands + outputs.
5. **Report.** Files created/updated, verification results (honest), remaining work, new TBDs/decisions. Summarize; don't dump full history.

## 2. Planning discipline

- Reuse existing files/modules; justify any new file.
- Break work into independently reviewable units with acceptance criteria.
- Mark proposals vs. verified facts. If a fact can't be verified, label `TBD`/`ASSUMPTION`, don't fabricate.

## 3. Editing discipline

- Preserve existing behavior outside the task scope. No drive-by formatting of unrelated sections.
- After edits with preservation constraints, re-read the edited region to confirm constraints hold; repair or escalate.

## 4. Error recovery

1. Reproduce and capture the error verbatim (log excerpt + command).
2. Form 1–3 hypotheses; check cheapest evidence first (file reads, config, spec).
3. Fix the smallest cause; re-validate.
4. Record failures per spec failure-logging requirements (see `../docs/PROJECT_SPECIFICATION.md#failures-and-learning`); never claim a fix without re-running the check.

## 5. Escalation

Escalate to orchestrator/human when: scope decision needed, roles disagree, security/injection suspected, credentials missing, source terms ambiguous, or validation repeatedly fails. Include evidence and options; do not silently change architecture.
