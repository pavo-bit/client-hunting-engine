// Evidence governance (Part 2, §5).
//
// Phase 2 consumes Discovery's stored evidence and NEVER refetches: there is
// no network path in this module (asserted by test — no fetch, no child
// processes), page content stays untrusted data, and URL handling refuses
// anything but http(s) without control characters. Nothing here rewrites
// Discovery's source history; assessment snapshots copy the facts needed for
// historical reconstruction.
//
// Rules enforced (each with a test):
//   - same announcement twice is not corroboration (duplicate detection by
//     normalized text hash within a source, and across sources sharing an
//     independence group);
//   - an unapproved source cannot influence scoring (excluded from inputs,
//     listed transparently — fail closed);
//   - approved low-confidence (grade C) sources are labelled on the item;
//   - missing / unavailable / negative / contradicting are distinct states;
//   - negative findings record what/where/when/how (refused otherwise);
//   - contradictions are represented with their links, never silently dropped;
//   - entity ambiguity (open identity conflict) overrides match confidence;
//   - expired evidence (expires_at passed, or its snapshot suppressed) is
//     excluded with a reason, never silently current.

import { createHash } from "crypto";
import type { Pool, PoolClient } from "pg";

export interface EvidenceError {
  status: number;
  code: string;
  message: string;
}

const fail = (status: number, code: string, message: string): EvidenceError => ({
  status,
  code,
  message,
});

/**
 * Deterministic claim normalization: trim, lowercase, collapse all
 * whitespace. Two records with the same normalized text are the same
 * announcement for duplicate purposes, regardless of casing or spacing.
 */
export function normalizeClaimText(raw: unknown): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

/** Untrusted-URL gate (same pattern as the opportunity detail page): http(s) only, no control chars. */
export function safeSourceUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().slice(0, 2000);
  if (/^https?:\/\//i.test(v) && !/[\r\n]/.test(v)) return v;
  return null;
}

export type EntityConfidence = "registry" | "domain" | "name_only" | "ambiguous";
export type Freshness = "current" | "stale" | "expired";

export interface EvidenceItem {
  claimId: string;
  snapshotId: string;
  normalizedText: string;
  textHash: string;
  sourceKey: string | null;
  sourceUrl: string | null;
  trustGrade: string;
  approved: boolean;
  lowConfidence: boolean;
  publishedAt: string | null;
  retrievedAt: string | null;
  entityConfidence: EntityConfidence;
  entityBasis: string;
  evidenceType: string | null;
  signalFamily: string | null;
  independenceGroup: string;
  polarity: "supports" | "contradicts" | "contextual";
  verificationState: string;
  needsReview: boolean;
  freshness: Freshness;
  ageDays: number | null;
  scopeLimitations: string | null;
  snapshotHash: string | null;
  contradictingClaimIds: string[];
}

export interface EvidenceBundle {
  companyId: string;
  asOf: string;
  items: EvidenceItem[];
  /** Usable scoring inputs: approved, current-or-stale, unambiguous-source. */
  usable: EvidenceItem[];
  duplicates: { keptClaimId: string; droppedClaimId: string; reason: string }[];
  unapproved: { claimId: string; sourceKey: string | null; reason: string }[];
  expired: { claimId: string; reason: string }[];
  ambiguousEntity: boolean;
  bundleHash: string;
}

