// Lexicographic ranking (Part 2, §8). Pure ordering + persisted snapshots.
//
// Rankable = outcome eligible_for_assessment AND composite present AND every
// mandatory floor met. Order: composite desc, then the policy tiebreak
// dimensions in order, then opportunity id (total, deterministic). A high
// composite can never conceal a floor failure: floors are evaluated BEFORE any
// comparison, and the explanation says which floor excluded whom.
//
// Pursuit order uses the pursuit_priority dimension (composite + capacity
// alignment); intrinsic fit is never reordered by capacity. maxActivePursuits
// (when set) marks the cutoff: rows beyond it are flagged CUT_OFF, not
// deleted — the operator sees the whole order and the capacity line in it.

import { createHash } from "crypto";
import type { Pool, PoolClient } from "pg";
import type { Dimension, PolicyDefinition } from "./policy.ts";
import type { ScoreResult } from "./scoring.ts";

export interface RankedLead {
  caseId: string;
  opportunityId: string;
  composite: number;
  pursuit: number | null;
  band: string | null;
  rank: number;
  cutoff: boolean;
  excludedReason: string | null;
}

export interface RankedResult {
  ordered: RankedLead[];
  inputHash: string;
}

/**
 * Rank scored leads. `scores` maps caseId -> {opportunityId, score}.
 * Pure; identical inputs produce identical orders.
 */
export function rankLeads(
  scores: { caseId: string; opportunityId: string; score: ScoreResult; suppressed?: boolean }[],
  policy: Pick<PolicyDefinition, "floors" | "ranking">,
  maxActive: number | null,
): RankedResult {
  const eligible = scores.filter(
    (s) =>
      !s.suppressed &&
      s.score.outcome === "eligible_for_assessment" &&
      s.score.composite !== null &&
      (Object.keys(policy.floors) as string[]).every((d) => {
        const floor = policy.floors[d] ?? null;
        if (floor === null) return true;
        const v = d === "pursuit_priority" ? s.score.dimensions.pursuit_priority.score : s.score.dimensions[d as keyof ScoreResult["dimensions"]]?.score;
        return v !== null && v !== undefined && v >= floor;
      }),
  );
  const excluded = scores.filter((s) => !eligible.includes(s));
  const sorted = [...eligible].sort((a, b) => {
    const ca = a.score.composite as number;
    const cb = b.score.composite as number;
    if (cb !== ca) return cb - ca;
    for (const dim of policy.ranking.tiebreak) {
      const va = a.score.dimensions[dim]?.score ?? -1;
      const vb = b.score.dimensions[dim]?.score ?? -1;
      if (vb !== va) return vb - va;
    }
    return a.opportunityId.localeCompare(b.opportunityId);
  });
  const ordered: RankedLead[] = sorted.map((s, i) => ({
    caseId: s.caseId,
    opportunityId: s.opportunityId,
    composite: s.score.composite as number,
    pursuit: s.score.dimensions.pursuit_priority.score,
    band: s.score.band,
    rank: i + 1,
    cutoff: maxActive !== null && i + 1 > maxActive,
    excludedReason: null,
  }));
  for (const s of excluded) {
    const reason = s.suppressed
      ? "suppressed — never ranked"
      : s.score.outcome !== "eligible_for_assessment"
        ? `outcome ${s.score.outcome}`
        : s.score.composite === null
          ? "no composite (insufficient coverage)"
          : "mandatory dimension floor not met";
    ordered.push({
      caseId: s.caseId,
      opportunityId: s.opportunityId,
      composite: s.score.composite ?? 0,
      pursuit: s.score.dimensions.pursuit_priority.score,
      band: s.score.band,
      rank: 0,
      cutoff: false,
      excludedReason: reason,
    });
  }
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        leads: [...scores]
          .map((s) => ({ c: s.caseId, o: s.opportunityId, h: s.score.inputHash }))
          .sort((a, b) => a.c.localeCompare(b.c)),
        floors: policy.floors,
        tiebreak: policy.ranking.tiebreak,
        maxActive,
      }),
      "utf8",
    )
    .digest("hex");
  return { ordered, inputHash };
}

