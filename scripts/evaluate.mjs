// Operator-run evaluation harness (Part 3, §9).
//
// Runs the versioned gold set against explicit fixture versions, compares
// four ranking baselines, and writes the generated baseline report. Manual
// and operator-triggered only: nothing in the repository invokes this.
//
// Usage (local only; refuses non-loopback databases):
//   node scripts/evaluate.mjs --target test --actor <label> \
//     [--split dev|heldout|both] [--fixture] [--keep] \
//     [--policy V --catalog V --rubric V --capacity V]
//
// --fixture registers the Part 2 test fixture versions (draft+publish) in the
// target database first. Without it, versions must be passed explicitly.
// --keep leaves gold-seed rows for inspection; default cleans them up.
// Output: JSON report to stdout + docs/EVALUATION_BASELINE_REPORT.md.
//
// The thresholds in lib/eval/harness.ts were declared BEFORE the first run.
// This script never tunes anything: it seeds, scores, measures, reports.
import pg from "pg";
import { readFileSync, writeFileSync } from "fs";
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
if (!actor) {
  console.error("FAILED: --actor is required (or set OPERATOR_EMAIL)");
  process.exit(2);
}
if (target !== "test") {
  console.error("FAILED: evaluation seeds synthetic fixtures — --target test only (never dev)");
  process.exit(2);
}

const out = (obj) => console.log(JSON.stringify(obj, null, 2));

try {
  const { loadGoldSet, evaluateSplit, cleanupGold, EVAL_THRESHOLDS } = await import("../lib/eval/harness.ts");
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  try {
    const gold = loadGoldSet(ROOT);
    const split = flag("split", "both");
    const splits = split === "both" ? ["dev", "heldout"] : [split];
    if (!splits.every((s) => s === "dev" || s === "heldout")) throw new Error("--split must be dev|heldout|both");

    let versions;
    if (flag("fixture", undefined) !== undefined || args.includes("--fixture")) {
      const { registerFixtureSet } = await import("../tests/qualification_fixtures.ts");
      const set = await registerFixtureSet(pool, "evalrun");
      versions = {
        policyVersion: set.policyVersion,
        catalogVersion: set.catalogVersion,
        rubricVersion: set.rubricVersion,
        capacityVersion: set.capacityVersion,
        signalMap: set.policy.signalMap,
        freshnessDefaultDays: set.policy.freshnessDefaultDays,
        asOf: "2026-10-15T00:00:00.000Z",
        actor,
      };
    } else {
      const need = ["policy", "catalog", "rubric"];
      for (const k of need) {
        if (!flag(k)) throw new Error(`--${k} is required without --fixture`);
      }
      const { readPolicy } = await import("../lib/qualification/policy.ts");
      const policy = await readPolicy(pool, flag("policy"));
      versions = {
        policyVersion: flag("policy"),
        catalogVersion: flag("catalog"),
        rubricVersion: flag("rubric"),
        capacityVersion: flag("capacity", undefined),
        signalMap: policy.signalMap,
        freshnessDefaultDays: policy.freshnessDefaultDays,
        asOf: "2026-10-15T00:00:00.000Z",
        actor,
      };
    }

    const reports = [];
    for (const s of splits) {
      reports.push(await evaluateSplit(pool, gold, s, versions));
      if (!args.includes("--keep")) await cleanupGold(pool);
    }

    const report = {
      generated: new Date().toISOString(),
      generator: "scripts/evaluate.mjs (operator-run; manual only)",
      goldVersion: gold.version,
      thresholds: EVAL_THRESHOLDS,
      thresholdNote:
        "Declared BEFORE the first run (lib/eval/harness.ts). Changing them after inspecting results invalidates the evaluation.",
      syntheticNote:
        "The gold set is SYNTHETIC fixture data measuring engine behavior on constructed cases — never commercial outcomes. Nothing here claims real-world lead quality.",
      versions: {
        policy: versions.policyVersion,
        catalog: versions.catalogVersion,
        rubric: versions.rubricVersion,
        capacity: versions.capacityVersion,
        asOf: versions.asOf,
      },
      splits: reports,
    };
    const md = [
      "# EVALUATION BASELINE REPORT (GENERATED — do not hand-edit)",
      "",
      `> Generated ${report.generated} by an explicit operator run of \`scripts/evaluate.mjs\`.`,
      "> Reproduce: `node scripts/evaluate.mjs --target test --actor <label> --fixture [--split dev|heldout|both]`.",
      "> The gold set is SYNTHETIC fixture data measuring engine behavior — never commercial outcomes.",
      "> Thresholds were declared before the first run (lib/eval/harness.ts) and are not tuned on results.",
      "",
      `Gold set v${gold.version}: dev=${gold.items.filter((i) => i.split === "dev").length} items, heldout=${gold.items.filter((i) => i.split === "heldout").length} items.`,
      `Versions: policy ${versions.policyVersion} / catalog ${versions.catalogVersion} / rubric ${versions.rubricVersion} / capacity ${versions.capacityVersion ?? "none"} / as_of ${versions.asOf}.`,
      "",
      ...reports.flatMap((r) => [
        `## Split: ${r.split} (${r.items} items)`,
        "",
        "| Metric | Value | Threshold | Pass | Denominator / notes |",
        "|---|---|---|---|---|",
        ...r.metrics.map((m) => {
          const v = m.value === null ? "UNMEASURED" : m.value.toFixed(3);
          const p = m.pass === null ? "n/a" : m.pass ? "PASS" : "MISS";
          return `| ${m.name} | ${v} | ${m.threshold ?? "—"} | ${p} | n=${m.denominator ?? "?"} — ${m.notes} |`;
        }),
        "",
        "### Baselines (identical eligible pool, identical labels)",
        "",
        "| Baseline | P@10 | P@20 |",
        "|---|---|---|",
        ...Object.entries(r.baselines).map(
          ([name, b]) => `| ${name} | ${b.precisionAt10.toFixed(3)} | ${b.precisionAt20.toFixed(3)} |`,
        ),
        "",
        "### Unmeasured (capture mechanisms defined, no data yet)",
        "",
        ...r.unmeasured.map((u) => `- **${u.name}**: ${u.capture}`),
        "",
      ]),
    ].join("\n");
    writeFileSync(join(ROOT, "docs", "EVALUATION_BASELINE_REPORT.md"), md);
    out(report);
  } finally {
    await pool.end();
  }
} catch (e) {
  console.error(`FAILED: ${e.message ?? e}`);
  process.exit(1);
}
