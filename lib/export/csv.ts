// CSV encoding for operator exports (Phase 3).
//
// Two distinct hazards are handled here, and they are NOT the same thing:
//
//   1. FORMULA INJECTION. A cell beginning with = + - @ TAB or CR is executed
//      as a formula by Excel/LibreOffice/Sheets when the file is opened. Our
//      cells are attacker-influenced (an imported CSV row, a scraped page
//      title, an operator's pasted claim). Mitigation: prefix such a cell
//      with a single quote, which those spreadsheets treat as "this is text".
//      This is applied to EVERY column, not just a "notes" column.
//
//   2. SYNTAX BREAKAGE. Quotes, commas, CR and LF must be quoted, and inner
//      quotes doubled, or the row/column structure is corrupted.
//
// Both are pure functions over a value, so they are exhaustively testable
// without a database or a browser.

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_LEADERS = ["=", "+", "-", "@", "\t", "\r"];

/**
 * True when a cell must be neutralized. Leading whitespace and control
 * characters are stripped for the test only — " =cmd" is as dangerous as
 * "=cmd" — but the ORIGINAL text is what gets written (prefixed), never the
 * stripped version, so no data is silently altered beyond the guard.
 */
export function isFormulaLike(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/^[\s\u0000-\u001F]+/, "");
  const first = stripped.charAt(0);
  return FORMULA_LEADERS.includes(first);
}

/**
 * Encode one CSV cell. Returns "" for null/undefined (an empty cell, which
 * is distinguishable from the literal two-character string "null").
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : value instanceof Date
          ? value.toISOString()
          : String(value);
  if (isFormulaLike(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s) || s !== s.trim()) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Build a complete CSV document. Uses CRLF line endings (RFC 4180) and a
 * UTF-8 BOM so spreadsheet software opens non-ASCII company names correctly
 * instead of mangling them.
 */
export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export interface ExportColumn<T> {
  /** Stable machine name; also the CSV header and the JSON key. */
  key: string;
  /** Human description of what the column MEANS (shown in the UI + docs). */
  semantics: string;
  value: (row: T) => unknown;
}

/**
 * Column catalogue. Names are stable identifiers that must not be renamed
 * without a decision: operators build spreadsheets against them.
 */
export const AGENCY_EXPORT_COLUMNS: ExportColumn<{
  id: string; name: string; domain_norm: string | null; registry_id: string | null;
  registry_type: string | null; agency_type: string; country: string;
  country_code: string | null; region: string | null; website_url: string | null;
  discovery_status: string; created_at: string; evidence_count: number;
  latest_evidence_at: string | null; latest_source_key: string | null;
  merged_into: string | null;
}>[] = [
  { key: "company_id", semantics: "Canonical internal company id (UUID).", value: (r) => r.id },
  { key: "company_name", semantics: "Canonical company name as recorded.", value: (r) => r.name },
  { key: "domain_norm", semantics: "Normalized domain, if any.", value: (r) => r.domain_norm },
  { key: "registry_id", semantics: "External registry identifier (e.g. LEI), if any.", value: (r) => r.registry_id },
  { key: "registry_type", semantics: "Which registry the registry_id belongs to.", value: (r) => r.registry_type },
  { key: "agency_type", semantics: "Agency classification as recorded.", value: (r) => r.agency_type },
  { key: "country", semantics: "Country name as recorded.", value: (r) => r.country },
  { key: "country_code", semantics: "ISO alpha-2 code, null when unknown.", value: (r) => r.country_code },
  { key: "region", semantics: "Region/state, if recorded.", value: (r) => r.region },
  { key: "website_url", semantics: "Public website, if recorded.", value: (r) => r.website_url },
  {
    key: "discovery_status",
    semantics: "WORKFLOW state (candidate/resolved/qualified/rejected/archived) — NOT a qualification verdict.",
    value: (r) => r.discovery_status,
  },
  {
    key: "merged_into",
    semantics: "Canonical company id this record was merged into; non-null means non-canonical.",
    value: (r) => r.merged_into,
  },
  {
    key: "evidence_count",
    semantics: "Distinct observation snapshots captured for this company.",
    value: (r) => r.evidence_count,
  },
  {
    key: "latest_evidence_at",
    semantics: "Newest observation capture time; null when no evidence exists.",
    value: (r) => r.latest_evidence_at,
  },
  {
    key: "latest_source_key",
    semantics: "Source key of the newest observation (attribution).",
    value: (r) => r.latest_source_key,
  },
  { key: "created_at", semantics: "When the company record was created.", value: (r) => r.created_at },
];