import { describe, expect, it } from "vitest";
import {
  normalizeDomain,
  normalizeRegistryId,
  normalizeWebsiteUrl,
} from "../lib/intake/normalize";

describe("normalizeDomain", () => {
  const cases: Array<[string, string | null]> = [
    ["Acme-WebWorks.example", "acme-webworks.example"],
    ["https://WWW.Acme.example/services?x=1", "acme.example"],
    ["http://acme.example:8080/a/b#c", "acme.example"],
    ["  acme.example.  ", "acme.example"],
    ["user@acme.example", "acme.example"],
    ["sub.dept.agency.example", "sub.dept.agency.example"],
  ];
  for (const [input, want] of cases) {
    it(`normalizes ${input}`, () => {
      const r = normalizeDomain(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(want);
    });
  }

  const bad = [
    "",
    "   ",
    "nodot",
    "not a domain.com",
    "http://",
    "acme..example",
    "acme.123",
    "-bad.example",
    "a".repeat(250) + ".example", // >253 chars
  ];
  for (const input of bad) {
    it(`rejects ${JSON.stringify(input.slice(0, 30))}`, () => {
      expect(normalizeDomain(input).ok).toBe(false);
    });
  }
});

describe("normalizeRegistryId", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeRegistryId("  REG  123 ")).toEqual({
      ok: true,
      value: "REG 123",
    });
  });
  it("rejects empty and overlong", () => {
    expect(normalizeRegistryId("  ").ok).toBe(false);
    expect(normalizeRegistryId("x".repeat(121)).ok).toBe(false);
  });
});

describe("normalizeWebsiteUrl", () => {
  it("accepts http/https", () => {
    expect(normalizeWebsiteUrl("https://acme.example/x").ok).toBe(true);
  });
  it("rejects scheme-less, ftp, spaces", () => {
    expect(normalizeWebsiteUrl("acme.example").ok).toBe(false);
    expect(normalizeWebsiteUrl("ftp://acme.example").ok).toBe(false);
    expect(normalizeWebsiteUrl("https://acme.example/a b").ok).toBe(false);
  });
});
