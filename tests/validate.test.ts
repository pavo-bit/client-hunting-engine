import { describe, expect, it } from "vitest";
import { validateCompanyInput } from "../lib/intake/validate";

const base = {
  name: "Acme Webworks",
  domain: "https://WWW.acme.example/",
  registryId: "",
  agencyType: "web_development",
  country: "United States",
  countryCode: "us",
  region: "California",
  websiteUrl: "https://acme.example",
};

describe("validateCompanyInput", () => {
  it("accepts a valid input and normalizes", () => {
    const r = validateCompanyInput({ ...base });
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({
      name: "Acme Webworks",
      domainNorm: "acme.example",
      registryId: null,
      agencyType: "web_development",
      countryCode: "US",
    });
  });

  it("rejects missing name / identifier / country with field errors", () => {
    const r = validateCompanyInput({
      ...base,
      name: "  ",
      domain: "",
      registryId: "",
      country: "",
    });
    expect(r.ok).toBe(false);
    const fields = r.errors.map((e) => e.field).sort();
    expect(fields).toEqual(["country", "domain", "name"]);
  });

  it("rejects bare platform hosts as domain identity, with guidance", () => {
    // T-004 rule: linkedin.com identifies the platform, not the agency.
    // Storing it would corrupt identity and block unrelated records.
    const r = validateCompanyInput({
      ...base,
      domain: "https://linkedin.com/company/acme",
      registryId: "",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.field)).toContain("domain");
    expect(r.errors.map((e) => e.message).join(" ")).toMatch(/registry ID/);
    // With a registry the record stands on registry identity (host dropped).
    const ok = validateCompanyInput({
      ...base,
      domain: "https://linkedin.com/company/acme",
      registryId: "RX-1",
    });
    expect(ok.ok).toBe(true);
    expect(ok.value?.domainNorm).toBeNull();
    expect(ok.value?.registryId).toBe("RX-1");
  });

  it("rejects unknown agency type and bad country code", () => {
    const r = validateCompanyInput({
      ...base,
      agencyType: "crypto_mining",
      countryCode: "USA",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.field).sort()).toEqual([
      "agencyType",
      "countryCode",
    ]);
  });

  it("rejects bad domain and bad website URL", () => {
    const r = validateCompanyInput({
      ...base,
      domain: "nodot",
      websiteUrl: "acme.example/no-scheme",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.field).sort()).toEqual([
      "domain",
      "websiteUrl",
    ]);
  });

  it("accepts registry-only identity (no domain)", () => {
    const r = validateCompanyInput({ ...base, domain: "", registryId: "HRB 12345" });
    expect(r.ok).toBe(true);
    expect(r.value?.domainNorm).toBeNull();
    expect(r.value?.registryId).toBe("HRB 12345");
  });
});
