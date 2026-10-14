// MILESTONE 2 (S-2): learning reports over manually recorded outcomes
// (FR-025, closes the reporting half of T-013).
//
// Read-only aggregates with explicit numerators and denominators. Sparse data
// is a first-class result: any rate with a denominator below MIN_DENOM is
// reported as `rate: null, lowData: true` ("insufficient data") instead of a
// misleading percentage. NOTHING here tunes weights or thresholds — reports
// inform recorded human decisions only (no automatic changes in MVP).
// All queries are parameterized and bounded; no schema change was needed.

import type { Pool } from "pg";

/** Denominators below this yield "insufficient data" instead of a rate. */
export const MIN_DENOM = 5;

/** Outcomes that count as a reply (human responded in any form). */
const REPLIED = ["replied", "positive_response", "meeting", "discovery_meeting", "proposal", "won"];
/** Outcomes that count as a win. */
const WON = ["won"];

export interface RateCell {
  n: number;
  denom: number;
  /** Null when denom < MIN_DENOM: insufficient data, never a guess. */
  rate: number | null;
  lowData: boolean;
}

export function cell(n: number, denom: number): RateCell {
  const lowData = denom < MIN_DENOM;
  return { n, denom, rate: lowData || denom === 0 ? null : n / denom, lowData };
}

export interface OutcomeOverview {
  total: number;
  byOutcome: { outcome: string; n: number }[];
  reply: RateCell;
  win: RateCell;
}

export async function outcomeOverview(pool: Pool): Promise<OutcomeOverview> {
  const rows = await pool.query<{ outcome: string; n: string }>(
    `select outcome, count(*) as n from public.outcome_log group by outcome order by outcome`,
  );
  const byOutcome = rows.rows.map((r) => ({ outcome: r.outcome, n: Number(r.n) }));
  const total = byOutcome.reduce((a, b) => a + b.n, 0);
  const has = (list: string[]) => byOutcome.filter((b) => list.includes(b.outcome)).reduce((a, b) => a + b.n, 0);
  return { total, byOutcome, reply: cell(has(REPLIED), total), win: cell(has(WON), total) };
}

export interface SegmentRate {
  key: string;
  outcomes: number;
  reply: RateCell;
  win: RateCell;
}

async function groupedRates(
  pool: Pool,
  groupSql: string,
): Promise<SegmentRate[]> {
  // One row per outcome with its grouping key; rates computed in code so the
  // replied/won definitions stay in exactly one place.
  const rows = await pool.query<{ key: string; outcome: string; n: string }>(groupSql);
  const map = new Map<string, { total: number; replied: number; won: number }>();
  for (const r of rows.rows) {
    const key = r.key ?? "unspecified";
    const e = map.get(key) ?? { total: 0, replied: 0, won: 0 };
    const n = Number(r.n);
    e.total += n;
    if (REPLIED.includes(r.outcome)) e.replied += n;
    if (WON.includes(r.outcome)) e.won += n;
    map.set(key, e);
  }
  return [...map.entries()]
    .map(([key, e]) => ({ key, outcomes: e.total, reply: cell(e.replied, e.total), win: cell(e.won, e.total) }))
    .sort((a, b) => b.outcomes - a.outcomes || (a.key < b.key ? -1 : 1));
}

/** Reply/win rates by agency type (the worldwide segment's own vocabulary). */
export function ratesBySegment(pool: Pool): Promise<SegmentRate[]> {
  return groupedRates(
    pool,
    `select c.agency_type as key, o.outcome, count(*) as n
     from public.outcome_log o
     join public.brief b on b.ref = o.brief_ref
     join public.company c on c.id = b.company_id
     group by c.agency_type, o.outcome`,
  );
}

/** Reply/win rates by outreach channel. */
export function ratesByChannel(pool: Pool): Promise<SegmentRate[]> {
  return groupedRates(
    pool,
    `select coalesce(o.channel, 'unspecified') as key, o.outcome, count(*) as n
     from public.outcome_log o group by coalesce(o.channel, 'unspecified'), o.outcome`,
  );
}

/** Reply/win rates by hypothesis opportunity category. */
export function ratesByHypothesisCategory(pool: Pool): Promise<SegmentRate[]> {
  return groupedRates(
    pool,
    `select h.opportunity_category as key, o.outcome, count(*) as n
     from public.outcome_log o
     join public.brief b on b.ref = o.brief_ref
     join public.hypothesis h on h.id = b.hypothesis_id
     group by h.opportunity_category, o.outcome`,
  );
}

