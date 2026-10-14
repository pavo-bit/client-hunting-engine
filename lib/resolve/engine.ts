// Deterministic identity resolution engine (T-004).
//
// PRECEDENCE (first match wins for candidate rule; auto-merge is narrower):
//   1. registry_scoped — same country_code (both present) + same registry_id.
//   2. domain_exact   — same normalized domain_norm.
//   3. alias          — identifier matches a verified company_alias.
//   4. name_exact     — same normalized name (review ONLY, never auto).
//
// AUTO-MERGE (inside an explicit resolution run only — never inside intake):
//   domain_exact with NO registry conflict, older record wins (stable id).
// Everything else, and any conflicting-registry pair, goes to the human queue.
// Conflicting registry = both IDs present + different + jurisdictions not
// provably different (equal or unknown country codes).

import type { Pool, PoolClient } from "pg";
import { normalizeName } from "./names";
import { isSharedHost } from "./hosts";

export type CandidateRule =
  | "domain_exact"
  | "registry_scoped"
  | "alias"
  | "name_exact";

export interface CandidateFound {
  id: string;
  companyA: string;
  companyB: string;
  rule: CandidateRule;
  detail: string;
  conflictingRegistry: boolean;
  status: string;
}

export interface ResolveResult {
  companyId: string;
  skipped: string | null;
  candidates: CandidateFound[];
  autoMerged: { loser: string; winner: string; summary: string }[];
}

export interface IntakeError {
  status: number;
  code: string;
  message: string;
}

const fail = (status: number, code: string, message: string): IntakeError => ({
  status,
  code,
  message,
});

interface CompanyLite {
  id: string;
  name: string;
  domain_norm: string | null;
  registry_id: string | null;
  registry_type: string | null;
  country_code: string | null;
  merged_into: string | null;
  created_at: string;
}

/**
 * Auto-merge gate (pure): domain-exact, conflict-free, still pending.
 * Kept separate so the rule is unit-testable; defense-in-depth note: exact
 * identifier duplicates cannot arise through current intake (canonical
 * uniques), so this path covers direct/legacy writes. Execution is covered
 * by merge/decision integration tests.
 */
export function shouldAutoMerge(cand: {
  rule: CandidateRule;
  conflictingRegistry: boolean;
  status: string;
}): boolean {
  return (
    cand.rule === "domain_exact" &&
    !cand.conflictingRegistry &&
    cand.status === "pending"
  );
}

/**
 * Registry rule predicate (pure, unit-tested): same id + same stated
 * jurisdiction + type agreement. Reachability note: canonical uniques
 * prevent such pairs from coexisting through current intake, so the intake
 * rejection below is the live guarantee and this predicate is
 * defense-in-depth for direct/legacy writes and future review-queue designs.
 */
export function registryRuleMatch(a: CompanyLite, b: CompanyLite): boolean {
  return Boolean(
    a.registry_id &&
      b.registry_id &&
      a.registry_id === b.registry_id &&
      a.country_code &&
      b.country_code &&
      a.country_code === b.country_code &&
      registryTypeAgrees(a, b),
  );
}

export function registryTypeAgrees(a: CompanyLite, b: CompanyLite): boolean {
  if (!a.registry_type || !b.registry_type) return true;
  return a.registry_type === b.registry_type;
}

/** Same registry number claimed under incompatible type assertions. */
export function registryTypeConflict(a: CompanyLite, b: CompanyLite): boolean {
  if (!a.registry_id || !b.registry_id) return false;
  if (a.registry_id !== b.registry_id) return false;
  if (!a.registry_type || !b.registry_type) return false;
  if (a.registry_type === b.registry_type) return false;
  if (a.country_code && b.country_code && a.country_code !== b.country_code)
    return false;
  return true;
}

export function registryConflict(a: CompanyLite, b: CompanyLite): boolean {
  if (!a.registry_id || !b.registry_id) return false;
  if (a.registry_id === b.registry_id) return false;
  if (a.country_code && b.country_code && a.country_code !== b.country_code)
    return false; // different jurisdictions: unrelated identifiers
  return true;
}

async function loadCompany(
  client: PoolClient,
  id: string,
): Promise<CompanyLite | null> {
  const r = await client.query(
    `select id, name, domain_norm, registry_id, registry_type, country_code, merged_into, created_at
     from public.company where id = $1`,
    [id],
  );
  return (r.rows[0] as CompanyLite | undefined) ?? null;
}

