// Unified operator review queue (T-012).
//
// This module is a READ-MODEL PROJECTION, not a source of truth. There is no
// queue table and no queue-owned state: every item is derived from live domain
// state at read time, and an item leaves the queue because the domain record
// changed — never because the queue marked it done. The queue performs NO
// writes; `tests/review.test.ts` asserts audit-log invariance across reads.
//
// Design rules enforced here:
//   * Domain services own every transition. The queue only links (href) to
//     them, so validation + audit behaviour is preserved by construction.
//   * Staleness is never stored. Brief/proposal staleness is delegated to the
//     existing domain helpers (`getBriefWorkspace`, `getProposalDetail`) and
//     score staleness mirrors `rankedOpportunities`' documented conditions.
//   * Scores NEVER set queue priority. An approved artifact with an invalid
//     basis is `blocking` regardless of how well it scored; a top-scoring
//     opportunity blocked by unresolved identity evidence is also `blocking`.
//   * Approval states are never reset by staleness — the item is flagged and
//     re-surfaced, the underlying record keeps its status.
//   * Private outreach bodies and operator notes are never loaded into a queue
//     item (only brief ref, channel, version and unverified-point counts).

import type { Pool } from "pg";
import { getBriefWorkspace } from "@/lib/sales/briefs";
import { getProposalDetail } from "@/lib/proposal/proposals";

export type QueueDomain =
  | "identity"
  | "evidence"
  | "hypothesis"
  | "proposal"
  | "brief"
  | "draft"
  | "catalog"
  | "gates"
  | "stale";

export type QueuePriority = "blocking" | "high" | "normal" | "low" | "informational";

export interface QueueItem {
  /** Stable, deterministic identity: `<domain>:<type>:<recordId>`. */
  key: string;
  domain: QueueDomain;
  type: string;
  recordId: string;
  companyId: string | null;
  companyName: string | null;
  title: string;
  /** Why the item needs attention, in plain language. */
  why: string;
  /** Current domain status, verbatim from the owning workflow. */
  status: string;
  priority: QueuePriority;
  createdAt: string;
  updatedAt: string;
  stale: boolean;
  /** Deep link to the authoritative domain record. */
  href: string;
}

export interface QueueFilters {
  domain?: string;
  priority?: string;
  company?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface QueueResult {
  items: QueueItem[];
  total: number;
  /** True when at least one source could not be read; items are still complete. */
  partial: boolean;
  failedSources: string[];
  limit: number;
  offset: number;
}

export const QUEUE_PRIORITIES: QueuePriority[] = [
  "blocking",
  "high",
  "normal",
  "low",
  "informational",
];

export const QUEUE_DOMAINS: QueueDomain[] = [
  "identity",
  "evidence",
  "hypothesis",
  "proposal",
  "brief",
  "draft",
  "catalog",
  "gates",
  "stale",
];

const PRIORITY_RANK: Record<QueuePriority, number> = {
  blocking: 0,
  high: 1,
  normal: 2,
  low: 3,
  informational: 4,
};

export const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
/** Per-source SQL bounds. Prevents unbounded scans on a local tool. */
const SOURCE_LIMIT = 200;
/** Heavier freshness checks (N+1 domain helpers) run over a smaller set. */
const FRESHNESS_LIMIT = 50;
const EPOCH = new Date(0).toISOString();

/**
 * Normalize a pg timestamp to an ISO string. `pg` hands back `Date` objects for
 * timestamptz/timestamp/date columns; leaking them into React server
 * components crashes the render, so every timestamp is serialized HERE, at the
 * data layer, and nowhere else. Unknown/absent times collapse to EPOCH.
 */
function iso(v: unknown): string {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : EPOCH;
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number") return new Date(v).toISOString();
  return EPOCH;
}

export type QueuePart = {
  domain: QueueDomain;
  run: (pool: Pool) => Promise<QueueItem[]>;
};

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

/** 1. Identity conflicts / duplicate candidates awaiting a human decision. */
async function identityPart(pool: Pool): Promise<QueueItem[]> {
  const r = await pool.query(
    `select m.id, m.rule, m.conflicting_registry, m.created_at,
            a.id as aid, a.name as aname, b.name as bname
     from public.match_candidate m
     join public.company a on a.id = m.company_a
     join public.company b on b.id = m.company_b
     where m.status = 'pending'
       and a.merged_into is null and b.merged_into is null
     order by m.created_at desc, m.id asc
     limit $1`,
    [SOURCE_LIMIT],
  );
  return r.rows.map((row) => ({
    key: `identity:candidate:${row.id}`,
    domain: "identity" as QueueDomain,
    type: "duplicate-candidate",
    recordId: row.id as string,
    companyId: row.aid as string,
    companyName: row.aname as string,
    title: `Possible duplicate: ${row.aname} / ${row.bname}`,
    why: row.conflicting_registry
      ? `Conflicting registry evidence (${row.rule}) blocks automatic merging — a human accept/reject decision is required.`
      : `Deterministic ${row.rule} match awaiting human accept/reject/defer.`,
    status: "pending",
    priority: (row.conflicting_registry ? "blocking" : "high") as QueuePriority,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.created_at),
    stale: false,
    href: "/resolve",
  }));
}

