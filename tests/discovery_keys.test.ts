/**
 * Discovery opportunity-key unit tests (pure, no database).
 * Covers TEST_PLAN T-DISC-U1 (+ key-related edge cases).
 */
import { describe, expect, it } from "vitest";
import { contentFingerprint, opportunityKey } from "../lib/discovery/keys";
import { linkPromotion, registerOpportunity, transitionOpportunity } from "../lib/discovery/opportunities";

describe("opportunityKey", () => {
  it("builds stable per-pipeline keys for adapter records", () => {
    expect(
      opportunityKey({ pipeline: "agency_partner", sourceKey: "gleif-api", sourceRecordId: "ABC123" }),
    ).toBe("opp:agency_partner:gleif-api:abc123");
    // Case/whitespace-insensitive: same record, same key.
    expect(
      opportunityKey({ pipeline: "agency_partner", sourceKey: " GLEIF-API ", sourceRecordId: " abc123 " }),
    ).toBe("opp:agency_partner:gleif-api:abc123");
  });

  it("separates pipelines: same record, different key per pipeline", () => {
    const a = opportunityKey({ pipeline: "agency_partner", sourceKey: "s", sourceRecordId: "r1" });
    const b = opportunityKey({ pipeline: "direct_client", sourceKey: "s", sourceRecordId: "r1" });
    expect(a).not.toBe(b);
    expect(a.startsWith("opp:agency_partner:")).toBe(true);
    expect(b.startsWith("opp:direct_client:")).toBe(true);
  });

  it("falls back to manual identity only with explicit material", () => {
    expect(
      opportunityKey({ pipeline: "agency_partner", sourceKey: "search-web", sourceRecordId: null, fallback: "Acme Webworks" }),
    ).toBe("opp:agency_partner:search-web:manual:acme webworks");
  });

  it("refuses to invent identity (422, never a guessed key)", () => {
    const t = (fn: () => unknown, code: string) =>
      expect(fn).toThrow(expect.objectContaining({ status: 422, code }));
    t(() => opportunityKey({ pipeline: "agency_partner", sourceKey: "", sourceRecordId: "x" }), "bad_source");
    t(() => opportunityKey({ pipeline: "agency_partner", sourceKey: "s", sourceRecordId: null }), "no_stable_identity");
    t(
      () => opportunityKey({ pipeline: "agency_partner", sourceKey: "s", sourceRecordId: null, fallback: "  " }),
      "no_stable_identity",
    );
    t(() => opportunityKey({ pipeline: "other" as never, sourceKey: "s", sourceRecordId: "x" }), "bad_pipeline");
    t(
      () => opportunityKey({ pipeline: "agency_partner", sourceKey: "s", sourceRecordId: "x".repeat(301) }),
      "bad_record_id",
    );
  });
});

describe("contentFingerprint", () => {
  it("resolves reposts deterministically", () => {
    expect(contentFingerprint("Hello, World!")).toBe(contentFingerprint("  hello   world "));
    expect(contentFingerprint("abc")).not.toBe(contentFingerprint("abd"));
    expect(contentFingerprint("x".repeat(500)).length).toBeLessThanOrEqual(200);
  });
});

describe("attribution guards (offline: rejected before any database use)", () => {
  it("requires a non-empty actor identity", async () => {
    const pool = undefined as never;
    await expect(
      registerOpportunity(pool, { pipeline: "agency_partner", sourceKey: "s", sourceRecordId: "x", actor: "" }),
    ).rejects.toMatchObject({ status: 422, code: "actor_required" });
    await expect(
      transitionOpportunity(pool, "00000000-0000-4000-8000-000000000000", "archived", { reason: "x", actor: "  " }),
    ).rejects.toMatchObject({ status: 422, code: "actor_required" });
    await expect(
      linkPromotion(pool, "00000000-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000000", ""),
    ).rejects.toMatchObject({ status: 422, code: "actor_required" });
  });
});