async function upsertCandidate(
  client: PoolClient,
  a: string,
  b: string,
  rule: CandidateRule,
  detail: string,
  conflictingRegistry: boolean,
): Promise<CandidateFound> {
  const [ca, cb] = a < b ? [a, b] : [b, a];
  try {
    const r = await client.query(
      `insert into public.match_candidate
         (company_a, company_b, rule, detail, conflicting_registry)
       values ($1, $2, $3, $4, $5)
       on conflict (least(company_a, company_b), greatest(company_a, company_b), rule)
       do nothing
       returning id, status`,
      [ca, cb, rule, detail, conflictingRegistry],
    );
    if (r.rows.length > 0) {
      return {
        id: r.rows[0].id,
        companyA: ca,
        companyB: cb,
        rule,
        detail,
        conflictingRegistry,
        status: r.rows[0].status,
      };
    }
  } catch (e: unknown) {
    if ((e as { code?: string }).code !== "23505") throw e;
    // Concurrent run won the race; fall through to read the existing row.
  }
  const existing = await client.query(
    `select id, company_a, company_b, rule, detail, conflicting_registry, status
     from public.match_candidate
     where least(company_a, company_b) = least($1::uuid, $2::uuid)
       and greatest(company_a, company_b) = greatest($1::uuid, $2::uuid)
       and rule = $3`,
    [ca, cb, rule],
  );
  const row = existing.rows[0];
  return {
    id: row.id,
    companyA: row.company_a,
    companyB: row.company_b,
    rule: row.rule,
    detail: row.detail,
    conflictingRegistry: row.conflicting_registry,
    status: row.status,
  };
}

/**
 * Run deterministic resolution for one company. Idempotent: repeated runs
 * return the same candidate rows without duplicating. Auto-merges only
 * domain-exact, conflict-free pairs (older record wins).
 */
export async function findCandidates(
  pool: Pool,
  companyId: string,
  opts: { actor: string; autoMerge?: boolean },
): Promise<ResolveResult> {
  const autoMerge = opts.autoMerge ?? true;
  const client = await pool.connect();
  try {
    const me = await loadCompany(client, companyId);
    if (!me) throw fail(404, "company_not_found", "company not found");
    if (me.merged_into)
      return { companyId, skipped: "already merged", candidates: [], autoMerged: [] };

    const peers = (
      await client.query(
        `select id, name, domain_norm, registry_id, registry_type, country_code, merged_into, created_at
         from public.company where merged_into is null and id <> $1`,
        [companyId],
      )
    ).rows as CompanyLite[];

    const aliasHits = new Set<string>();
    const keys: string[] = [];
    if (me.domain_norm) keys.push(me.domain_norm);
    if (me.registry_id) keys.push(me.registry_id);
    if (keys.length > 0) {
      const ar = await client.query(
        `select canonical_company_id from public.company_alias
         where alias_value = any($1) and verification = 'verified'`,
        [keys],
      );
      for (const row of ar.rows) aliasHits.add(row.canonical_company_id as string);
    }

    const myName = normalizeName(me.name);
    const candidates: CandidateFound[] = [];
    const autoMerged: ResolveResult["autoMerged"] = [];

    // Order peers deterministically (older first) for stable winner choice.
    peers.sort((x, y) =>
      x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : 0,
    );

    for (const peer of peers) {
      // Rule 1: jurisdiction-scoped registry + type agreement (review only).
      if (registryRuleMatch(me, peer)) {
        candidates.push(
          await upsertCandidate(
            client,
            me.id,
            peer.id,
            "registry_scoped",
            `same registry ${me.registry_id} under jurisdiction ${me.country_code}`,
            false,
          ),
        );
        continue;
      }
      // Rule 2: exact normalized domain — skipped on shared/platform hosts,
      // which collide across unrelated companies (see hosts.ts).
      if (
        me.domain_norm &&
        peer.domain_norm &&
        me.domain_norm === peer.domain_norm &&
        !isSharedHost(me.domain_norm)
      ) {
        const conflict = registryConflict(me, peer) || registryTypeConflict(me, peer);
        const cand = await upsertCandidate(
          client,
          me.id,
          peer.id,
          "domain_exact",
          conflict
            ? `same domain ${me.domain_norm} BUT conflicting registry evidence (${me.registry_id ?? "—"} vs ${peer.registry_id ?? "—"}) — human review required`
            : `same normalized domain ${me.domain_norm}`,
          conflict,
        );
        candidates.push(cand);
        if (autoMerge && shouldAutoMerge(cand)) {
          // Older record wins (peers sorted oldest-first; me may be older).
          const winner = me.created_at <= peer.created_at ? me : peer;
          const loser = winner.id === me.id ? peer : me;
          const summary = await mergePair(client, loser.id, winner.id, opts.actor);
          autoMerged.push({ loser: loser.id, winner: winner.id, summary });
          await client.query(
            `update public.match_candidate set status = 'accepted',
               decided_by = $2, decided_at = now(),
               decision_reason = $3 where id = $1`,
            [cand.id, opts.actor, `auto-merge (domain_exact, no conflict): ${summary}`],
          );
          cand.status = "accepted";
        }
        continue;
      }
      // Rule 3: verified alias.
      if (aliasHits.has(peer.id)) {
        candidates.push(
          await upsertCandidate(
            client,
            me.id,
            peer.id,
            "alias",
            `identifier matches a verified alias of ${peer.name} from a prior reviewed merge`,
            registryConflict(me, peer),
          ),
        );
        continue;
      }
      // Rule 4: exact normalized name — review only, never auto.
      if (myName !== "" && myName === normalizeName(peer.name)) {
        candidates.push(
          await upsertCandidate(
            client,
            me.id,
            peer.id,
            "name_exact",
            `same normalized name "${myName}" with different identifiers — names alone prove nothing`,
            registryConflict(me, peer),
          ),
        );
      }
    }
    return { companyId, skipped: null, candidates, autoMerged };
  } finally {
    client.release();
  }
}

