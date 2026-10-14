// Claim detail aggregate for review UI (T-007). Read-only.

import type { Pool } from "pg";
import { independentOrigins, recommend } from "./assessment";

export interface ClaimDetail {
  claim: {
    id: string;
    company_id: string;
    company_name: string;
    claim_text: string;
    claim_status: string;
    predicate: string | null;
    source_reliability: string;
    info_credibility: number;
    observed_at: string | null;
    expires_at: string | null;
    stale: boolean;
    needs_review: boolean;
    created_at: string;
  };
  origin: {
    snapshot_id: string;
    source_key: string;
    url: string;
    fetched_at: string;
    sha256: string;
    retention_class: string;
    suppressed: boolean;
    excerpt: string | null;
  } | null;
  supporting: {
    id: string;
    polarity: string;
    note: string | null;
    snapshot_id: string | null;
    linked_claim_id: string | null;
    origin_key: string | null;
  }[];
  contradicting: {
    id: string;
    polarity: string;
    note: string | null;
    snapshot_id: string | null;
    linked_claim_id: string | null;
    origin_key: string | null;
  }[];
  assessments: {
    from_status: string | null;
    to_status: string;
    rationale: string;
    actor: string;
    automatic: boolean;
    created_at: string;
  }[];
  recommendation: {
    recommended: string | null;
    eligibleVerified: boolean;
    reasons: string[];
  };
}

export async function getClaimDetail(pool: Pool, id: string): Promise<ClaimDetail | null> {
  const client = await pool.connect();
  try {
    const c = await client.query(
      `select c.*, co.name as company_name,
              (c.expires_at is not null and c.expires_at < now()) as stale
       from public.claim c join public.company co on co.id = c.company_id
       where c.id = $1`,
      [id],
    );
    if (c.rows.length === 0) return null;
    const claim = c.rows[0];
    const s = await client.query(
      `select s.id as snapshot_id, s.source_key, s.url, s.fetched_at,
              s.sha256, s.retention_class, s.suppressed, s.content_excerpt as excerpt
       from public.snapshot s where s.id = $1`,
      [claim.snapshot_id],
    );
    const links = (
      await client.query(
        `select e.id, e.polarity, e.note, e.snapshot_id, e.linked_claim_id,
                coalesce(ss.source_key, cs.source_key) as origin_key
         from public.claim_evidence e
         left join public.snapshot ss on ss.id = e.snapshot_id
         left join public.claim lc on lc.id = e.linked_claim_id
         left join public.snapshot cs on cs.id = lc.snapshot_id
         where e.claim_id = $1 order by e.created_at`,
        [id],
      )
    ).rows;
    const assessments = (
      await client.query(
        `select from_status, to_status, rationale, actor, automatic, created_at
         from public.claim_assessment where claim_id = $1 order by created_at`,
        [id],
      )
    ).rows;
    const origins = independentOrigins(
      links
        .filter((l) => l.polarity === "supports")
        .map((l) => ({ source_key: l.origin_key ?? "unknown", snapshot_url: "" })),
    );
    // NOTE: origin identity for corroboration uses source keys; URL hosts
    // would refine this when snapshots carry distinct URLs per evidence item.
    const contradictCount = links.filter((l) => l.polarity === "contradicts").length;
    const recommendation = recommend(claim.claim_status, origins, contradictCount);
    return {
      claim: {
        id: claim.id,
        company_id: claim.company_id,
        company_name: claim.company_name,
        claim_text: claim.claim_text,
        claim_status: claim.claim_status,
        predicate: claim.predicate,
        source_reliability: claim.source_reliability,
        info_credibility: claim.info_credibility,
        observed_at: claim.observed_at,
        expires_at: claim.expires_at,
        stale: claim.stale,
        needs_review: claim.needs_review,
        created_at: claim.created_at,
      },
      origin: s.rows[0] ?? null,
      supporting: links.filter((l) => l.polarity === "supports"),
      contradicting: links.filter((l) => l.polarity === "contradicts"),
      assessments,
      recommendation: {
        recommended: recommendation.recommended,
        eligibleVerified: recommendation.eligibleVerified,
        reasons: recommendation.reasons,
      },
    };
  } finally {
    client.release();
  }
}