/**
 * 2. Claims awaiting assessment: flagged, disputed, or backed by expired
 * evidence. Expired-but-otherwise-fine claims are flagged stale (the claim
 * status is NOT rewritten here).
 */
async function evidencePart(pool: Pool): Promise<QueueItem[]> {
  const r = await pool.query(
    `select c.id, c.claim_text, c.claim_status, c.needs_review, c.created_at,
            c.company_id, co.name as company_name,
            (c.expires_at is not null and c.expires_at < now()) as expired
     from public.claim c join public.company co on co.id = c.company_id
     where c.needs_review = true
        or c.claim_status = 'disputed'
        or (c.expires_at is not null and c.expires_at < now())
     order by c.created_at desc, c.id asc
     limit $1`,
    [SOURCE_LIMIT],
  );
  return r.rows.map((row) => {
    const expired = row.expired as boolean;
    const disputed = row.claim_status === "disputed";
    const flagged = row.needs_review as boolean;
    return {
      key: `evidence:claim:${row.id}`,
      domain: "evidence" as QueueDomain,
      type: disputed ? "claim-disputed" : expired ? "claim-expired" : "claim-flagged",
      recordId: row.id as string,
      companyId: row.company_id as string,
      companyName: row.company_name as string,
      title: `Claim ${row.claim_status}: ${String(row.claim_text).slice(0, 90)}`,
      why: disputed
        ? "Disputed claim — the contradiction must be resolved before it can support anything."
        : expired
          ? "Supporting evidence has expired — refresh the observation or withdraw the claim."
          : "Flagged for human review.",
      status: row.claim_status as string,
      priority: (disputed || expired ? "high" : "normal") as QueuePriority,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.created_at),
      stale: expired,
      href: `/evidence/${row.id}`,
    };
  });
}

/**
 * 3. Hypotheses requiring review or further evidence.
 * `generated` is deliberately NOT here — it is surfaced by the gates source
 * (it is a ranking gate failure, not a review request), which keeps the two
 * sources non-overlapping. `deferred` is informational: a human already
 * parked it deliberately.
 */
async function hypothesisPart(pool: Pool): Promise<QueueItem[]> {
  const r = await pool.query(
    `select h.id, h.title, h.status, h.rule_id, h.created_at, h.updated_at,
            h.company_id, c.name as company_name
     from public.hypothesis h join public.company c on c.id = h.company_id
     where h.status in ('needs_review', 'deferred')
     order by h.created_at desc, h.id asc
     limit $1`,
    [SOURCE_LIMIT],
  );
  return r.rows.map((row) => ({
    key: `hypothesis:review:${row.id}`,
    domain: "hypothesis" as QueueDomain,
    type: row.status === "needs_review" ? "hypothesis-review" : "hypothesis-deferred",
    recordId: row.id as string,
    companyId: row.company_id as string,
    companyName: row.company_name as string,
    title: `Hypothesis ${row.status}: ${row.title}`,
    why:
      row.status === "needs_review"
        ? `Contradictions or limits require a human decision (validate / defer / reject / request evidence).`
        : "An operator explicitly deferred this — parked until new evidence arrives, not urgent work.",
    status: row.status as string,
    priority: (row.status === "needs_review" ? "high" : "informational") as QueuePriority,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at ?? row.created_at),
    stale: false,
    href: `/hypotheses/${row.id}`,
  }));
}