/**
 * Explain why A ranks above (or below) B, in reproducible terms: outcome,
 * floors, composite gap, then the first tiebreak dimension that differs.
 */
export function explainPairwise(
  a: { caseId: string; opportunityId: string; score: ScoreResult; rank: number },
  b: { caseId: string; opportunityId: string; score: ScoreResult; rank: number },
  tiebreak: Dimension[],
): string {
  if (a.rank === 0 && b.rank > 0) return `${short(a)} is excluded (${reasonOf(a)}); ${short(b)} ranks #${b.rank}`;
  if (b.rank === 0 && a.rank > 0) return `${short(b)} is excluded (${reasonOf(b)}); ${short(a)} ranks #${a.rank}`;
  if (a.rank === 0 && b.rank === 0) return `both excluded: ${short(a)} (${reasonOf(a)}), ${short(b)} (${reasonOf(b)})`;
  if (a.score.composite !== b.score.composite) {
    const [hi, lo] = (a.score.composite as number) >= (b.score.composite as number) ? [a, b] : [b, a];
    return `${short(hi)} ranks #${hi.rank} above ${short(lo)} #${lo.rank}: composite ${hi.score.composite} vs ${lo.score.composite}`;
  }
  for (const dim of tiebreak) {
    const va = a.score.dimensions[dim]?.score;
    const vb = b.score.dimensions[dim]?.score;
    if (va !== vb) {
      const [hi, lo] = (va ?? -1) >= (vb ?? -1) ? [a, b] : [b, a];
      return `${short(hi)} ranks #${hi.rank} above ${short(lo)} #${lo.rank}: tied composite ${a.score.composite}, ${dim} ${hi.score.dimensions[dim]?.score} vs ${lo.score.dimensions[dim]?.score}`;
    }
  }
  return `${short(a)} and ${short(b)} tie on every compared field; id order decides (#${a.rank} vs #${b.rank})`;
}

function short(x: { opportunityId: string }): string {
  return x.opportunityId.slice(0, 8);
}
function reasonOf(x: { score: ScoreResult }): string {
  return x.score.outcome !== "eligible_for_assessment"
    ? `outcome ${x.score.outcome}`
    : (x.score.flags.includes("NO_COMPOSITE") ? "no composite" : "floor not met");
}

export interface RankingSnapshotInput {
  policyVersion: string;
  catalogVersion: string;
  rubricVersion: string;
  capacityVersion: string | null;
  asOf: string;
  ranked: RankedResult;
  actor: string;
}

/** Persist one reproducible ranking run. Re-running identical inputs reproduces the input hash. */
export async function recordRankingSnapshot(
  db: Pool | PoolClient,
  input: RankingSnapshotInput,
): Promise<{ rankingId: string; inputHash: string }> {
  if (!(input.actor ?? "").trim()) {
    const e = new Error("acting operator identity is required") as Error & { status: number; code: string };
    e.status = 422;
    e.code = "actor_required";
    throw e;
  }
  const ordered = input.ranked.ordered.map((l) => ({
    case_id: l.caseId,
    opportunity_id: l.opportunityId,
    composite: l.composite,
    pursuit: l.pursuit,
    band: l.band,
    rank: l.rank,
    cutoff: l.cutoff,
    excluded_reason: l.excludedReason,
  }));
  const r = await db.query(
    `insert into p2.ranking_snapshot
       (policy_version, catalog_version, rubric_version, capacity_version,
        as_of, ordered, input_hash, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning ranking_id`,
    [
      input.policyVersion,
      input.catalogVersion,
      input.rubricVersion,
      input.capacityVersion,
      input.asOf,
      JSON.stringify(ordered),
      input.ranked.inputHash,
      input.actor.trim().slice(0, 200),
    ],
  );
  return { rankingId: r.rows[0].ranking_id as string, inputHash: input.ranked.inputHash };
}
