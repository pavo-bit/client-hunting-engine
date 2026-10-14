// CSV parsing + file-level validation for import preview (T-003).
// Pure functions. Formulas are NEVER evaluated — cells are data only, and
// risky leading characters are flagged for safe rendering downstream.

import type { FieldError } from "./normalize";

/** D-007: provisional operational policy. */
export const MAX_DATA_ROWS = 5000;
/** Provisional safety cap (T-003): files above this are rejected outright. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Exact template columns. Unexpected columns reject the file (fail fast on
 *  shifted/misaligned data rather than guessing). */
export const EXPECTED_COLUMNS = [
  "name",
  "domain",
  "registry_id",
  "agency_type",
  "country",
  "country_code",
  "region",
  "website_url",
] as const;

/** Optional columns accepted in addition to the template (backward
 *  compatible: older files without them still validate). */
export const OPTIONAL_COLUMNS = ["registry_type"] as const;

export interface ParsedCsv {
  headers: string[];
  /** Data rows; each row is an array of raw cell strings. */
  rows: string[][];
}

export interface CsvFileError {
  code:
    | "empty_file"
    | "malformed_csv"
    | "missing_columns"
    | "duplicate_headers"
    | "unexpected_columns"
    | "row_too_long"
    | "row_limit_exceeded"
    | "file_too_large"
    | "invalid_encoding";
  message: string;
}

/** Decode upload bytes as UTF-8, strip BOM. Throws CsvFileError on bad bytes. */
export function decodeCsvBytes(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const e: CsvFileError = {
      code: "invalid_encoding",
      message: "file is not valid UTF-8; re-save as UTF-8 CSV",
    };
    throw e;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/**
 * Minimal RFC-4180 parser: commas, CRLF/LF, double-quoted fields with ""
 * escapes and embedded newlines. Returns unterminated-quote as malformed.
 */
export function parseCsv(text: string): ParsedCsv {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    // Skip fully-empty trailing lines (e.g. final newline), keep otherwise.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += c;
        i += 1;
      }
    } else if (c === '"') {
      inQuotes = true;
      i += 1;
    } else if (c === ",") {
      pushField();
      i += 1;
    } else if (c === "\r" && text[i + 1] === "\n") {
      pushRow();
      i += 2;
    } else if (c === "\n" || c === "\r") {
      pushRow();
      i += 1;
    } else {
      field += c;
      i += 1;
    }
  }
  if (inQuotes) {
    // Unterminated quoted field: malformed. Signal via sentinel row.
    throw { code: "malformed_csv", message: "unterminated quoted field" } as CsvFileError;
  }
  // Flush trailing content without a line break.
  if (field !== "" || row.length > 0) pushRow();
  if (rows.length === 0) return { headers: [], rows: [] };
  const [headers, ...data] = rows;
  return { headers: headers.map((h) => h.trim()), rows: data };
}

/** Validate header row against the template. */
export function validateHeaders(headers: string[]): CsvFileError | null {
  if (headers.length === 0)
    return { code: "empty_file", message: "file has no header row" };
  const seen = new Set<string>();
  for (const h of headers) {
    if (seen.has(h))
      return { code: "duplicate_headers", message: `duplicate header: ${h}` };
    seen.add(h);
  }
  const expected = new Set<string>(EXPECTED_COLUMNS);
  const allowed = new Set<string>([...EXPECTED_COLUMNS, ...OPTIONAL_COLUMNS]);
  const missing = [...expected].filter((c) => !seen.has(c));
  if (missing.length > 0)
    return { code: "missing_columns", message: `missing columns: ${missing.join(", ")}` };
  const unexpected = headers.filter((h) => !allowed.has(h));
  if (unexpected.length > 0)
    return {
      code: "unexpected_columns",
      message: `unexpected columns (remove or rename): ${unexpected.join(", ")}`,
    };
  return null;
}

/** Leading characters that make spreadsheet apps evaluate a cell. */
const FORMULA_LEADS = ["=", "+", "-", "@", "\t", "\r"];

export function cellHasFormulaRisk(cell: string): boolean {
  const t = cell.trimStart();
  return t.length > 0 && FORMULA_LEADS.includes(t[0]);
}

/** Row-level (non-DB) structural checks before field validation. */
export function checkRowShape(
  row: string[],
  rowNumber: number,
  headerCount: number,
): FieldError | null {
  if (row.length !== headerCount) {
    return {
      field: "row",
      message: `row ${rowNumber}: has ${row.length} cells, expected ${headerCount}`,
    };
  }
  return null;
}
