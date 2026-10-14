import { describe, expect, it } from "vitest";
import {
  MAX_DATA_ROWS,
  cellHasFormulaRisk,
  decodeCsvBytes,
  parseCsv,
  validateHeaders,
} from "../lib/intake/csv";

const HEADER =
  "name,domain,registry_id,agency_type,country,country_code,region,website_url";

function row(
  name: string,
  domain = "acme.example",
  extra: Partial<Record<string, string>> = {},
): string {
  const cells = {
    name,
    domain,
    registry_id: "",
    agency_type: "web_development",
    country: "United States",
    country_code: "US",
    region: "",
    website_url: "",
    ...extra,
  };
  return [
    cells.name,
    cells.domain,
    cells.registry_id,
    cells.agency_type,
    cells.country,
    cells.country_code,
    cells.region,
    cells.website_url,
  ].join(",");
}

describe("parseCsv", () => {
  it("parses quoted commas, quotes, and embedded newlines", () => {
    const text =
      HEADER + '\n"Acme, ""Best""\nWorks",acme.example,,web_development,US,US,,\n';
    const p = parseCsv(text);
    expect(p.headers).toHaveLength(8);
    expect(p.rows[0][0]).toBe('Acme, "Best"\nWorks');
  });

  it("handles CRLF and skips the final blank line", () => {
    const p = parseCsv(HEADER + "\r\n" + row("A") + "\r\n");
    expect(p.rows).toHaveLength(1);
  });

  it("throws malformed on unterminated quotes", () => {
    expect(() => parseCsv(HEADER + '\n"oops,acme.example')).toThrow();
  });

  it("flags formula-leading cells, never evaluates", () => {
    expect(cellHasFormulaRisk("=cmd(1)")).toBe(true);
    expect(cellHasFormulaRisk("+123")).toBe(true);
    expect(cellHasFormulaRisk("@x")).toBe(true);
    expect(cellHasFormulaRisk("-5")).toBe(true);
    expect(cellHasFormulaRisk("  normal text")).toBe(false);
    expect(cellHasFormulaRisk("")).toBe(false);
  });
});

describe("validateHeaders", () => {
  it("accepts the exact template", () => {
    expect(validateHeaders(HEADER.split(","))).toBeNull();
  });
  it("rejects missing, duplicate, and unexpected headers", () => {
    expect(validateHeaders(["name", "domain"])?.code).toBe("missing_columns");
    expect(
      validateHeaders([...HEADER.split(","), "name"])?.code,
    ).toBe("duplicate_headers");
    expect(
      validateHeaders([...HEADER.split(","), "linkedin"])?.code,
    ).toBe("unexpected_columns");
  });
  it("rejects empty header set", () => {
    expect(validateHeaders([])?.code).toBe("empty_file");
  });
});

describe("decodeCsvBytes", () => {
  it("strips BOM and decodes UTF-8", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);
    expect(decodeCsvBytes(bytes)).toBe("A");
  });
  it("rejects invalid UTF-8", () => {
    expect(() => decodeCsvBytes(new Uint8Array([0xff, 0xfe]))).toThrow();
  });
});

describe("row limits (D-007)", () => {
  it(`parses exactly ${MAX_DATA_ROWS} rows`, () => {
    const lines = [HEADER];
    for (let i = 0; i < MAX_DATA_ROWS; i++) lines.push(row(`Agency ${i}`, `a${i}.example`));
    const p = parseCsv(lines.join("\n"));
    expect(p.rows).toHaveLength(MAX_DATA_ROWS);
  });
});
