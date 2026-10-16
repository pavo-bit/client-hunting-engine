// Agency detail aggregate for /agencies/[id] (T-004). Read-only.

import type { Pool } from "pg";

export interface CompanyDetail {
  company: {
    id: string;
    name: string;
    domain_norm: string | null;
    registry_id: string | null;
    registry_type: string | null;
    agency_type: string;
    country: string;
    country_code: string | null;
    region: string | null;
    website_url: string | null;
    discovery_status: string;
    merged_into: string | null;
    merged_into_name: string | null;
    created_at: string;
  };
  aliases: { alias_type: string; alias_value: string; verification: string; country_code: string | null }[];
  discovery: {
    source_key: string | null;
    platform: string | null;
    collection_method: string;
    retrieval_status: string;
    retrieved_at: string;
  }[];
  candidates: {
    id: string;
    rule: string;
    detail: string;
    conflicting_registry: boolean;
    status: string;
    other_id: string;
    other_name: string;
  }[];
  absorbed: { id: string; name: string }[];
  claims: {
    id: string;
    claim_text: string;
    claim_status: string;
    predicate: string | null;
    /** Source publication/event date; null when the source stated none. */
    published_at: string | null;
    /** When the observation was seen; distinct from ingestion time. */
    observed_at: string | null;
    source_key: string | null;
    source_url: string | null;
    fetched_at: string | null;
    stale: boolean;
  }[];
  hypotheses: { id: string; title: string; status: string; rule_id: string | null }[];
  proposals: { id: string; title: string; status: string; version: number }[];
  audit: {
    actor: string;
    transition_from: string | null;
    transition_to: string | null;
    reason: string | null;
    created_at: string;
  }[];
}

export async function getCompanyDetail(
  pool: Pool,
  id: string,
): Promise<CompanyDetail | null> {
  const poolConn = await pool.connect();
  try {
    const c = await poolConn.query(
      `select c.*, w.name as merged_into_name
       from public.company c left join public.company w on w.id = c.merged_into
       where c.id = $1`,
      [id],
    );
    if (c.rows.length === 0) return null;
    const company = c.rows[0];
    const [aliases, discovery, candidates, absorbed, audit, claims, hypotheses, proposals] = await Promise.all([
      poolConn.query(
        `select alias_type, alias_value, verification, country_code
         from public.company_alias
         where canonical_company_id = $1 order by alias_type, alias_value`,
        [id],
      ),
      poolConn.query(
        `select d.source_key, s.platform, d.collection_method,
                d.retrieval_status, d.retrieved_at
         from public.discovery_record d
         left join public.source s on s.key = d.source_key
         where d.company_id = $1 order by d.retrieved_at desc limit 100`,
        [id],
      ),
      poolConn.query(
        `select m.id, m.rule, m.detail, m.conflicting_registry, m.status,
                case when m.company_a = $1 then m.company_b else m.company_a end as other_id,
                case when m.company_a = $1 then b.name else a.name end as other_name
         from public.match_candidate m
         join public.company a on a.id = m.company_a
         join public.company b on b.id = m.company_b
         where m.company_a = $1 or m.company_b = $1
         order by m.created_at desc limit 100`,
        [id],
      ),
      poolConn.query(
        `select id, name from public.company where merged_into = $1 order by created_at`,
        [id],
      ),
      poolConn.query(
        `select actor, transition_from, transition_to, reason, created_at
         from public.audit_log
         where entity_type = 'company' and entity_id = $1
         order by created_at desc limit 100`,
        [id],
      ),
      poolConn.query(
        // Source attribution travels with the claim: an operator must be able
        // to see WHICH source asserted it and WHEN, without opening the
        // evidence page. published_at is the source's own date and stays NULL
        // when the source stated none; observed_at is when it was seen.
        `select c.id, c.claim_text, c.claim_status, c.predicate,
                c.published_at, c.observed_at,
                s.source_key, s.url as source_url, s.fetched_at,
                (c.expires_at is not null and c.expires_at < now()) as stale
           from public.claim c
           left join public.snapshot s on s.id = c.snapshot_id
          where c.company_id = $1 order by c.created_at desc limit 100`,
        [id],
      ),
      poolConn.query(
        `select id, title, status, rule_id from public.hypothesis
         where company_id = $1 order by created_at desc limit 100`,
        [id],
      ),
      poolConn.query(
        `select p.id, p.title, p.status, p.version
         from public.project_option p join public.hypothesis h on h.id = p.hypothesis_id
         where h.company_id = $1 order by p.created_at desc limit 100`,
        [id],
      ),
    ]);
    return {
      company: {
        id: company.id,
        name: company.name,
        domain_norm: company.domain_norm,
        registry_id: company.registry_id,
        registry_type: company.registry_type,
        agency_type: company.agency_type,
        country: company.country,
        country_code: company.country_code,
        region: company.region,
        website_url: company.website_url,
        discovery_status: company.discovery_status,
        merged_into: company.merged_into,
        merged_into_name: company.merged_into_name,
        created_at: company.created_at,
      },
      aliases: aliases.rows,
      discovery: discovery.rows,
      candidates: candidates.rows,
      absorbed: absorbed.rows,
      audit: audit.rows,
      claims: claims.rows,
      hypotheses: hypotheses.rows,
      proposals: proposals.rows,
    };
  } finally {
    poolConn.release();
  }
}