export interface BundleOptions {
  asOf: string;
  /** Explicit predicate -> signal-family map (policy-owned). Unmapped predicates stay null. */
  signalMap?: Record<string, string>;
  /** Default fresh threshold in days when no family rule matches. */
  freshnessDefaultDays?: number;
  /** Per-family {freshDays, staleDays} rules (service/catalog-owned). */
  freshnessRules?: Record<string, { freshDays: number; staleDays: number }>;
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

export function bundleHashOf(items: Pick<EvidenceItem, "claimId" | "textHash">[]): string {
  const canonical = [...items]
    .map((i) => `${i.claimId}:${i.textHash}`)
    .sort()
    .join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Build the evidence bundle for one company from STORED rows only.
 * Pure reads; never writes, never fetches.
 */
export async function buildEvidenceBundle(
  db: Pool | PoolClient,
  companyId: string,
  opts: BundleOptions,
): Promise<EvidenceBundle> {
  const asOf = new Date(opts.asOf);
  if (Number.isNaN(asOf.getTime())) throw fail(422, "bad_as_of", "asOf must be an ISO timestamp");
  const co = await db.query(
    "select id, domain_norm, registry_id, country_code from public.company where id = $1",
    [companyId],
  );
  if (co.rows.length === 0) throw fail(404, "company_not_found", "company not found");
  const company = co.rows[0] as {
    domain_norm: string | null;
    registry_id: string | null;
    country_code: string | null;
  };

  const conflicts = await db.query(
    "select id from public.identity_conflict where company_id = $1 and status = 'pending' limit 1",
    [companyId],
  );
  const ambiguousEntity = conflicts.rows.length > 0;

  const trust = await db.query(
    "select source_key, trust_grade, approved_for_scoring, independence_group from p2.source_trust",
  );
  const trustBySource = new Map(
    (trust.rows as { source_key: string; trust_grade: string; approved_for_scoring: boolean; independence_group: string }[]).map(
      (t) => [t.source_key, t],
    ),
  );

  const claims = await db.query(
    `select cl.id, cl.snapshot_id, cl.claim_text, cl.claim_status, cl.predicate,
            cl.observed_at, cl.expires_at, cl.created_at, cl.needs_review,
            s.url as snapshot_url, s.source_key as snapshot_source, s.sha256 as snapshot_hash,
            s.fetched_at as snapshot_fetched, s.suppressed as snapshot_suppressed
     from public.claim cl
     join public.snapshot s on s.id = cl.snapshot_id
     where cl.company_id = $1
     order by cl.created_at, cl.id`,
    [companyId],
  );
  const links = await db.query(
    // Polarity lives on hypothesis_evidence (a claim linked under a
    // hypothesis of the same company), NOT on claim_evidence (which links
    // claims to claims/snapshots). Querying the wrong table would silently
    // report every claim as contextual and hide contradictions.
    `select he.claim_id, he.polarity from public.hypothesis_evidence he
     join public.hypothesis h on h.id = he.hypothesis_id
     where h.company_id = $1`,
    [companyId],
  );
  const polarityByClaim = new Map<string, string>();
  for (const l of links.rows as { claim_id: string; polarity: string }[]) {
    const prev = polarityByClaim.get(l.claim_id);
    if (l.polarity === "contradicts") polarityByClaim.set(l.claim_id, "contradicts");
    else if (!prev) polarityByClaim.set(l.claim_id, l.polarity);
  }
  const contradictedBy = new Map<string, string[]>();
  for (const l of links.rows as { claim_id: string; polarity: string }[]) {
    if (l.polarity !== "contradicts") continue;
    // A contradicts-link marks its own claim as contested context. The
    // hypothesis it was raised under is available in history; the bundle
    // records that contest exists, never a verdict on it.
    contradictedBy.set(l.claim_id, [...(contradictedBy.get(l.claim_id) ?? []), l.claim_id]);
  }

  const items: EvidenceItem[] = [];
  const expired: EvidenceBundle["expired"] = [];
  for (const c of claims.rows as Record<string, unknown>[]) {
    const claimId = c.id as string;
    const normalizedText = normalizeClaimText(c.claim_text);
    const sourceKey = (c.snapshot_source as string | null) ?? null;
    const t = sourceKey ? trustBySource.get(sourceKey) : undefined;
    const approved = t?.approved_for_scoring === true;
    const observedAt = c.observed_at ? new Date(c.observed_at as string) : null;
    const retrievedAt = c.snapshot_fetched ? new Date(c.snapshot_fetched as string) : null;
    const reference = observedAt ?? retrievedAt ?? (c.created_at ? new Date(c.created_at as string) : null);
    const ageDays = reference ? daysBetween(reference, asOf) : null;
    const isExpired =
      (c.expires_at ? new Date(c.expires_at as string) <= asOf : false) ||
      (c.snapshot_suppressed as boolean) === true;
    if (isExpired) {
      expired.push({
        claimId,
        reason:
          (c.snapshot_suppressed as boolean) === true
            ? "snapshot suppressed — claim excluded, not current"
            : `expires_at ${(c.expires_at as string)} passed as of ${opts.asOf}`,
      });
      continue;
    }
    const predicate = (c.predicate as string | null) ?? null;
    const family = predicate ? (opts.signalMap?.[predicate] ?? null) : null;
    const rule = family ? opts.freshnessRules?.[family] : undefined;
    const freshDays = rule?.freshDays ?? opts.freshnessDefaultDays ?? 90;
    const freshness: Freshness = ageDays === null || ageDays <= freshDays ? "current" : "stale";
    let entityConfidence: EntityConfidence;
    let entityBasis: string;
    if (ambiguousEntity) {
      entityConfidence = "ambiguous";
      entityBasis = "open identity conflict for this company — match unverified";
    } else if (company.registry_id && company.country_code) {
      entityConfidence = "registry";
      entityBasis = `registry ${company.registry_id} / ${company.country_code}`;
    } else if (company.domain_norm) {
      entityConfidence = "domain";
      entityBasis = `canonical domain ${company.domain_norm}`;
    } else {
      entityConfidence = "name_only";
      entityBasis = "name only — no registry id or domain";
    }
    items.push({
      claimId,
      snapshotId: c.snapshot_id as string,
      normalizedText,
      textHash: createHash("sha256").update(normalizedText, "utf8").digest("hex"),
      sourceKey,
      sourceUrl: safeSourceUrl(c.snapshot_url),
      trustGrade: t?.trust_grade ?? "unregistered",
      approved,
      lowConfidence: approved && t?.trust_grade === "C",
      publishedAt: observedAt?.toISOString() ?? null,
      retrievedAt: retrievedAt?.toISOString() ?? null,
      entityConfidence,
      entityBasis,
      evidenceType: predicate,
      signalFamily: family,
      independenceGroup: t?.independence_group ?? sourceKey ?? "unknown-source",
      polarity: (polarityByClaim.get(claimId) === "contradicts"
        ? "contradicts"
        : polarityByClaim.get(claimId) === "supports"
          ? "supports"
          : "contextual") as EvidenceItem["polarity"],
      verificationState: c.claim_status as string,
      needsReview: (c.needs_review as boolean) === true,
      freshness,
      ageDays,
      scopeLimitations: (c.needs_review as boolean) === true ? "flagged for review" : null,
      snapshotHash: (c.snapshot_hash as string | null) ?? null,
      contradictingClaimIds: contradictedBy.get(claimId) ?? [],
    });
  }

  // Duplicate collapse (single pass): the first occurrence per source and per
  // independence group wins. Same text + same source = re-ingest; same text
  // across sources in one independence group = the same underlying
  // announcement, not independent corroboration. Unapproved survivors are
  // listed, never scored.
  const usable: EvidenceItem[] = [];
  const duplicates: EvidenceBundle["duplicates"] = [];
  const unapproved: EvidenceBundle["unapproved"] = [];
  const byText = new Map<string, EvidenceItem[]>();
  for (const item of items) {
    const group = byText.get(item.textHash) ?? [];
    group.push(item);
    byText.set(item.textHash, group);
  }
  for (const group of byText.values()) {
    const ordered = [...group].sort((a, b) =>
      (a.retrievedAt ?? "").localeCompare(b.retrievedAt ?? ""),
    );
    for (const [idx, item] of ordered.entries()) {
      const priorSource = ordered.slice(0, idx).find((o) => o.sourceKey === item.sourceKey);
      const priorGroup =
        !priorSource &&
        ordered.slice(0, idx).find((o) => o.independenceGroup === item.independenceGroup);
      if (priorSource) {
        duplicates.push({ keptClaimId: priorSource.claimId, droppedClaimId: item.claimId, reason: "duplicate_same_source" });
        continue;
      }
      if (priorGroup) {
        duplicates.push({
          keptClaimId: priorGroup.claimId,
          droppedClaimId: item.claimId,
          reason: "duplicate_same_announcement",
        });
        continue;
      }
      if (!item.approved) {
        unapproved.push({
          claimId: item.claimId,
          sourceKey: item.sourceKey,
          reason: `source '${item.sourceKey ?? "unknown"}' is not approved for scoring — excluded, not defaulted`,
        });
        continue;
      }
      usable.push(item);
    }
  }

  return {
    companyId,
    asOf: opts.asOf,
    items,
    usable,
    duplicates,
    unapproved,
    expired,
    ambiguousEntity,
    bundleHash: bundleHashOf(items),
  };
}

export interface NegativeFindingInput {
  caseId: string;
  snapshotId: string;
  question: string;
  searchedWhere: string;
  searchedAt: string;
  method: string;
  actor: string;
}

/**
 * Record a negative finding: a search that found nothing IS evidence, but
 * only when what/where/when/how are all stated. Anything less is absence of
 * evidence and is refused — it must never silently discount a hypothesis.
 */
export async function recordNegativeFinding(
  db: Pool | PoolClient,
  input: NegativeFindingInput,
): Promise<{ findingId: string }> {
  for (const [k, v] of [
    ["question", input.question],
    ["searchedWhere", input.searchedWhere],
    ["method", input.method],
  ] as const) {
    if (!(v ?? "").trim()) throw fail(422, "incomplete_negative_finding", `${k} is required: a negative finding must record what was searched, where, when and how`);
  }
  const searchedAt = new Date(input.searchedAt);
  if (Number.isNaN(searchedAt.getTime())) throw fail(422, "bad_searched_at", "searchedAt must be an ISO timestamp");
  if (!(input.actor ?? "").trim()) throw fail(422, "actor_required", "acting operator identity is required");
  const kase = await db.query("select case_id from p2.case where case_id = $1", [input.caseId]);
  if (kase.rows.length === 0) throw fail(404, "case_not_found", "qualification case not found");
  const snap = await db.query(
    "select snapshot_id from p2.case_snapshot where snapshot_id = $1 and case_id = $2",
    [input.snapshotId, input.caseId],
  );
  if (snap.rows.length === 0) throw fail(422, "unknown_snapshot", "snapshot does not belong to this case");
  const r = await db.query(
    `insert into p2.negative_finding
       (case_id, snapshot_id, question, searched_where, searched_at, method, actor)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning finding_id`,
    [
      input.caseId,
      input.snapshotId,
      input.question.trim().slice(0, 2000),
      input.searchedWhere.trim().slice(0, 2000),
      searchedAt.toISOString(),
      input.method.trim().slice(0, 2000),
      input.actor.trim().slice(0, 200),
    ],
  );
  return { findingId: r.rows[0].finding_id as string };
}
