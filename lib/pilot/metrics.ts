// Pilot measurement (Phase 3; corrected in Phase 4).
//
// Every number returned is a database count over a stated population, with its
// denominator carried alongside it. Rules enforced in code, not just prose:
//
//  * PRECISION IS NOT ACCEPTANCE RATE. Precision is computed ONLY from
//    `public.source_record_review` — explicit human correctness labels on source
//    records. A qualification decision (accepted/rejected/deferred) is a
//    pursuit choice and is never treated as evidence of correctness.
//  * NO INVENTED ZERO. Where a value cannot be computed (missing schema, no
//    active policy, no eligible population) the field is null and the reason is
//    reported. Zero means "measured, and the count is zero".
//  * NO SILENT DATE SUBSTITUTION. Publication, observation and ingestion dates
//    are separate metrics; a missing publication date is never replaced by the
//    ingestion time.
//  * A source is never associated with a run by matching free text.

import type { Pool } from "pg";
import { getProductionRegistry } from "../discovery/production";
import { SOURCE_KEY as DEFAULT_RUN_SOURCE_KEY } from "../discovery/run";

/** Sample standard for a FORMAL pilot conclusion (owner-agreed, Phase 4). */
export const PILOT_REVIEW_STANDARD = 60;
export const PILOT_REVIEW_RUN_STANDARD = 4;
/** Below this, precision may be shown as an observation but is not a conclusion. */
export const MIN_SAMPLE_FOR_PRECISION = 30;
const WILSON_Z = 1.959963984540054; // 95%

export interface PilotMetric {
  key: string;
  label: string;
  /** Observed count, or null when it cannot be computed (never a fake zero). */
  value: number | null;
  denominator: number | null;
  share: string | null;
  definition: string;
  caveat: string;
}

export interface SourcePrecision {
  sourceKey: string;
  /** Distinct source records carrying at least one human label. */
  reviewedRecords: number;
  labelledCorrect: number;
  labelledIncorrect: number;
  /** Excluded from the denominator, reported so it cannot hide. */
  labelledUnusable: number;
  /** Distinct discovery runs contributing reviewed records. */
  distinctRuns: number;
  /** correct / (correct + incorrect); null when the denominator is 0. */
  precision: number | null;
  /** Wilson 95% interval; null when the denominator is 0. */
  ci95: { low: number; high: number } | null;
  /** True only when the owner-agreed standard is met. */
  meetsPilotStandard: boolean;
  note: string;
}

export interface PilotReport {
  generatedAt: string;
  inconclusive: boolean;
  reasons: string[];
  population: { label: string; count: number }[];
  metrics: PilotMetric[];
  approvedForReview: {
    value: number | null;
    detail: string;
    activePolicyVersion: string | null;
  };
  freshness: {
    /** Days, median over snapshots carrying a valid observed_at. */
    medianObservationAgeDays: number | null;
    observationSample: number;
    /** Days, median over ingestion time. Reported separately, never merged. */
    medianIngestionAgeDays: number | null;
    ingestionSample: number;
    medianPublicationAgeDays: number | null;
    publicationSample: number;
    /** Same measures, kept separate per source so populations never mix. */
    perSource: {
      sourceKey: string;
      observationMedian: number | null;
      observationSample: number;
      ingestionMedian: number | null;
      ingestionSample: number;
      publicationMedian: number | null;
      publicationSample: number;
    }[];
  };
  precision: {
    /** Reviewed correct / (correct + incorrect). Null below the minimum. */
    value: number | null;
    reviewedRecords: number;
    ci95: { low: number; high: number } | null;
    basis: string;
    standard: { requiredRecords: number; requiredRuns: number; met: boolean };
  };
  perSourcePrecision: SourcePrecision[];
  sourceHealth: {
    key: string;
    platform: string;
    enabled: boolean;
    records: number;
    companies: number;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    /** How lastRun* was established; "unavailable" when it cannot be. */
    lastRunBasis: string;
  }[];
  unattributedRuns: { adapterIds: string[]; runs: number };
  blockers: { code: string; message: string }[];
}

