# T014_VALIDATION_PROTOCOL — 20-Agency Real-World Validation

> Status: **IMPLEMENTATION-READY SPECIFICATION, PENDING OWNER APPROVAL TO
> START.** Canonical meaning preserved: T-014 is the real-world validation
> task per the register (AC-001…AC-005 on worldwide agency briefs) and
> `PROJECT_SPECIFICATION.md` §7 + `HIGH_LEVEL_PLANNING.md` P5. This document
> turns `docs/T014_VALIDATION_PROTOCOL_PROPOSAL.md` into executable rules.
> Starting the cohort without the §12 approvals is forbidden.

## 1. Research cohort selection rules

1.1. Exactly 20 agencies (“the cohort”), each a canonical `company` row.
1.2. Stratification (all mandatory): ≥4 distinct `agency_type` values; ≥5
     distinct countries; ≥3 discovery origins (directory-found, GLEIF-found,
     manually entered — at least one of each).
1.3. Difficulty mix (mandatory): ≥3 agencies with an open identity conflict
     at selection time (exercises FR-003 review); ≥3 with contradicting
     evidence (exercises needs_review).
1.4. Selection is recorded BEFORE research begins (company IDs + strata
     table in the recording template). Replacements (dead company, duplicate
     discovered mid-research) require reviewer note + preserve the strata.

## 2. Inclusion and exclusion criteria

2.1. **Include** iff: software/digital agency per D-001 (worldwide, any
     agency_type in the controlled vocabulary); publicly reachable evidence
     (site, directory, or registry entry); English- or reviewer-readable
     sources (reviewer records language; machine translation must be labeled
     as such on the claim).
2.2. **Exclude**: non-agency businesses (no D-* expansion by stealth);
     agencies with no public evidence footprint (record as excluded-with-
     reason, not as failures); agencies the operator has a personal interest
     in (record the conflict, replace the case).
2.3. Excluded candidates are logged with reason — exclusion is data, and a
     cohort padded with easy cases is a protocol violation.

## 3. Evidence-quality rubric (per claim)

| Grade | Meaning | Required for |
|---|---|---|
| A | Corroborated by ≥2 independent origins, fresh (within expiry) | May support `validated` |
| B | Observed from one reliable origin (A/B reliability), fresh | May support `inferred`-or-better; needs a second origin for validation |
| C | Single weaker origin, or aging | Supports `observed` only; flagged in briefs |
| U | Unverifiable / assumed / expired / disputed-unresolved | NEVER supports validation; must appear as assumption or be withdrawn |

3.1. Reliability (A–D, source) and credibility (1–5, information) stay
     recorded separately (FR-009); the grade is derived, never stored over them.
3.2. Every material brief fact traces claim → snapshot → source (NFR-001);
     the link audit must resolve for all 20 briefs.
3.3. FR-011 enforced: website-absence inferences are grade U by rule, labeled
     `assumed`, and require corroboration before validation passes.
3.4. Excerpts are quoted as data; imperative/instruction-like content is
     stored verbatim, never followed (G7 — injection fixtures in
     `tests/milestone2_integrity.test.ts` demonstrate the discipline).

## 4. Identity-resolution requirements

4.1. No brief may be approved while its company has a pending identity
     candidate (the scoring identity-clear gate already enforces this for
     ranking; the protocol extends it to brief approval as reviewer check).
4.2. Conflicting registry identifiers are resolved ONLY by human
     accept/reject with reason (never auto-merged — engine-enforced); the
     decision + reason are part of the case record.
4.3. Merged-away records keep history (aliases + audit); snapshots stay with
     the original record. The reviewer verifies the winner is canonical.

## 5. Hypothesis acceptance and rejection rules

5.1. `validate` requires: ≥1 grade-A-or-B support link, zero unacknowledged
     contradictions, freshness within horizon (the T-011 gates, human-applied).
5.2. `reject` requires a stated reason (evidence against, out of scope, or
     superseded-by-better-evidence); rejection_reason is mandatory (schema).
5.3. `defer` requires naming the missing evidence (creates the follow-up).
5.4. Internal-operations hypotheses stay below `validated` until confirmed
     via the human-led conversation or independent corroboration (FR-014).