/** 4. Project proposals awaiting review or additional information. */
async function proposalPart(pool: Pool): Promise<QueueItem[]> {
  const r = await pool.query(
    `select p.id, p.title, p.status, p.version, p.created_at,
            h.company_id, c.name as company_name
     from public.project_option p
     join public.hypothesis h on h.id = p.hypothesis_id
     join public.company c on c.id = h.company_id
     where p.status in ('draft', 'in_review', 'needs_info')
     order by p.created_at desc, p.id asc
     limit $1`,
    [SOURCE_LIMIT],
  );
  const out: QueueItem[] = [];
  for (const row of r.rows) {
    // Freshness is delegated to the domain helper — never re-derived here.
    const needsFreshness = row.status === "in_review" || row.status === "needs_info";
    const detail = needsFreshness ? await getProposalDetail(pool, row.id as string) : null;
    const stale = detail?.stale ?? false;
    out.push({
      key: `proposal:review:${row.id}`,
      domain: "proposal" as QueueDomain,
      type: "proposal-review",
      recordId: row.id as string,
      companyId: row.company_id as string,
      companyName: row.company_name as string,
      title: `Proposal v${row.version} ${row.status}: ${row.title}`,
      why: stale
        ? `Awaiting decision, and its basis changed (${detail?.staleReasons.join("; ")}).`
        : row.status === "in_review"
          ? "Awaiting reviewer decision (accept / reject / archive)."
          : row.status === "needs_info"
            ? "Waiting on information the reviewer requested."
            : "Draft not yet submitted for review.",
      status: row.status as string,
      priority: (row.status === "in_review" ? "high" : row.status === "needs_info" ? "normal" : "low") as QueuePriority,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.created_at),
      stale,
      href: `/proposals/${row.id}`,
    });
  }
  return out;
}

/** 5. Opportunity briefs requiring approval or reassessment. */
async function briefPart(pool: Pool): Promise<QueueItem[]> {
  const r = await pool.query(
    `select b.ref, b.status, b.created_at, b.updated_at,
            b.company_id, c.name as company_name
     from public.brief b join public.company c on c.id = b.company_id
     where b.status in ('draft', 'in_review', 'needs_info')
     order by b.created_at desc, b.ref asc
     limit $1`,
    [SOURCE_LIMIT],
  );
  const out: QueueItem[] = [];
  for (const row of r.rows) {
    let stale = false;
    if (row.status === "in_review" || row.status === "needs_info") {
      const w = await getBriefWorkspace(pool, row.ref as string);
      stale = w?.stale ?? false;
    }
    out.push({
      key: `brief:review:${row.ref}`,
      domain: "brief" as QueueDomain,
      type: "brief-review",
      recordId: row.ref as string,
      companyId: row.company_id as string,
      companyName: row.company_name as string,
      title: `Brief ${row.ref} (${row.status})`,
      why:
        row.status === "in_review"
          ? "Awaiting reviewer decision (approve / reject / request info)."
          : row.status === "needs_info"
            ? "Waiting on information the reviewer requested."
            : "Draft not yet submitted for review.",
      status: row.status as string,
      priority: (row.status === "in_review" ? "high" : row.status === "needs_info" ? "normal" : "low") as QueuePriority,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at ?? row.created_at),
      stale,
      href: `/briefs/${row.ref}`,
    });
  }
  return out;
}

/**
 * 6. Outreach drafts blocked by unverified assertions or awaiting approval.
 * Bodies are never loaded — only brief ref, channel, version and the presence
 * of unverified points, so private outreach content never lands in the queue.
 */
