/**
 * Dashboard read-contract + navigation inventory tests (T-003 regression
 * companion). Reads live local data; writes nothing.
 */
import { existsSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { ALL_NAV_ITEMS } from "../lib/dashboard/nav";
import {
  getBrief,
  getClaims,
  getOutcomes,
  getOverview,
  getSources,
} from "../lib/dashboard/queries";

const APP_ROOT = join(__dirname, "..", "app");

describe("dashboard read contracts", () => {
  it("overview breakdowns sum to their totals", async () => {
    const o = await getOverview();
    const sum = (rows: { n: number }[]) => rows.reduce((a, r) => a + r.n, 0);
    expect(sum(o.companiesByStatus)).toBe(o.companies);
    expect(sum(o.claimsByStatus)).toBe(o.claims);
    expect(sum(o.briefsByStatus)).toBe(o.briefs);
    expect(o.migrationsApplied).toBeGreaterThanOrEqual(7);
  });

  it("seed brief resolves with drafts and outcomes; missing ref is null", async () => {
    const b = await getBrief("BR-2026-001");
    expect(b).not.toBeNull();
    expect(b?.company_name).toBe("Acme Webworks");
    expect(Array.isArray(b?.drafts)).toBe(true);
    expect(Array.isArray(b?.outcomes)).toBe(true);
    expect(await getBrief("BR-2999-999")).toBeNull();
  });

  it("every claim carries snapshot provenance", async () => {
    const claims = await getClaims();
    expect(claims.length).toBeGreaterThan(0);
    for (const c of claims) {
      expect(c.snapshot_url.length).toBeGreaterThan(0);
      expect(c.source_key.length).toBeGreaterThan(0);
      expect(["observed", "corroborated", "inferred", "assumed"]).toContain(c.claim_status);
    }
  });

  it("outcome date fields render safely (pg DATE arrives as Date)", async () => {
    // Regression: /pipeline 500'd rendering a raw Date child. Pages must
    // format date-likes; this pins the driver behavior that caused it.
    const outcomes = await getOutcomes();
    expect(outcomes.length).toBeGreaterThan(0);
    for (const o of outcomes) {
      const v = o.sent_at_manual as unknown;
      expect(v === null || v instanceof Date || typeof v === "string").toBe(true);
      expect(() =>
        v === null || v === undefined ? "—" : new Date(v as string | Date).toLocaleDateString(),
      ).not.toThrow();
    }
  });

  it("source registry holds exactly the 12 approved categories", async () => {
    const sources = await getSources();
    expect(
      sources.filter((s) => s.kind === "category").map((s) => s.category).sort(),
    ).toEqual(
      ["S-01","S-02","S-03","S-04","S-05","S-06","S-07","S-08","S-09","S-10","S-11","S-12"],
    );
  });
});

describe("navigation inventory", () => {
  it("every nav href resolves to a real page file", () => {
    const missing: string[] = [];
    for (const item of ALL_NAV_ITEMS) {
      const page = join(APP_ROOT, item.href.replace(/^\//, ""), "page.tsx");
      if (!existsSync(page)) missing.push(`${item.href} (${item.label})`);
    }
    expect(missing).toEqual([]);
  });

  it("every page directory is reachable from navigation (no orphan pages)", () => {
    // Collect app/**/page.tsx routes, excluding dynamic segments + API.
    const { readdirSync } = require("fs") as typeof import("fs");
    const routes = new Set<string>();
    const walk = (dir: string, prefix: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith("_") || e.name === "api") continue;
        if (e.isDirectory()) walk(join(dir, e.name), `${prefix}/${e.name}`);
        else if (e.name === "page.tsx" && !prefix.includes("["))
          routes.add(prefix === "" ? "/" : prefix);
      }
    };
    walk(APP_ROOT, "");
    routes.delete("/");
    const hrefs = new Set(ALL_NAV_ITEMS.map((i) => i.href));
    // Deliberate funnels (reachable only from a parent workflow, by design):
    // /proposals/new opens solely from a validated hypothesis detail page.
    // /login is deliberately outside navigation: it is the unauthenticated
    // entry point (AUTH-001), reached by redirect, never by nav link.
    const FUNNELS = new Set(["/proposals/new", "/login"]);
    const orphans = [...routes].filter((r) => !hrefs.has(r) && !FUNNELS.has(r));
    expect(orphans).toEqual([]);
  });
});