5.5. Every decision is reviewer-recorded with actor + rationale (audit_log);
     the operator who researched a case should not be its sole reviewer
     where staffing allows (record single-reviewer cases as a limitation).

## 6. Opportunity-brief review rubric (per brief, G1–G6)

| Gate | Pass standard |
|---|---|
| G1 provenance | Every material fact has claim→snapshot→source; reliability/credibility separate; contradictions shown |
| G2 scoring | Score reproducible from inputs; explanation lists factors; gates not overridden; weights acknowledged provisional |
| G3 integrity | Canonical identity; no duplicate canonicals; transitions audited; freshness set |
| G4 authorization | Permitted sources/methods only; no terms violations; no probing |
| G5 outreach safety | Draft labeled human-only; grounded in evidenced claims; assumptions marked; no send path |
| G6 failure/privacy | Errors classified; personal data minimized; retention/takedown honored; no secrets in text |

6.1. Each brief gets pass/fail per gate with evidence pointers. ANY fail
     blocks that brief — failures recorded, never waived.
6.2. Stale flags (`getBriefWorkspace`) must be clear at approval time; an
     approved-then-staled brief is re-reviewed, never silently relied on.

## 7. Scoring evaluation methodology

7.1. Score every cohort hypothesis with `score_v1` BEFORE review decisions
     (frozen inputs); record total/band/version per hypothesis.
7.2. After review, re-run scoring on identical inputs: byte-identical totals
     required (AC-004). Re-generate the ranking: order-stable required.
7.3. Record gate outcomes per hypothesis (eligible vs excluded-with-reason).
     Excluded items are reported, never hidden (FR-020).
7.4. NO weight/band/gate changes during T-014 (D-006). The frozen scores are
     the future calibration baseline, not tuning material.

## 8. Outcome labels and measurement limitations

8.1. Labels (controlled): `no_reply / replied / positive_response /
     negative_response / referral / meeting / discovery_meeting / proposal /
     won / lost / disqualified / on_hold`, plus rejection codes and free-text
     notes. Recorded manually as replies arrive (FR-024).
8.2. Limitations (stated in every report): 20 briefs cannot reach n≥30
     calibration inputs; reply/win rates are descriptive, not predictive;
     non-response is not rejection; single-operator research carries observer
     bias (mitigated by §5.5, residual bias recorded).

## 9. Reviewer recording requirements

9.1. Every case records: researcher, reviewer(s), dates, per-gate verdicts
     with evidence pointers, decisions with rationales, exclusions with
     reasons, and limitations encountered.
9.2. Format: `docs/T014_RECORDING_TEMPLATE.md` (one copy per cohort run).
     No parallel formats — the template IS the case file.

## 10. Reproducible reporting format

10.1. Per-cohort report contains: cohort table (§1.4), the §11 counts,
     per-brief gate matrix (§6), reproducibility log (§7.2–7.3), link-audit
     output, outcome starter log, limitations (§8.2), MVP decision
     (PASS / PASS-WITH-FOLLOW-UPS / NOT-YET + follow-up list).
10.2. All counts recomputable from the database; the report cites the
     queries/commands used (no screenshots-as-evidence).

## 11. Data protection and source-access restrictions

11.1. Local-only throughout (AUTH-001 + loopback bindings verified before
     brief #1). No production data leaves the host; no cloud; no new
     integrations without a `D-*` decision.
11.2. Personal data minimized (names/roles only where business-relevant);
     takedown requests honored via existing explicit-delete paths; retention
     stays provisional per D-008 (no purge jobs during validation).
11.3. Sources: the 12 locked categories + GLEIF connector only; robots/terms
     respected; rate limits honored; no LinkedIn scraping; no probing of
     company systems (NG-003); fetched content treated as untrusted data.
11.4. Secrets hygiene: no credential, token, or session identifier in case
     files, logs, or the report. The release checklist's secrets section is
     re-verified before sign-off.

## 12. Approval needed to start (ALL required)

- (a) Sample plan (§1) confirmed; (b) D-004 catalog posture + D-005 pricing
  posture sufficient for 20 commercial cases (formalized provisionals
  acceptable — see decision records); (c) named QA assignee for attestation
  (closes R-05); (d) acceptance that weights stay provisional through
  sign-off; (e) owner commitment of research labor. Each approval dated in
  the register. Missing any one: T-014 does not start.