async function draftPart(pool: Pool): Promise<QueueItem[]> {
  const r = await pool.query(
    `select od.id, od.channel, od.status, od.version, od.unverified_points, od.created_at,
            b.ref as brief_ref, c.id as company_id, c.name as company_name
     from public.outreach_draft od
     join public.brief b on b.ref = od.brief_ref
     join public.company c on c.id = b.company_id
     where od.status in ('draft', 'in_review')
     order by od.created_at desc, od.id asc
     limit $1`,
    [SOURCE_LIMIT],
  );
  return r.rows.map((row) => {
    const blocked = Boolean(row.unverified_points);
    return {
      key: `draft:review:${row.id}`,
      domain: "draft" as QueueDomain,
      type: blocked ? "draft-blocked" : "draft-review",
      recordId: row.id as string,
      companyId: row.company_id as string,
      companyName: row.company_name as string,
      title: `Draft v${row.version} (${row.channel}) for ${row.brief_ref} — ${row.status}`,
      why: blocked
        ? "Approval is blocked: unverified assertions must be resolved (or removed) in the brief first."
        : row.status === "in_review"
          ? "Awaiting approval. Approval never sends anything — a human sends it manually."
          : "Draft not yet submitted for approval.",
      status: row.status as string,
      priority: (blocked ? "high" : row.status === "in_review" ? "normal" : "low") as QueuePriority,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.created_at),
      stale: false,
      href: `/briefs/${row.brief_ref}`,
    };
  });
}

/** 7. Service-catalog entries still awaiting an owner decision (D-004/D-005). */
async function catalogPart(pool: Pool): Promise<QueueItem[]> {
  const r = await pool.query(
    `select key, name, status, created_at from public.capability
     where status in ('draft', 'needs_owner_review')
     order by created_at desc, key asc
     limit $1`,
    [SOURCE_LIMIT],
  );
  return r.rows.map((row) => ({
    key: `catalog:approval:${row.key}`,
    domain: "catalog" as QueueDomain,
    type: "catalog-approval",
    recordId: row.key as string,
    companyId: null,
    companyName: null,
    title: `Catalog entry needs owner decision: ${row.name}`,
    why: "Unapproved entries must never be presented as confirmed offerings; only the owner may approve.",
    status: row.status as string,
    priority: "normal" as QueuePriority,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.created_at),
    stale: false,
    href: "/catalog",
  }));
}

/**
 * 8. Opportunities excluded from ranking by a hard gate that a human action can
 * resolve: unreviewed (`generated`) hypotheses, and companies whose identity is
 * still unresolved (which blocks ranking for every opportunity of that
 * company — hence keyed per company, not per hypothesis).
 */
async function gatesPart(pool: Pool): Promise<QueueItem[]> {
  const r = await pool.query(
    `select h.id, h.title, h.company_id, h.created_at, c.name as company_name
     from public.hypothesis h
     join public.company c on c.id = h.company_id
     where h.status = 'generated' and c.merged_into is null
     order by h.created_at desc, h.id asc
     limit $1`,
    [SOURCE_LIMIT],
  );
  const out: QueueItem[] = r.rows.map((row) => ({
    key: `gates:unreviewed:${row.id}`,
    domain: "gates" as QueueDomain,
    type: "gate-unreviewed",
    recordId: row.id as string,
    companyId: row.company_id as string,
    companyName: row.company_name as string,
    title: `Excluded from ranking (never reviewed): ${row.title}`,
    why: "A generated hypothesis is an insufficient-evidence state: it cannot rank until a human reviews it. Reviewing it here unblocks scoring.",
    status: "generated",
    priority: "high" as QueuePriority,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.created_at),
    stale: false,
    href: `/hypotheses/${row.id}`,
  }));

  const blocked = await pool.query(
    `select c.id as company_id, c.name as company_name,
            min(m.created_at) as open_since
     from public.match_candidate m
     join public.company c on c.id = m.company_a or c.id = m.company_b
     where m.status = 'pending' and c.merged_into is null
     group by c.id, c.name
     order by min(m.created_at) desc, c.id asc
     limit $1`,
    [SOURCE_LIMIT],
  );
  for (const row of blocked.rows) {
    out.push({
      key: `gates:identity:${row.company_id}`,
      domain: "gates" as QueueDomain,
      type: "gate-identity-block",
      recordId: row.company_id as string,
      companyId: row.company_id as string,
      companyName: row.company_name as string,
      title: `Ranking blocked for ${row.company_name}: unresolved identity`,
      why: "A pending identity candidate fails the identity-clear gate, so no opportunity of this company can be scored or ranked until it is decided.",
      status: "identity-open",
      priority: "blocking" as QueuePriority,
      createdAt: iso(row.open_since),
      updatedAt: iso(row.open_since),
      stale: false,
      href: "/resolve",
    });
  }
  return out;
}