function share(value: number | null, denominator: number | null): string | null {
  if (value === null || denominator === null || denominator === 0) return null;
  return `${((value / denominator) * 100).toFixed(1)}%`;
}

/**
 * Wilson score interval for a binomial proportion. Documented method
 * (Wilson 1927), appropriate for small samples where a normal approximation
 * would produce bounds outside [0,1].
 */
export function wilson95(successes: number, trials: number): { low: number; high: number } | null {
  if (trials <= 0 || successes < 0 || successes > trials) return null;
  const n = trials;
  const p = successes / n;
  const denom = 1 + (WILSON_Z * WILSON_Z) / n;
  const centre = p + (WILSON_Z * WILSON_Z) / (2 * n);
  const margin = WILSON_Z * Math.sqrt((p * (1 - p)) / n + (WILSON_Z * WILSON_Z) / (4 * n * n));
  const round = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 10000) / 10000;
  return { low: round((centre - margin) / denom), high: round((centre + margin) / denom) };
}

async function scalar(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const r = await pool.query(sql, params);
  return Number(r.rows[0]?.n ?? 0);
}

/** Schema capability probe: a missing column is unavailable, never zero. */
async function hasColumn(pool: Pool, table: string, column: string): Promise<boolean> {
  const r = await pool.query(
    `select 1 from information_schema.columns
      where table_schema = 'public' and table_name = $1 and column_name = $2`,
    [table, column],
  );
  return r.rows.length > 0;
}

/**
 * adapter_id -> source_key, from the real adapter manifests.
 *
 * `discovery_run.query_text` is the query or board token, NOT a source key —
 * matching on it fabricated associations. `adapter_id` is the recorded
 * identity of the adapter that ran; its manifest names the source it collects
 * from. Adapters that declare no explicit sourceKey fall back to the run
 * module's documented default, and anything unknown is reported as
 * unattributed rather than guessed.
 */
export function adapterSourceMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const id of getProductionRegistry().ids()) {
    const m = getProductionRegistry().get(id).manifest();
    map.set(id, m.sourceKey ?? DEFAULT_RUN_SOURCE_KEY);
  }
  return map;
}