async function mergePair(
  client: PoolClient,
  loser: string,
  winner: string,
  actor: string,
  allowConflict = false,
  reason = "resolution merge",
): Promise<string> {
  const r = await client.query(
    "select public.resolve_merge_company($1, $2, $3, $4, $5)",
    [loser, winner, actor, reason, allowConflict],
  );
  return r.rows[0].resolve_merge_company as string;
}

export interface DecisionInput {
  decision: "accepted" | "rejected" | "deferred";
  reason?: string;
  actor: string;
  allowConflict?: boolean;
}

/** Human decision on a candidate. Accepted triggers the merge transaction. */
export async function decideCandidate(
  pool: Pool,
  candidateId: string,
  input: DecisionInput,
): Promise<{ candidateId: string; status: string; summary: string | null }> {
  if (!["accepted", "rejected", "deferred"].includes(input.decision))
    throw fail(422, "bad_decision", "decision must be accepted, rejected, or deferred");
  if (input.decision !== "accepted" && !(input.reason ?? "").trim())
    throw fail(422, "reason_required", "a reason is required to reject or defer");

  const client = await pool.connect();
  try {
    await client.query("begin");
    const c = await client.query(
      `select id, company_a, company_b, rule, conflicting_registry, status
       from public.match_candidate where id = $1 for update`,
      [candidateId],
    );
    if (c.rows.length === 0) {
      await client.query("rollback");
      throw fail(404, "candidate_not_found", "candidate not found");
    }
    const cand = c.rows[0];
    if (cand.status !== "pending") {
      await client.query("rollback");
      throw fail(409, "candidate_decided", `candidate is already ${cand.status}`);
    }

    if (input.decision === "accepted") {
      // Winner choice is the operator's: default older record for stability.
      // The decision endpoint accepts an explicit winner via reason tag?
      // Keep deterministic: older created_at wins (same as auto-merge).
      const pair = await client.query(
        `select id, created_at from public.company where id = any($1) for update`,
        [[cand.company_a, cand.company_b]],
      );
      if (pair.rows.length < 2) {
        await client.query("rollback");
        throw fail(409, "candidate_stale", "a side of this candidate no longer exists");
      }
      pair.rows.sort((x, y) =>
        x.created_at < y.created_at ? -1 : 1,
      );
      const [winner, loser] = [pair.rows[0].id as string, pair.rows[1].id as string];
      const reason = (input.reason ?? "").trim() || `accepted by ${input.actor} (${cand.rule})`;
      let summary: string;
      try {
        summary = await mergePair(
          client,
          loser,
          winner,
          input.actor,
          input.allowConflict ?? false,
          reason,
        );
      } catch (e: unknown) {
        await client.query("rollback");
        const msg = (e as Error).message ?? "";
        if (msg.startsWith("registry_conflict"))
          throw fail(409, "registry_conflict", msg + " — re-confirm with allowConflict to override");
        if (msg.startsWith("merge_state") || msg.startsWith("alias_collision"))
          throw fail(409, "merge_blocked", msg);
        throw e;
      }
      await client.query(
        `update public.match_candidate set status = 'accepted', decided_by = $2,
           decided_at = now(), decision_reason = $3 where id = $1`,
        [candidateId, input.actor, `${reason}: ${summary}`],
      );
      await client.query(
        `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
         values ('match_candidate', $1, $2, 'pending', 'accepted', $3)`,
        [candidateId, input.actor, reason],
      );
      await client.query("commit");
      return { candidateId, status: "accepted", summary };
    }

    await client.query(
      `update public.match_candidate set status = $2, decided_by = $3,
         decided_at = now(), decision_reason = $4 where id = $1`,
      [candidateId, input.decision, input.actor, (input.reason ?? "").trim()],
    );
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('match_candidate', $1, $2, 'pending', $3, $4)`,
      [candidateId, input.actor, input.decision, (input.reason ?? "").trim()],
    );
    await client.query("commit");
    return { candidateId, status: input.decision, summary: null };
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {
      /* already rolled back */
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Reopen a decided candidate with new material evidence. Rejected/deferred
 * rows never auto-resurrect (regenerate skips non-pending); only this
 * explicit call returns one to pending, preserving the prior decision in
 * the audit trail and stamping reopen_reason/reopened_at.
 */
export async function reopenCandidate(
  pool: Pool,
  candidateId: string,
  input: { reason: string; actor: string },
): Promise<{ candidateId: string; status: string }> {
  if (!(input.reason ?? "").trim())
    throw fail(422, "reason_required", "reopening requires new material evidence described as a reason");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const c = await client.query(
      "select id, status from public.match_candidate where id = $1 for update",
      [candidateId],
    );
    if (c.rows.length === 0) {
      await client.query("rollback");
      throw fail(404, "candidate_not_found", "candidate not found");
    }
    if (c.rows[0].status === "pending") {
      await client.query("rollback");
      throw fail(409, "candidate_pending", "candidate is already pending");
    }
    if (c.rows[0].status === "accepted") {
      await client.query("rollback");
      throw fail(409, "candidate_merged", "accepted candidates stay decided (records already merged)");
    }
    await client.query(
      `update public.match_candidate set status = 'pending',
         reopen_reason = $2, reopened_at = now() where id = $1`,
      [candidateId, input.reason.trim()],
    );
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('match_candidate', $1, $2, $3, 'pending', $4)`,
      [candidateId, input.actor, c.rows[0].status, `reopened: ${input.reason.trim()}`],
    );
    await client.query("commit");
    return { candidateId, status: "pending" };
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {
      /* already rolled back */
    }
    throw e;
  } finally {
    client.release();
  }
}

