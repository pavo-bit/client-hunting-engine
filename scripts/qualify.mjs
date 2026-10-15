// Operator commands for Phase 2 consumption and reconciliation (Part 1).
//
// Everything here is EXPLICITLY operator-invoked: there is no scheduler, no
// watcher and no background job anywhere in this repository that calls these
// functions. The operator runs one command, reads the JSON report, and decides.
//
// Usage (local only; refuses non-loopback databases):
//   node scripts/qualify.mjs consume --consumer <name> [--batch N]
//   node scripts/qualify.mjs backfill [--pipeline agency_partner|direct_client]
//   node scripts/qualify.mjs reconcile
//   node scripts/qualify.mjs run-all --consumer <name> [--idempotency-key K]
//   node scripts/qualify.mjs status --consumer <name>
//   node scripts/qualify.mjs replay --case <case-uuid>
//   node scripts/qualify.mjs assess --opportunity <uuid> [--policy V --catalog V
//     --rubric V --capacity V --as-of ISO --answers JSON --idempotency-key K]
//
// Common flags: --target dev|test (default dev), --actor <label> (required for
// writes; defaults to OPERATOR_EMAIL from .env so the label is the operator's
// own identity, never a guess), --json (default output is already JSON).
import pg from "pg";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* no .env — env must supply values */
}

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, fallback = undefined) => {
  const i = args.findIndex((a) => a === `--${name}`);
  if (i === -1) return fallback;
  return args[i + 1] ?? fallback;
};
const target = flag("target", "dev");
const DEV_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel";
const TEST_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
const url = target === "test" ? TEST_URL : DEV_URL;
const host = new URL(url).hostname;
if (host !== "127.0.0.1" && host !== "localhost") {
  console.error(`refusing non-local database target: ${host}`);
  process.exit(2);
}
const actor = flag("actor", (process.env.OPERATOR_EMAIL ?? "").trim().toLowerCase());

function needActor(cmds) {
  if (!actor) {
    console.error(`FAILED: --actor is required for '${cmds}' (or set OPERATOR_EMAIL); attribution must name the operator`);
    process.exit(2);
  }
}

const out = (obj) => console.log(JSON.stringify(obj, null, 2));

try {
  // TypeScript sources are imported through a loader-free path: the lib is
  // plain TypeScript without decorators, so tsx is not available here.
  // Instead this script shells to vitest-covered lib functions via node with
  // experimental type stripping (Node >= 22), matching the repo's toolchain.
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  try {
    if (cmd === "consume") {
      needActor(cmd);
      const consumer = flag("consumer");
      if (!consumer) throw new Error("--consumer is required");
      const { consumePendingEvents } = await import("../lib/qualification/reconcile.ts");
      out(await consumePendingEvents(pool, consumer, actor, Number(flag("batch", "50"))));
    } else if (cmd === "backfill") {
      needActor(cmd);
      const { backfillCases } = await import("../lib/qualification/reconcile.ts");
      const pipeline = flag("pipeline", undefined);
      out(await backfillCases(pool, actor, pipeline));
    } else if (cmd === "reconcile") {
      const { reconcileCases } = await import("../lib/qualification/reconcile.ts");
      out(await reconcileCases(pool));
    } else if (cmd === "run-all") {
      needActor(cmd);
      const consumer = flag("consumer");
      if (!consumer) throw new Error("--consumer is required");
      const { reconcileAll } = await import("../lib/qualification/reconcile.ts");
      out(await reconcileAll(pool, { consumer, actor, idempotencyKey: flag("idempotency-key", undefined) }));
    } else if (cmd === "status") {
      const consumer = flag("consumer");
      if (!consumer) throw new Error("--consumer is required");
      const { consumerWatermark } = await import("../lib/qualification/events.ts");
      const wm = await consumerWatermark(pool, consumer);
      const cases = await pool.query(
        "select count(*)::int as cases, count(*) filter (where drift_detected_at is not null)::int as drifted from p2.case",
      );
      const inbox = await pool.query(
        "select status, count(*)::int as n from p2.event_inbox where consumer_name = $1 group by status",
        [consumer],
      );
      out({ consumer, watermark: wm, ...cases.rows[0], inbox: inbox.rows });
    } else if (cmd === "replay") {
      const id = flag("case");
      if (!id) throw new Error("--case <case-uuid> is required");
      const { replayCase } = await import("../lib/qualification/reconcile.ts");
      out(await replayCase(pool, id));
    } else if (cmd === "assess") {
      needActor(cmd);
      const opportunity = flag("opportunity");
      if (!opportunity) throw new Error("--opportunity <uuid> is required");
      const { runAssessment } = await import("../lib/qualification/assessments.ts");
      let answers = {};
      const rawAnswers = flag("answers", undefined);
      if (rawAnswers !== undefined) {
        try {
          const parsed = JSON.parse(rawAnswers);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("not an object");
          }
          answers = parsed;
        } catch {
          throw new Error("--answers must be a JSON object");
        }
      }
      // Omitted versions resolve to the ACTIVE version of each kind; when
      // none is active the run is refused — an invented default is never
      // substituted.
      const activeVersion = async (kind, required) => {
        const r = await pool.query(
          "select version from p2.reference_version where kind = $1 and status = 'active' order by recorded_at desc limit 1",
          [kind],
        );
        const v = r.rows[0]?.version ?? null;
        if (!v && required) throw new Error(`no active ${kind} version — publish one explicitly before assessing`);
        return v;
      };
      out(
        await runAssessment(pool, {
          opportunityId: opportunity,
          policyVersion: flag("policy", undefined) ?? (await activeVersion("policy", true)),
          catalogVersion: flag("catalog", undefined) ?? (await activeVersion("service_catalog", true)),
          rubricVersion: flag("rubric", undefined) ?? (await activeVersion("rubric", true)),
          capacityVersion: flag("capacity", undefined) ?? (await activeVersion("capacity", false)),
          operatorAnswers: answers,
          asOf: flag("as-of", undefined),
          actor,
          idempotencyKey: flag("idempotency-key", undefined),
        }),
      );
    } else {
      console.error(
        "usage: node scripts/qualify.mjs <consume|backfill|reconcile|run-all|status|replay|assess> [--target dev|test] [--consumer NAME] [--actor LABEL] [--batch N] [--pipeline P] [--idempotency-key K] [--case UUID] [--opportunity UUID] [--policy V --catalog V --rubric V --capacity V --as-of ISO --answers JSON]",
      );
      process.exit(2);
    }
  } finally {
    await pool.end();
  }
} catch (e) {
  console.error(`FAILED: ${e.message ?? e}`);
  process.exit(1);
}