/**
 * Reply/win rates by contributing source. A brief aggregates many sources, so
 * a brief counts ONCE per source that contributed evidence to its hypothesis
 * (documented approximation, not per-source attribution of the outcome).
 */
export function ratesBySource(pool: Pool): Promise<SegmentRate[]> {
  return groupedRates(
    pool,
    `select s.source_key as key, o.outcome, count(*) as n
     from public.outcome_log o
     join public.brief b on b.ref = o.brief_ref
     join public.hypothesis_evidence he on he.hypothesis_id = b.hypothesis_id
     join public.claim cl on cl.id = he.claim_id
     join public.snapshot s on s.id = cl.snapshot_id
     group by s.source_key, o.outcome`,
  );
}

export interface RejectionRow {
  code: string;
  n: number;
  /** Share of lost outcomes carrying this code (null when no lost outcomes). */
  share: number | null;
}

/** Top rejection reasons among lost outcomes, ranked by count. */
export async function topRejections(pool: Pool, limit = 10): Promise<{ total: number; lost: number; rows: RejectionRow[] }> {
  const lim = Math.min(Math.max(limit, 1), 50);
  const total = await pool.query<{ n: string }>(`select count(*) as n from public.outcome_log`);
  const lost = await pool.query<{ n: string }>(
    `select count(*) as n from public.outcome_log where outcome = 'lost'`,
  );
  const lostN = Number(lost.rows[0].n);
  const rows = await pool.query<{ code: string; n: string }>(
    `select coalesce(rejection_code, 'unspecified') as code, count(*) as n
     from public.outcome_log where outcome = 'lost'
     group by coalesce(rejection_code, 'unspecified')
     order by count(*) desc, coalesce(rejection_code, 'unspecified') asc
     limit $1`,
    [lim],
  );
  return {
    total: Number(total.rows[0].n),
    lost: lostN,
    rows: rows.rows.map((r) => ({
      code: r.code,
      n: Number(r.n),
      share: lostN === 0 ? null : Number(r.n) / lostN,
    })),
  };
}

export interface EvidenceHealth {
  claims: number;
  expired: number;
  disputed: number;
  withdrawn: number;
  superseded: number;
  assumed: number;
  approvedBriefs: number;
}

/** Evidence-ledger health: terminal/expired shares, never a verdict. */
export async function evidenceHealth(pool: Pool): Promise<EvidenceHealth> {
  const r = await pool.query<{
    claims: string;
    expired: string;
    disputed: string;
    withdrawn: string;
    superseded: string;
    assumed: string;
  }>(
    `select count(*) as claims,
            count(*) filter (where expires_at is not null and expires_at < now()) as expired,
            count(*) filter (where claim_status = 'disputed') as disputed,
            count(*) filter (where claim_status = 'withdrawn') as withdrawn,
            count(*) filter (where claim_status = 'superseded') as superseded,
            count(*) filter (where claim_status = 'assumed') as assumed
     from public.claim`,
  );
  const b = await pool.query<{ n: string }>(
    `select count(*) as n from public.brief where status = 'approved'`,
  );
  const row = r.rows[0];
  return {
    claims: Number(row.claims),
    expired: Number(row.expired),
    disputed: Number(row.disputed),
    withdrawn: Number(row.withdrawn),
    superseded: Number(row.superseded),
    assumed: Number(row.assumed),
    approvedBriefs: Number(b.rows[0].n),
  };
}

export interface LearningReport {
  overview: OutcomeOverview;
  bySegment: SegmentRate[];
  byChannel: SegmentRate[];
  byCategory: SegmentRate[];
  bySource: SegmentRate[];
  rejections: { total: number; lost: number; rows: RejectionRow[] };
  health: EvidenceHealth;
}

export async function learningReport(pool: Pool): Promise<LearningReport> {
  const [overview, bySegment, byChannel, byCategory, bySource, rejections, health] = await Promise.all([
    outcomeOverview(pool),
    ratesBySegment(pool),
    ratesByChannel(pool),
    ratesByHypothesisCategory(pool),
    ratesBySource(pool),
    topRejections(pool),
    evidenceHealth(pool),
  ]);
  return { overview, bySegment, byChannel, byCategory, bySource, rejections, health };
}
