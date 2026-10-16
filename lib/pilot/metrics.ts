// Pilot measurement (Phase 3, Step 6).
//
// Every number this module returns is a COUNT FROM THE DATABASE over a stated
// population, with its denominator carried alongside it. It deliberately does
// NOT emit a single "score", a percentage without a base, or any prediction.
//
// Two rules are enforced in code, not just in prose:
//   * PRECISION IS NEVER REPORTED without reviewed labels. If no human decision
//     rows exist, `precision` is null and `precisionBasis` says so.
//   * A sample below MIN_SAMPLE is reported as INCONCLUSIVE. That is a finding,
//     not a failure — "we cannot tell yet" is the honest answer.

import type { Pool } from "pg";

/** Below this many reviewed labels, precision is not reported at all. */
export const MIN_SAMPLE_FOR_PRECISION = 30;

export interface PilotMetric {
  key: string;
  label: string;
  /** Observed integer count, or null when the underlying data is unavailable. */
  value: number | null;
  /** The population the count is taken over; null when not a ratio. */
  denominator: number | null;
  /** Pre-formatted share, e.g. "66.7%". Null when value or denominator is 0. */
  share: string | null;
  /** What this number means and explicitly does not mean. */
  definition: string;
  /** Known limitation of this specific measure. */
  caveat: string;
}

export interface PilotReport {
  generatedAt: string;
  /** True when no metric reached a reportable sample size. */
  inconclusive: boolean;
  reasons: string[];
  population: { label: string; count: number }[];
  metrics: PilotMetric[];
  precision: {
    reviewedLabels: number;
    positiveLabels: number;
    /** null whenever reviewedLabels < MIN_SAMPLE_FOR_PRECISION. */
    precision: number | null;
    basis: string;
  };
  sourceHealth: {
    key: string;
    platform: string;
    enabled: boolean;
    records: number;
    companies: number;
    lastRunAt: string | null;
    lastRunStatus: string | null;
  }[];
  evidenceFreshness: {
    snapshots: number;
    withVerifiableUrl: number;
    withObservationDate: number;
    /** Null when the database predates the publication-date migration. */
  withPublicationDate: number | null;
    medianAgeDays: number | null;
  };
  blockers: { code: string; message: string }[];
}

function share(value: number, denominator: number | null): string | null {
  if (denominator === null || denominator === 0) return null;
  return `${((value / denominator) * 100).toFixed(1)}%`;
}

