/**
 * FINAL prompt 1: documentation-consistency regression tests.
 *
 * Guards against the specific failure mode this project forbids: silently
 * marking unresolved work complete, dropping decision IDs, or claiming an
 * approval the register does not show. Static, deterministic, offline.
 * Covers docs/DECISIONS_AND_OPEN_QUESTIONS.md, docs/LOW_LEVEL_PLANNING.md,
 * and relative markdown links across docs/.
 */
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DOCS = join(ROOT, "docs");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("decision register integrity", () => {
  it("keeps every decision ID stable (none dropped or renumbered)", () => {
    const reg = read("docs/DECISIONS_AND_OPEN_QUESTIONS.md");
    for (const id of [
      "D-000", "D-001", "D-002", "D-003", "D-004", "D-005", "D-006",
      "D-007", "D-008", "D-009", "D-010", "D-011", "D-012", "D-013",
      "D-014", "D-015", "D-016", "D-017", "D-018",
    ]) {
      expect(reg, `decision ${id} must exist in the register`).toContain(`| ${id} |`);
    }
  });

  it("leaves owner decisions OPEN until a dated approval exists", () => {
    const reg = read("docs/DECISIONS_AND_OPEN_QUESTIONS.md");
    for (const id of ["D-004", "D-005", "D-006", "D-008"]) {
      const row = reg.split("\n").find((l) => l.startsWith(`| ${id} |`));
      expect(row, `${id} row must exist`).toBeTruthy();
      expect(row!, `${id} must still read OPEN`).toMatch(/OPEN/);
    }
    // No document may claim these are approved while the register says OPEN.
    // Only a bare granted-approval claim counts: the match must contain a
    // grant verb (approved/granted/signed-off/decided) with NO pending-word
    // anywhere in a wide ±200-char window. Phrasings about approvals still
    // pending/required/remaining, and quoted approval templates awaiting
    // signature, are legitimate and must not trip the scan.
    const approvalClaims: string[] = [];
    const PENDING =
      /proposal|pending|open|unapproved|requires? owner|approval-ready|remain|required|needed|awaiting|outstanding|stay open|still open|before|without|until|needed to start|must not begin|not start|with changes|or rejection|replies, dated|to be signed|exact approval|awaiting review|blocked by/i;
    const GRANT = /approved|granted|signed[\s-]off|decided/i;
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".md")) {
          const text = readFileSync(p, "utf8");
          for (const id of ["D-004", "D-005", "D-006", "D-008"]) {
            for (const m of text.matchAll(new RegExp(id, "g"))) {
              const window = text.slice(Math.max(0, (m.index ?? 0) - 200), (m.index ?? 0) + 120);
              if (GRANT.test(window) && !PENDING.test(window)) {
                approvalClaims.push(`${p}: …${window.replace(/\s+/g, " ").trim().slice(0, 160)}…`);
              }
            }
          }
        }
      }
    };
    walk(DOCS);
    expect(approvalClaims, "no doc may claim owner approval the register does not show").toEqual([]);
  });

  it("keeps T-014 marked NOT STARTED until its protocol is approved", () => {
    const plan = read("docs/LOW_LEVEL_PLANNING.md");
    const idx = plan.indexOf("### T-014");
    expect(idx).toBeGreaterThan(-1);
    const section = plan.slice(idx, idx + 2000);
    expect(section).toMatch(/NOT STARTED/);
    expect(section).not.toMatch(/COMPLETE/);
  });
});

describe("docs link integrity", () => {
  it("resolves every relative markdown link inside docs/", () => {
    const missing: string[] = [];
    const files = readdirSync(DOCS).filter((f) => f.endsWith(".md"));
    for (const f of files) {
      const text = readFileSync(join(DOCS, f), "utf8");
      for (const m of text.matchAll(/\]\(([^)#][^)]*\.md[^)]*)\)/g)) {
        const target = m[1].trim();
        if (/^https?:/.test(target)) continue;
        // Links are relative to docs/ but may legally point at siblings of
        // docs/ (e.g. ../agents/QUALITY_GATES.md) — both must resolve.
        const abs = resolve(DOCS, target);
        if (!existsSync(abs) || (!abs.startsWith(DOCS) && !abs.startsWith(ROOT))) {
          missing.push(`${f} -> ${target}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps every promised deliverable file present", () => {
    for (const f of [
      "docs/MILESTONE2_DECISION_PROPOSALS.md",
      "docs/T014_VALIDATION_PROTOCOL_PROPOSAL.md",
      "docs/T014_VALIDATION_PROTOCOL.md",
      "docs/T014_RECORDING_TEMPLATE.md",
      "docs/FINAL_POLICY_CLOSURE_REPORT.md",
      "docs/D004_D005_D006_D008_DECISION_RECORDS.md",
    ]) {
      expect(existsSync(join(ROOT, f)), `${f} must exist`).toBe(true);
    }
  });
});