/**
 * 9. Stale decided artifacts. An approved brief or accepted proposal whose
 * basis changed keeps its approved status — the queue flags the drift and
 * demands re-review; it never rewrites or silently resets the approval.
 * Staleness reasons come from the domain helpers, so queue and workflow agree.
 */
async function stalePart(pool: Pool): Promise<QueueItem[]> {
  const out: QueueItem[] = [];

  const briefs = await pool.query(
    `select b.ref, b.status, b.created_at, b.updated_at,
            b.company_id, c.name as company_name
     from public.brief b join public.company c on c.id = b.company_id
     where b.status = 'approved'
     order by b.created_at desc, b.ref asc
     limit $1`,
    [FRESHNESS_LIMIT],
  );
  for (const row of briefs.rows) {
    const w = await getBriefWorkspace(pool, row.ref as string);
    if (!w || !w.stale) continue;
    out.push({
      key: `stale:brief:${row.ref}`,
      domain: "stale" as QueueDomain,
      type: "stale-approved-brief",
      recordId: row.ref as string,
      companyId: row.company_id as string,
      companyName: row.company_name as string,
      title: `Approved brief is stale: ${row.ref}`,
      why: `Basis changed (${w.staleReasons.join("; ")}). The brief is still ${row.status}; it must be re-reviewed before it is relied on.`,
      status: row.status as string,
      priority: "blocking" as QueuePriority,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at ?? row.created_at),
      stale: true,
      href: `/briefs/${row.ref}`,
    });
  }

  const proposals = await pool.query(
    `select p.id, p.status, p.created_at, h.company_id, c.name as company_name
     from public.project_option p
     join public.hypothesis h on h.id = p.hypothesis_id
     join public.company c on c.id = h.company_id
     where p.status = 'accepted'
     order by p.created_at desc, p.id asc
     limit $1`,
    [FRESHNESS_LIMIT],
  );
  for (const row of proposals.rows) {
    const d = await getProposalDetail(pool, row.id as string);
    if (!d || !d.stale) continue;
    out.push({
      key: `stale:proposal:${row.id}`,
      domain: "stale" as QueueDomain,
      type: "stale-accepted-proposal",
      recordId: row.id as string,
      companyId: row.company_id as string,
      companyName: row.company_name as string,
      title: `Accepted proposal is stale: ${String(d.proposal["title"] ?? "(untitled)")}`,
      why: `Basis changed (${d.staleReasons.join("; ")}). The proposal is still ${row.status}; re-review before acting on it.`,
      status: row.status as string,
      priority: "blocking" as QueuePriority,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.created_at),
      stale: true,
      href: `/proposals/${row.id}`,
    });
  }

  // Stale scores: same two documented conditions as `rankedOpportunities`
  // (evidence linked after evaluation, or claim/hypothesis activity after it).
  const scores = await pool.query(
    `select distinct on (s.hypothesis_id) s.hypothesis_id, s.evaluated_at, s.total,
            h.company_id, h.title, c.name as company_name,
            (select max(he.created_at) from public.hypothesis_evidence he
             where he.hypothesis_id = s.hypothesis_id) as last_ev,
            (select max(a.created_at) from public.audit_log a
             join public.hypothesis_evidence he2 on he2.claim_id::text = a.entity_id
             where a.entity_type in ('claim', 'hypothesis') and he2.hypothesis_id = s.hypothesis_id) as last_act
     from public.score_run s
     join public.hypothesis h on h.id = s.hypothesis_id
     join public.company c on c.id = h.company_id
     where s.model_version = 'score_v1'
     order by s.hypothesis_id, s.evaluated_at desc
     limit $1`,
    [SOURCE_LIMIT],
  );
  for (const row of scores.rows) {
    const reasons: string[] = [];
    if (row.last_ev && new Date(iso(row.last_ev)) > new Date(iso(row.evaluated_at)))
      reasons.push("evidence linked after evaluation");
    if (row.last_act && new Date(iso(row.last_act)) > new Date(iso(row.evaluated_at)))
      reasons.push("claim/hypothesis activity after evaluation");
    if (reasons.length === 0) continue;
    out.push({
      key: `stale:score:${row.hypothesis_id}`,
      domain: "stale" as QueueDomain,
      type: "stale-score",
      recordId: row.hypothesis_id as string,
      companyId: row.company_id as string,
      companyName: row.company_name as string,
      title: `Score is stale: ${row.title}`,
      why: `Re-evaluate through the scoring workflow (${reasons.join("; ")}). The stored score is kept as-is; score_v1 weights remain PROVISIONAL (D-006).`,
      status: "scored",
      priority: "high" as QueuePriority,
      createdAt: iso(row.evaluated_at),
      updatedAt: iso(row.evaluated_at),
      stale: true,
      href: `/scores`,
    });
  }

  return out;
}