export interface MergePreview {
  candidateId: string;
  rule: string;
  conflictingRegistry: boolean;
  winner: { id: string; name: string };
  loser: { id: string; name: string };
  /** Per-table row counts that would move from loser to winner. */
  moves: Record<string, number>;
  stays: string[];
}

/** Explicit merge-impact preview (older record wins). Read-only. */
export async function previewCandidate(
  pool: Pool,
  candidateId: string,
): Promise<MergePreview> {
  const client = await pool.connect();
  try {
    const c = await client.query(
      `select m.id, m.rule, m.conflicting_registry, m.status,
              a.id as aid, a.name as aname, a.created_at as acreated,
              b.id as bid, b.name as bname, b.created_at as bcreated
       from public.match_candidate m
       join public.company a on a.id = m.company_a
       join public.company b on b.id = m.company_b
       where m.id = $1`,
      [candidateId],
    );
    if (c.rows.length === 0) throw fail(404, "candidate_not_found", "candidate not found");
    const row = c.rows[0];
    const winner = row.acreated <= row.bcreated
      ? { id: row.aid, name: row.aname }
      : { id: row.bid, name: row.bname };
    const loser = winner.id === row.aid
      ? { id: row.bid, name: row.bname }
      : { id: row.aid, name: row.aname };
    const tables = [
      "discovery_record",
      "research_run",
      "claim",
      "hypothesis",
      "brief",
      "import_row",
    ];
    const moves: Record<string, number> = {};
    for (const t of tables) {
      const r = await client.query(
        `select count(*)::int as n from public.${t} where company_id = $1`,
        [loser.id],
      );
      moves[t] = r.rows[0].n as number;
    }
    return {
      candidateId,
      rule: row.rule,
      conflictingRegistry: row.conflicting_registry,
      winner,
      loser,
      moves,
      stays: [
        "snapshots stay with their original record (immutability policy)",
        "loser row is archived + aliased, never deleted",
      ],
    };
  } finally {
    client.release();
  }
}

/** Review queue: pending candidates between canonical records, with impact counts. */
export async function getCandidateQueue(pool: Pool, status = "pending") {
  const client = await pool.connect();
  try {
    const r = await client.query(
      `select m.id, m.rule, m.detail, m.conflicting_registry, m.status,
              m.created_at, a.name as name_a, b.name as name_b,
              a.id as id_a, b.id as id_b,
              (select count(*) from public.discovery_record where company_id in (a.id, b.id))::int
               + (select count(*) from public.claim where company_id in (a.id, b.id))::int
               + (select count(*) from public.hypothesis where company_id in (a.id, b.id))::int
               + (select count(*) from public.brief where company_id in (a.id, b.id))::int
              as linked_rows
       from public.match_candidate m
       join public.company a on a.id = m.company_a
       join public.company b on b.id = m.company_b
       where m.status = $1
         and a.merged_into is null and b.merged_into is null
       order by m.created_at desc limit 500`,
      [status],
    );
    return r.rows;
  } finally {
    client.release();
  }
}