export async function buildPilotReport(pool: Pool): Promise<PilotReport> {
  const reasons: string[] = [];
  const blockers: { code: string; message: string }[] = [];

  const companies = await scalar(pool, "select count(*)::int n from public.company");
  const canonical = await scalar(pool, "select count(*)::int n from public.company where merged_into is null");
  const merged = companies - canonical;
  const snapshots = await scalar(pool, "select count(*)::int n from public.snapshot");
  const claims = await scalar(pool, "select count(*)::int n from public.claim");
  const distinctCompaniesWithEvidence = await scalar(
    pool, "select count(distinct company_id)::int n from public.snapshot",
  );
  const unresolvedIdentities = await scalar(
    pool, "select count(*)::int n from public.identity_conflict where status = 'pending'",
  ) + (await scalar(pool, "select count(*)::int n from public.match_candidate where status = 'pending'"));
  const withUrl = await scalar(
    pool, "select count(*)::int n from public.snapshot where url is not null and url <> ''",
  );
  const withObserved = await scalar(
    pool, "select count(*)::int n from public.snapshot where observed_at is not null",
  );

  const hasPublishedAt = await hasColumn(pool, "claim", "published_at");
  const withPublished = hasPublishedAt
    ? await scalar(pool, "select count(*)::int n from public.claim where published_at is not null")
    : null;
  const supersededRecords = await scalar(
    pool, `select count(*)::int n from public.discovery_record where note like 'sha256:%'`,
  );

  // ---- B2: approved for review, from real qualification semantics ----------
  //
  // Meaning (documented, not invented): a case whose LATEST recorded decision
  // is 'accepted' AND whose latest assessment was produced under the CURRENTLY
  // ACTIVE policy version. An `assessed` case status is a workflow state and is
  // NOT a verdict; suppressed/rejected/archived cases are not approvals; and a
  // later withdrawal/rejection supersedes an earlier acceptance.
  const activePolicy = await pool.query(
    "select version from p2.reference_version where kind = 'policy' and status = 'active' order by recorded_at desc limit 1",
  );
  const activePolicyVersion = (activePolicy.rows[0]?.version as string) ?? null;

  let approvedForReview: PilotReport["approvedForReview"];
  if (activePolicyVersion === null) {
    approvedForReview = {
      value: null,
      activePolicyVersion: null,
      detail:
        "UNAVAILABLE, not zero: assessment is refused with 409 no_active_reference because no " +
        "policy is published and approved. No case can have been assessed under an active " +
        "policy, so an approval count cannot exist yet.",
    };
    reasons.push("No active scoring policy: approved-for-review cannot be computed.");
    blockers.push({
      code: "no_active_policy",
      message:
        "Assessment is refused (409 no_active_reference). Ranking, gates and approval " +
        "counts are unavailable until an owner-approved policy is published.",
    });
  } else {
    // Suppression is exposed on the frozen qualification view as
    // suppression_reason (derived from existing state only). A suppressed case
    // is never counted as approved for review.
    const approved = await scalar(
      pool,
      `with latest_decision as (
           select distinct on (case_id) case_id, decision
             from p2.case_decision order by case_id, decided_at desc, decision_id desc
         ),
       latest_assessment as (
           select distinct on (case_id) case_id, policy_version
             from p2.case_assessment order by case_id, decided_at desc, assessment_id desc
       )
       select count(*)::int n
         from p2.case k
         join latest_decision d on d.case_id = k.case_id
         join latest_assessment a on a.case_id = k.case_id
         left join public.opportunity o on o.opportunity_key = k.discovery_opportunity_key
         left join v_opportunity_for_qualification_v1 v
                on v.opportunity_key = k.discovery_opportunity_key
        where d.decision = 'accepted'
          and a.policy_version = $1
          and k.status = 'assessed'
          and o.status not in ('rejected', 'archived', 'stale', 'ineligible')
          and v.suppression_reason is null`,
      [activePolicyVersion],
    );
    approvedForReview = {
      value: approved,
      activePolicyVersion,
      detail:
        `Cases whose latest decision is 'accepted', whose latest assessment used the ` +
        `active policy '${activePolicyVersion}', and whose case state is 'assessed'. ` +
        `Suppressed, rejected and archived cases are excluded, and an ` +
        `assessed state alone is never counted.`,
    };
  }

  // ---- B3: freshness, from defined populations and defined dates ----------
  const obsMedian = await pool.query(
    `select percentile_cont(0.5) within group (order by extract(epoch from (now() - observed_at)) / 86400.0) as m,
            count(*)::int n
       from public.snapshot
      where observed_at is not null and observed_at <= now()`,
  );
  const ingMedian = await pool.query(
    `select percentile_cont(0.5) within group (order by extract(epoch from (now() - fetched_at)) / 86400.0) as m,
            count(*)::int n
       from public.snapshot
      where fetched_at is not null and fetched_at <= now()`,
  );
  const pubMedian = hasPublishedAt
    ? await pool.query(
        `select percentile_cont(0.5) within group (order by extract(epoch from (now() - published_at)) / 86400.0) as m,
                count(*)::int n
           from public.claim
          where published_at is not null and published_at <= now()`,
      )
    : { rows: [{ m: null, n: 0 }] };

  // Per-source publication medians (claims inherit the source via their
  // snapshot). Collected before `num` is defined; only raw values are kept.
  const perSourcePubRows = hasPublishedAt
    ? await pool.query(
        `select s.source_key,
                percentile_cont(0.5) within group (order by extract(epoch from (now() - cl.published_at)) / 86400.0) as m,
                count(*)::int n
           from public.claim cl join public.snapshot s on s.id = cl.snapshot_id
          where cl.published_at is not null and cl.published_at <= now()
          group by s.source_key`,
      )
    : { rows: [] as Record<string, unknown>[] };
  const perSourcePub = new Map<string, { m: unknown; n: number }>(
    (perSourcePubRows.rows as Record<string, unknown>[]).map((r) => [
      String(r.source_key),
      { m: r.m, n: Number(r.n ?? 0) },
    ]),
  );
  const num = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(Number(v).toFixed(1));

  // Per-source freshness: populations must not be mixed across sources.
// Grouped on the snapshot's OWN source_key — joining snapshots to
// discovery_record on source_key would be a cartesian product, and would also
// drop sources that only ever produced manual observations (no discovery_record
// row exists for those). Each median is filtered to its own valid date column,
// so a missing date is excluded rather than counted as zero.
const perSourceFresh = await pool.query(
  `select s.source_key,
          percentile_cont(0.5) within group (
            order by extract(epoch from (now() - s.observed_at)) / 86400.0
          ) filter (where s.observed_at is not null and s.observed_at <= now()) as obs_m,
          count(s.observed_at) filter (where s.observed_at <= now())::int as obs_n,
          percentile_cont(0.5) within group (
            order by extract(epoch from (now() - s.fetched_at)) / 86400.0
          ) filter (where s.fetched_at is not null and s.fetched_at <= now()) as ing_m,
          count(s.fetched_at) filter (where s.fetched_at <= now())::int as ing_n
     from public.snapshot s
    group by s.source_key order by s.source_key`,
);
  const perSource: PilotReport["freshness"]["perSource"] = (
    perSourceFresh.rows as Record<string, unknown>[]
  ).map((r) => {
    const key = String(r.source_key);
    const pub = perSourcePub.get(key) ?? { m: null, n: 0 };
    return {
      sourceKey: key,
      observationMedian: num(r.obs_m),
      observationSample: Number(r.obs_n ?? 0),
      ingestionMedian: num(r.ing_m),
      ingestionSample: Number(r.ing_n ?? 0),
      publicationMedian: num(pub.m),
      publicationSample: pub.n,
    };
  });

  const freshness: PilotReport["freshness"] = {
    medianObservationAgeDays: num(obsMedian.rows[0]?.m),
    observationSample: Number(obsMedian.rows[0]?.n ?? 0),
    medianIngestionAgeDays: num(ingMedian.rows[0]?.m),
    ingestionSample: Number(ingMedian.rows[0]?.n ?? 0),
    medianPublicationAgeDays: num(pubMedian.rows[0]?.m),
    publicationSample: Number(pubMedian.rows[0]?.n ?? 0),
    perSource,
  };

  // ---- B4: precision from human correctness labels ------------------------
  const hasReviewTable = await hasColumn(pool, "source_record_review", "label");
  let perSourcePrecision: SourcePrecision[] = [];
  let precision: PilotReport["precision"] = {
    value: null,
    reviewedRecords: 0,
    ci95: null,
    basis: hasReviewTable
      ? "No human review labels recorded yet."
      : "UNAVAILABLE: this database predates migration 20261016120001_source_record_review.",
    standard: { requiredRecords: PILOT_REVIEW_STANDARD, requiredRuns: PILOT_REVIEW_RUN_STANDARD, met: false },
  };

  if (hasReviewTable) {
    // One label per (source, record): where a record was reviewed more than
    // once, the LATEST label wins, so repeat review cannot inflate the sample.
    const latest = await pool.query(
      `with latest as (
         select distinct on (source_key, source_record_id)
                source_key, source_record_id, label, run_id
           from public.source_record_review
          order by source_key, source_record_id, reviewed_at desc, id desc
       )
       select source_key,
              count(*)::int as reviewed,
              count(*) filter (where label = 'correct')::int as correct,
              count(*) filter (where label = 'incorrect')::int as incorrect,
              count(*) filter (where label = 'unusable')::int as unusable,
              count(distinct run_id)::int as runs
         from latest group by source_key order by source_key`,
    );
    perSourcePrecision = perSourcePrecisionFromRows(latest.rows as Record<string, unknown>[]);
    const tot = perSourcePrecision.reduce(
      (a, s) => ({
        reviewed: a.reviewed + s.reviewedRecords,
        correct: a.correct + s.labelledCorrect,
        incorrect: a.incorrect + s.labelledIncorrect,
        unusable: a.unusable + s.labelledUnusable,
        runs: a.runs + s.distinctRuns,
      }),
      { reviewed: 0, correct: 0, incorrect: 0, unusable: 0, runs: 0 },
    );
    const denom = tot.correct + tot.incorrect;
    precision = {
      value: tot.reviewed >= MIN_SAMPLE_FOR_PRECISION && denom > 0
        ? Number(((tot.correct / denom) * 100).toFixed(1))
        : null,
      reviewedRecords: tot.reviewed,
      ci95: denom > 0 ? wilson95(tot.correct, denom) : null,
      basis:
        tot.reviewed === 0
          ? "No human review labels recorded. Unreviewed records are never assumed correct."
          : `${tot.correct} correct / ${tot.incorrect} incorrect (denominator excludes ` +
            `${tot.unusable} labelled unusable). Below the ${MIN_SAMPLE_FOR_PRECISION}-record ` +
            `minimum, so no precision figure is published.`,
      standard: {
        requiredRecords: PILOT_REVIEW_STANDARD,
        requiredRuns: PILOT_REVIEW_RUN_STANDARD,
        met: tot.reviewed >= PILOT_REVIEW_STANDARD && tot.runs >= PILOT_REVIEW_RUN_STANDARD,
      },
    };
    if (tot.reviewed === 0)
      blockers.push({
        code: "no_reviewed_labels",
        message:
          "No human review labels recorded. Precision is unmeasurable and is reported as " +
          "unavailable; qualification decisions are not a substitute for review labels.",
      });
    if (tot.reviewed < PILOT_REVIEW_STANDARD)
      reasons.push(
        `Only ${tot.reviewed} reviewed record(s); the owner-agreed pilot standard is ` +
          `${PILOT_REVIEW_STANDARD} records across ${PILOT_REVIEW_RUN_STANDARD} runs.`,
      );
  } else {
    reasons.push(
      "Database predates migration 20261016120001_source_record_review: precision is unavailable.",
    );
    blockers.push({
      code: "review_labels_unavailable",
      message:
        "No human review-label table in this database. Precision cannot be computed and is " +
        "reported as unavailable; apply migration 20261016120001_source_record_review.",
    });
  }

  // ---- B1: source health via adapter_id, never via query_text -------------
  const sourceMap = adapterSourceMap();
  const runsByAdapter = await pool.query(
    `select adapter_id,
            count(*)::int as runs,
            max(started_at) as last_run_at
       from public.discovery_run group by adapter_id`,
  );
  const runRows = runsByAdapter.rows as Record<string, unknown>[];
  const latestStatusBySource = new Map<string, { status: string; at: string }>();
  const unattributed = new Map<string, number>();
  for (const r of runRows) {
    const sourceKey = sourceMap.get(r.adapter_id as string);
    if (!sourceKey) {
      unattributed.set(r.adapter_id as string, (unattributed.get(r.adapter_id as string) ?? 0) + Number(r.runs));
      continue;
    }
    const at = String(r.last_run_at);
    const prev = latestStatusBySource.get(sourceKey);
    if (!prev || prev.at < at) {
      const s = await pool.query(
        "select status from public.discovery_run where adapter_id = $1 order by started_at desc limit 1",
        [r.adapter_id],
      );
      latestStatusBySource.set(sourceKey, { status: String(s.rows[0]?.status ?? "unknown"), at });
    }
  }

  const sourcesRes = await pool.query(
    `select s.key, s.platform, s.enabled,
            (select count(*)::int from public.discovery_record d where d.source_key = s.key) as records,
            (select count(distinct d.company_id)::int from public.discovery_record d where d.source_key = s.key) as companies
       from public.source s order by s.kind, s.key`,
  );
  const sourceHealth = (sourcesRes.rows as Record<string, unknown>[]).map((r) => {
    const key = r.key as string;
    const run = latestStatusBySource.get(key);
    return {
      key,
      platform: r.platform as string,
      enabled: r.enabled as boolean,
      records: r.records as number,
      companies: r.companies as number,
      lastRunAt: run?.at ?? null,
      lastRunStatus: run?.status ?? null,
      lastRunBasis: run
        ? "resolved from discovery_run.adapter_id via the adapter manifest's sourceKey"
        : "unavailable: no run recorded for an adapter mapped to this source",
    };
  });

  // ---- run accounting -----------------------------------------------------
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
      { label: "Distinct companies carrying evidence", count: distinctCompaniesWithEvidence },
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
        caveat: "Counts ingestion, not qualification quality.",
      },
      {
        key: "unresolved_identities",
        label: "Unresolved identities",
        value: unresolvedIdentities,
        denominator: canonical,
        share: share(unresolvedIdentities, canonical),
        definition: "Open identity conflicts plus pending duplicate candidates awaiting human review.",
        caveat: "Zero here means 'none raised', not 'identity resolution is correct'.",
      },
      {
        key: "signals_with_dates",
        label: "Claims carrying a source publication date",
        value: withPublished,
        denominator: claims,
        share: share(withPublished, claims),
        definition: "Claims where the SOURCE stated a publication/event date (claim.published_at).",
        caveat:
          withPublished === null
            ? "UNAVAILABLE: this database predates migration 20261016100001_claim_published_at. Apply the migration; the count is not zero, it is unmeasurable."
            : "Absence means the source did not state one. It is never back-filled with ingestion time.",
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
        definition: "Snapshots where the operator or source stated when the event was observed.",
        caveat: "Distinct from publication date and from ingestion time.",
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
    ],
    approvedForReview,
    freshness,
    precision,
    perSourcePrecision,
    sourceHealth,
    unattributedRuns: {
      adapterIds: [...unattributed.entries()].map(([k, v]) => `${k} (${v})`),
      runs: [...unattributed.values()].reduce((a, b) => a + b, 0),
    },
    blockers,
  };
}

/** Exported for direct unit testing of the label aggregation. */
export function perSourcePrecisionFromRows(rows: Record<string, unknown>[]): SourcePrecision[] {
  return rows.map((r) => {
    const correct = Number(r.correct ?? 0);
    const incorrect = Number(r.incorrect ?? 0);
    const unusable = Number(r.unusable ?? 0);
    const reviewed = Number(r.reviewed ?? 0);
    const runs = Number(r.runs ?? 0);
    const denom = correct + incorrect;
    return {
      sourceKey: String(r.source_key),
      reviewedRecords: reviewed,
      labelledCorrect: correct,
      labelledIncorrect: incorrect,
      labelledUnusable: unusable,
      distinctRuns: runs,
      precision: denom > 0 ? Number(((correct / denom) * 100).toFixed(1)) : null,
      ci95: wilson95(correct, denom),
      meetsPilotStandard: reviewed >= PILOT_REVIEW_STANDARD && runs >= PILOT_REVIEW_RUN_STANDARD,
      note:
        denom === 0
          ? "No correctness denominator yet (labels are unusable-only or absent)."
          : `precision = ${correct} / (${correct} + ${incorrect}); ${unusable} unusable excluded`,
    };
  });
}