export const QUEUE_PARTS: QueuePart[] = [
  { domain: "identity", run: identityPart },
  { domain: "evidence", run: evidencePart },
  { domain: "hypothesis", run: hypothesisPart },
  { domain: "proposal", run: proposalPart },
  { domain: "brief", run: briefPart },
  { domain: "draft", run: draftPart },
  { domain: "catalog", run: catalogPart },
  { domain: "gates", run: gatesPart },
  { domain: "stale", run: stalePart },
];

/* ------------------------------------------------------------------ */
/* Assembly                                                           */
/* ------------------------------------------------------------------ */

function fail(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Assemble the queue.
 *
 * Sources are isolated: an unreadable source yields a PARTIAL result that names
 * it, never a failed page. Ordering is deterministic: priority rank, then
 * oldest `updatedAt` first (anti-starvation), then key ascending.
 */
export async function getReviewQueue(
  pool: Pool,
  filters: QueueFilters = {},
  parts: QueuePart[] = QUEUE_PARTS,
): Promise<QueueResult> {
  const rawLimit = filters.limit ?? DEFAULT_LIMIT;
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : DEFAULT_LIMIT, 1), MAX_LIMIT);
  const rawOffset = filters.offset ?? 0;
  const offset = Math.max(Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : 0, 0);

  const domain = (filters.domain ?? "").trim();
  if (domain !== "" && !QUEUE_DOMAINS.includes(domain as QueueDomain))
    throw fail(422, "bad_domain", `unknown queue domain: ${domain}`);
  const priority = (filters.priority ?? "").trim();
  if (priority !== "" && !QUEUE_PRIORITIES.includes(priority as QueuePriority))
    throw fail(422, "bad_priority", `unknown queue priority: ${priority}`);

  // Bounded substring matching — no full-text index exists in this schema.
  const company = (filters.company ?? "").trim().slice(0, 200).toLowerCase();
  const q = (filters.q ?? "").trim().slice(0, 200).toLowerCase();

  let items: QueueItem[] = [];
  const failedSources: string[] = [];
  for (const part of parts) {
    if (domain !== "" && part.domain !== domain) continue;
    try {
      items.push(...(await part.run(pool)));
    } catch {
      // Never surface the raw driver error (may contain SQL/identifiers).
      failedSources.push(part.domain);
    }
  }

  if (company !== "")
    items = items.filter((i) => (i.companyName ?? "").toLowerCase().includes(company));
  if (q !== "")
    items = items.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        i.why.toLowerCase().includes(q) ||
        (i.companyName ?? "").toLowerCase().includes(q),
    );
  if (priority !== "") items = items.filter((i) => i.priority === priority);

  // Deduplication by stable key. Sources are written to be unique by
  // construction; this is defence in depth (e.g. a source added twice).
  const seen = new Set<string>();
  items = items.filter((i) => {
    if (seen.has(i.key)) return false;
    seen.add(i.key);
    return true;
  });

  items.sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  const total = items.length;
  return {
    items: items.slice(offset, offset + limit),
    total,
    partial: failedSources.length > 0,
    failedSources,
    limit,
    offset,
  };
}