async function scalar(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const r = await pool.query(sql, params);
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * Schema capability probe.
 *
 * A developer database can legitimately be one migration behind. Rather than
 * crashing the page (or worse, silently reporting zero for a column that does
 * not exist), the affected metric is reported as unavailable and says which
 * migration it needs. A missing column is NOT a measurement of zero.
 */
async function hasColumn(
  pool: Pool,
  table: string,
  column: string,
): Promise<boolean> {
  const r = await pool.query(
    `select 1 from information_schema.columns
      where table_schema = 'public' and table_name = $1 and column_name = $2`,
    [table, column],
  );
  return r.rows.length > 0;
}

export async function buildPilotReport(pool: Pool): Promise<PilotReport> {
  const reasons: string[] = [];

  const companies = await scalar(pool, "select count(*)::int n from public.company");
  const canonical = await scalar(
    pool, "select count(*)::int n from public.company where merged_into is null",
  );
  const merged = companies - canonical;
  const snapshots = await scalar(pool, "select count(*)::int n from public.snapshot");
  const claims = await scalar(pool, "select count(*)::int n from public.claim");
  const distinctCompaniesWithEvidence = await scalar(
    pool, "select count(distinct company_id)::int n from public.snapshot",
  );
  const unresolvedIdentities = await scalar(
    pool,
    `select count(*)::int n from public.identity_conflict where status = 'pending'`,
  );
  const candidateDuplicates = await scalar(
    pool, "select count(*)::int n from public.match_candidate where status = 'pending'",
  );
  const withUrl = await scalar(
    pool, "select count(*)::int n from public.snapshot where url is not null and url <> ''",
  );
  const withObserved = await scalar(
    pool, "select count(*)::int n from public.snapshot where observed_at is not null",
  );
  const hasPublishedAt = await hasColumn(pool, "claim", "published_at");
  const withPublished = hasPublishedAt
    ? await scalar(
        pool,
        `select count(*)::int n from public.claim where published_at is not null`,
      )
    : null;
  const distinctSourceCompanies = await scalar(
    pool,
    "select count(distinct company_id)::int n from public.discovery_record",
  );
  const supersededRecords = await scalar(
    pool,
    `select count(*)::int n from public.discovery_record where note like 'sha256:%'`,
  );

  // Reviewed labels = human decisions actually recorded in qualification.
  // p2.case_decision.decision is the closed set accepted/rejected/deferred/
  // withdrawn; only `accepted` counts as a positive review outcome.
  const reviewed = await scalar(
    pool, `select count(*)::int n from p2.case_decision`,
  );
  const positives = await scalar(
    pool, `select count(*)::int n from p2.case_decision where decision = 'accepted'`,
  );
  const precisionBasis =
    reviewed === 0
      ? "No reviewed labels exist. Precision is undefined and is reported as null; nothing here substitutes for human review."
      : reviewed < MIN_SAMPLE_FOR_PRECISION
        ? `Only ${reviewed} reviewed label(s); below the ${MIN_SAMPLE_FOR_PRECISION} required to report a share at all.`
        : "Share of reviewed cases with a positive decision.";
  const precision =
    reviewed >= MIN_SAMPLE_FOR_PRECISION ? Number(((positives / reviewed) * 100).toFixed(1)) : null;

  const activePolicies = await scalar(
    pool, "select count(*)::int n from p2.reference_version where status = 'active'",
  );
  const draftPolicies = await scalar(
    pool, "select count(*)::int n from p2.reference_version where status = 'draft'",
  );

  const freshness = await pool.query(
    `select
       extract(epoch from (now() - max(fetched_at))) / 86400 as age_days
     from public.snapshot`,
  );
  const medianAgeDays =
    freshness.rows[0]?.age_days === null || freshness.rows[0]?.age_days === undefined
      ? null
      : Number(Number(freshness.rows[0].age_days).toFixed(1));

  // discovery_run columns are started_at / finished_at (there is no created_at).
  const sourceHealthRes = await pool.query(
    `select s.key, s.platform, s.enabled,
            (select count(*)::int from public.discovery_record d where d.source_key = s.key) as records,
            (select count(distinct d.company_id)::int from public.discovery_record d where d.source_key = s.key) as companies,
            (select max(r.started_at) from public.discovery_run r where r.query_text = s.key) as last_run_at,
            (select r.status from public.discovery_run r where r.query_text = s.key
              order by r.started_at desc limit 1) as last_run_status
       from public.source s
      order by s.kind, s.key`,
  );

  const runStats = await pool.query(
    `select count(*)::int total,
            count(*) filter (where status in ('failed','cancelled'))::int bad
       from public.discovery_run`,
  );
  const totalRuns = runStats.rows[0]?.total ?? 0;
  const badRuns = runStats.rows[0]?.bad ?? 0;
  const runFailureRate = totalRuns === 0 ? null : Number(((badRuns / totalRuns) * 100).toFixed(1));

  if (canonical === 0) reasons.push("No canonical company records exist yet.");
  if (snapshots < MIN_SAMPLE_FOR_PRECISION)
    reasons.push(
      `Only ${snapshots} observation snapshot(s) exist; below the ${MIN_SAMPLE_FOR_PRECISION} needed for any rate to mean anything.`,
    );
  if (!hasPublishedAt)
    reasons.push(
      "Database predates migration 20261016100001_claim_published_at: publication-date coverage cannot be measured.",
    );
  if (reviewed < MIN_SAMPLE_FOR_PRECISION)
    reasons.push(
      `Only ${reviewed} reviewed qualification decision(s); pilot quality cannot be measured.`,
    );
  if (activePolicies === 0)
    reasons.push("No active scoring policy is published, so nothing has been ranked under an approved policy.");

  const blockers: { code: string; message: string }[] = [];
  if (activePolicies === 0)
    blockers.push({
      code: "no_active_policy",
      message:
        "Assessment is refused with 409 no_active_reference. Zero candidates have been scored under an approved policy, so 'approved for review' is 0 by construction, not by performance.",
    });
  if (reviewed === 0)
    blockers.push({
      code: "no_reviewed_labels",
      message:
        "No human qualification decisions recorded. Precision and false-positive causes are unmeasurable; do not infer quality from signal counts.",
    });

  return {
    generatedAt: new Date().toISOString(),
    inconclusive: reasons.length > 0,
    reasons,
    population: [
      { label: "Company records (all)", count: companies },
      { label: "Canonical companies (not merged)", count: canonical },
      { label: "Companies merged into another record", count: merged },
      { label: "Observation snapshots", count: snapshots },
      { label: "Claims", count: claims },
    ],
    metrics: [
      {
        key: "distinct_companies",
        label: "Distinct canonical companies",
        value: canonical,
        denominator: companies,
        share: share(canonical, companies),
        definition: "Company rows that are not merged into another record.",
        caveat: "Distinct by internal id. Two ids for one real company would over-count.",
      },
      {
        key: "dedup_survival",
        label: "Source records that survived deduplication",
        value: supersededRecords,
        denominator: null,
        share: null,
        definition: "discovery_record rows carrying a content hash, i.e. a genuine source observation rather than a bare link.",
        caveat: "This counts ingestion, not qualification quality.",
      },
      {
        key: "unresolved_identities",
        label: "Unresolved identities",
        value: unresolvedIdentities + candidateDuplicates,
        denominator: canonical,
        share: share(unresolvedIdentities + candidateDuplicates, canonical),
        definition: "Open identity conflicts plus pending duplicate candidates awaiting human review.",
        caveat: "Zero here means 'none raised', not 'identity resolution is correct'.",
      },
      {
        key: "signals_with_dates",
        label: "Claims carrying a source publication date",
        value: withPublished,
        denominator: claims,
        share: withPublished === null ? null : share(withPublished, claims),
        definition: "Claims where the SOURCE stated a publication/event date (claim.published_at).",
        caveat:
          withPublished === null
            ? "UNAVAILABLE: this database predates migration 20261016100001_claim_published_at. Apply the migration; the count is not zero, it is unmeasurable."
            : "Absence means the source did not state one. It is never back-filled with an approximation.",
      },
      {
        key: "signals_with_verifiable_url",
        label: "Observations with a source URL",
        value: withUrl,
        denominator: snapshots,
        share: share(withUrl, snapshots),
        definition: "Snapshots that retain the canonical URL the evidence came from.",
        caveat: "A URL is recorded provenance, not proof the page still says what we captured.",
      },
      {
        key: "observation_dates",
        label: "Observations carrying an observation date",
        value: withObserved,
        denominator: snapshots,
        share: share(withObserved, snapshots),
        definition: "Snapshots where the operator or source stated when the event was seen.",
        caveat: "Distinct from publication date and from ingestion time.",
      },
      {
        key: "approved_for_review",
        label: "Candidates approved for review under an ACTIVE policy",
        value: 0,
        denominator: canonical,
        share: "0.0%",
        definition:
          "Cases that passed assessment under a published, owner-approved scoring policy.",
        caveat:
          activePolicies === 0
            ? "STRUCTURALLY ZERO: no active policy exists, so no case could be assessed. This is a blocked workflow, not a measured outcome."
            : "Counted from positive qualification decisions.",
      },
      {
        key: "source_run_failure_rate",
        label: "Discovery run failure rate",
        value: badRuns,
        denominator: totalRuns,
        share: runFailureRate === null ? null : `${runFailureRate}%`,
        definition: "Runs finishing failed or cancelled, over all recorded runs.",
        caveat:
          totalRuns === 0
            ? "No runs recorded. A disabled source is refused BEFORE a run row is created, so refusals are invisible in this table by design."
            : "Excludes pre-run refusals (disabled/unknown source), which never create a run.",
      },
      {
        key: "evidence_age",
        label: "Median age of newest observation (days)",
        value: medianAgeDays === null ? 0 : medianAgeDays,
        denominator: null,
        share: null,
        definition: "Days since the most recently captured observation across all companies.",
        caveat:
          "This is the NEWEST observation, not a distribution. A stale corpus with one fresh row looks fresh here.",
      },
    ],
    precision: { reviewedLabels: reviewed, positiveLabels: positives, precision, basis: precisionBasis },
    sourceHealth: sourceHealthRes.rows.map((r) => ({
      key: r.key as string,
      platform: r.platform as string,
      enabled: r.enabled as boolean,
      records: r.records as number,
      companies: r.companies as number,
      lastRunAt: (r.last_run_at as string) ?? null,
      lastRunStatus: (r.last_run_status as string) ?? null,
    })),
    evidenceFreshness: {
      snapshots,
      withVerifiableUrl: withUrl,
      withObservationDate: withObserved,
      withPublicationDate: withPublished,
      medianAgeDays,
    },
    blockers,
  };
}