// Import orchestration: preview/stage + confirm/commit (T-003).
//
// ATOMICITY POLICY (decided, FR-002 atomic-per-row): PARTIAL SUCCESS.
// Valid rows commit; invalid/conflicting rows are reported with row-level
// reasons and never silently dropped. The commit runs in ONE transaction
// with a per-row SAVEPOINT, so a late race conflict rolls back only that
// row (marked `skipped`), not the whole batch.
//
// DUPLICATE POLICY:
//   * Same-file repeat of a normalized domain / registry ID -> the 2nd+
//     occurrence is `duplicate_in_file` (first keeps its status).
//   * Match against existing companies (one batched query) ->
//     `conflict_existing` at preview, RECHECKED inside the confirm
//     transaction; the UNIQUE constraints are the final arbiter.
//   * Confirm is idempotent: re-confirming a committed batch returns the
//     stored summary without writing. Concurrent confirms serialize on
//     SELECT ... FOR UPDATE of the batch row.

import { createHash } from "crypto";
import type { Pool, PoolClient } from "pg";
import {
  MAX_DATA_ROWS,
  MAX_FILE_BYTES,
  cellHasFormulaRisk,
  checkRowShape,
  parseCsv,
  validateHeaders,
  type CsvFileError,
} from "./csv";
import { validateCompanyInput, type NormalizedCompany } from "./validate";

export type ImportRowStatus =
  | "pending"
  | "valid"
  | "invalid"
  | "duplicate_in_file"
  | "conflict_existing"
  | "skipped"
  | "imported";

export interface RowIssue {
  field: string;
  message: string;
}

export interface PreviewRow {
  rowNumber: number;
  status: ImportRowStatus;
  errors: RowIssue[];
  formulaRisk: boolean;
  values: Record<string, string>;
}

export interface ImportSummary {
  total: number;
  valid: number;
  invalid: number;
  duplicateInFile: number;
  conflictExisting: number;
  imported: number;
  skipped: number;
}

export interface PreviewResult {
  batchId: string;
  fileSha256: string;
  summary: ImportSummary;
  /** Every non-valid row + first 50 valid rows (bounded preview payload). */
  rows: PreviewRow[];
}

export interface ConfirmResult {
  batchId: string;
  alreadyCommitted: boolean;
  summary: ImportSummary;
  details: PreviewRow[];
}

export interface IntakeError {
  status: number;
  code: string;
  message: string;
}

const fail = (status: number, code: string, message: string): IntakeError => ({
  status,
  code,
  message,
});

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function emptySummary(): ImportSummary {
  return {
    total: 0,
    valid: 0,
    invalid: 0,
    duplicateInFile: 0,
    conflictExisting: 0,
    imported: 0,
    skipped: 0,
  };
}

function rowToInput(values: Record<string, string>) {
  return {
    name: values["name"] ?? "",
    domain: values["domain"] ?? "",
    registryId: values["registry_id"] ?? "",
    registryType: values["registry_type"] ?? "",
    agencyType: values["agency_type"] ?? "",
    country: values["country"] ?? "",
    countryCode: values["country_code"] ?? "",
    region: values["region"] ?? "",
    websiteUrl: values["website_url"] ?? "",
  };
}

/** Parse + validate + stage. Throws IntakeError (with HTTP status) on file faults. */
export async function previewImport(
  pool: Pool,
  opts: { filename: string; csvText: string; actor: string },
): Promise<PreviewResult> {
  const byteLen = Buffer.byteLength(opts.csvText, "utf8");
  if (byteLen > MAX_FILE_BYTES)
    throw fail(413, "file_too_large", `file exceeds ${MAX_FILE_BYTES} bytes`);
  if (byteLen === 0 || opts.csvText.trim() === "")
    throw fail(422, "empty_file", "file is empty");

  let parsed;
  try {
    parsed = parseCsv(opts.csvText);
  } catch (e) {
    const fe = e as CsvFileError;
    throw fail(422, fe.code ?? "malformed_csv", fe.message ?? "malformed CSV");
  }
  const headerErr = validateHeaders(parsed.headers);
  if (headerErr) throw fail(422, headerErr.code, headerErr.message);
  if (parsed.rows.length === 0)
    throw fail(422, "empty_file", "file has headers but no data rows");
  if (parsed.rows.length > MAX_DATA_ROWS)
    throw fail(
      413,
      "row_limit_exceeded",
      `file has ${parsed.rows.length} data rows; limit is ${MAX_DATA_ROWS} (D-007)`,
    );

  // Per-row field validation (no DB yet).
  type Staged = {
    rowNumber: number;
    values: Record<string, string>;
    errors: RowIssue[];
    formulaRisk: boolean;
    value: NormalizedCompany | null;
  };
  const staged: Staged[] = parsed.rows.map((cells, i) => {
    const rowNumber = i + 2; // 1-based incl. header
    const values: Record<string, string> = {};
    parsed.headers.forEach((h, j) => {
      values[h] = (cells[j] ?? "").trim();
    });
    const errors: RowIssue[] = [];
    const shape = checkRowShape(cells, rowNumber, parsed.headers.length);
    if (shape) errors.push(shape);
    let value: NormalizedCompany | null = null;
    if (errors.length === 0) {
      const v = validateCompanyInput(rowToInput(values));
      if (!v.ok) errors.push(...v.errors);
      else value = v.value;
    }
    const formulaRisk =
      errors.length === 0 &&
      Object.values(values).some((c) => cellHasFormulaRisk(c));
    return { rowNumber, values, errors, formulaRisk, value };
  });

  // In-file duplicates (normalized identity, first occurrence wins).
  const seenDomains = new Map<string, number>();
  const seenRegistries = new Map<string, number>();
  const dupFlags = new Array<boolean>(staged.length).fill(false);
  staged.forEach((s, i) => {
    if (!s.value) return;
    const { domainNorm, registryId } = s.value;
    let dup = false;
    if (domainNorm) {
      if (seenDomains.has(domainNorm)) dup = true;
      else seenDomains.set(domainNorm, s.rowNumber);
    }
    if (registryId) {
      if (seenRegistries.has(registryId)) dup = true;
      else seenRegistries.set(registryId, s.rowNumber);
    }
    dupFlags[i] = dup;
  });

  // Conflicts vs existing companies (single batched query per key type).
  const domains = [...seenDomains.keys()];
  const registries = [...seenRegistries.keys()];
  const existingDomains = new Set<string>();
  const existingRegistries = new Set<string>();
  const client = await pool.connect();
  try {
    if (domains.length > 0) {
      const r = await client.query(
        "select domain_norm from public.company where domain_norm = any($1)",
        [domains],
      );
      for (const row of r.rows) existingDomains.add(row.domain_norm);
    }
    if (registries.length > 0) {
      const r = await client.query(
        "select registry_id from public.company where registry_id = any($1)",
        [registries],
      );
      for (const row of r.rows) existingRegistries.add(row.registry_id);
    }
  } finally {
    client.release();
  }

  const summary = emptySummary();
  summary.total = staged.length;
  const previewRows: PreviewRow[] = staged.map((s, i) => {
    let status: ImportRowStatus;
    if (s.errors.length > 0) {
      status = "invalid";
      summary.invalid += 1;
    } else if (dupFlags[i]) {
      status = "duplicate_in_file";
      summary.duplicateInFile += 1;
      s.errors.push({
        field: "row",
        message: `row ${s.rowNumber}: duplicate of an earlier row in this file`,
      });
    } else if (
      (s.value!.domainNorm && existingDomains.has(s.value!.domainNorm)) ||
      (s.value!.registryId && existingRegistries.has(s.value!.registryId))
    ) {
      status = "conflict_existing";
      summary.conflictExisting += 1;
      s.errors.push({
        field: "row",
        message: `row ${s.rowNumber}: conflicts with an existing company record`,
      });
    } else {
      status = "valid";
      summary.valid += 1;
    }
    return {
      rowNumber: s.rowNumber,
      status,
      errors: s.errors,
      formulaRisk: s.formulaRisk,
      values: s.values,
    };
  });

  // Persist the staged batch (explicit confirmation happens later).
  const fileSha256 = sha256Hex(opts.csvText);
  const batchId = await stageBatch(pool, {
    filename: opts.filename.slice(0, 300),
    fileSha256,
    actor: opts.actor,
    rows: previewRows,
  });

  // Bounded payload: all non-valid rows + first 50 valid.
  const validShown = previewRows.filter((r) => r.status === "valid").slice(0, 50);
  const restShown = previewRows.filter((r) => r.status !== "valid");
  return {
    batchId,
    fileSha256,
    summary,
    rows: [...restShown, ...validShown].sort((a, b) => a.rowNumber - b.rowNumber),
  };
}

async function stageBatch(
  pool: Pool,
  opts: {
    filename: string;
    fileSha256: string;
    actor: string;
    rows: PreviewRow[];
  },
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const b = await client.query(
      `insert into public.import_batch
         (filename, file_sha256, total_rows, status, created_by)
       values ($1, $2, $3, 'draft', $4) returning id`,
      [opts.filename, opts.fileSha256, opts.rows.length, opts.actor],
    );
    const batchId: string = b.rows[0].id;
    for (const r of opts.rows) {
      // NOTE: full row set is staged (not just the bounded preview payload).
      await client.query(
        `insert into public.import_row
           (batch_id, row_number, raw, status, error, formula_risk)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          batchId,
          r.rowNumber,
          JSON.stringify(r.values),
          r.status === "valid" ? "valid" : r.status,
          r.errors.length > 0 ? JSON.stringify(r.errors) : null,
          r.formulaRisk,
        ],
      );
    }
    await client.query("commit");
    return batchId;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** Map staged rows back to validated input (server-side revalidation). */
function stagedToInput(raw: Record<string, string>) {
  return rowToInput(raw);
}

/**
 * Confirm + commit. Revalidates server-side; commits valid rows in ONE
 * transaction with per-row SAVEPOINTs. Idempotent on committed batches.
 */
export async function confirmImport(
  pool: Pool,
  batchId: string,
  actor: string,
): Promise<ConfirmResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const b = await client.query(
      "select id, status, total_rows from public.import_batch where id = $1 for update",
      [batchId],
    );
    if (b.rows.length === 0) {
      await client.query("rollback");
      throw fail(404, "batch_not_found", "import batch not found");
    }
    if (b.rows[0].status === "committed") {
      const prior = await readBatchSummary(client, batchId);
      await client.query("commit");
      return { batchId, alreadyCommitted: true, ...prior };
    }
    if (b.rows[0].status !== "draft") {
      await client.query("rollback");
      throw fail(409, "batch_not_committable", `batch is ${b.rows[0].status}`);
    }

    const staged = await client.query(
      `select id, row_number, raw, status from public.import_row
       where batch_id = $1 order by row_number`,
      [batchId],
    );

    // Fresh conflict recheck for rows staged as valid (preview is stale data).
    // NOTE: raw stores operator text; re-normalize via validation, not raw compare.
    const candidates = staged.rows.filter((r) => r.status === "valid");
    const normalized = new Map<string, NormalizedCompany>();
    for (const r of candidates) {
      const v = validateCompanyInput(
        stagedToInput(r.raw as Record<string, string>),
      );
      if (v.ok && v.value) normalized.set(r.id, v.value);
      else {
        await client.query(
          "update public.import_row set status = 'invalid', error = $2 where id = $1",
          [r.id, JSON.stringify(v.errors)],
        );
      }
    }
    const stillValid = [...normalized.entries()];
    const checkDomains = [...new Set(stillValid.map(([, v]) => v.domainNorm).filter(Boolean))];
    const checkRegistries = [...new Set(stillValid.map(([, v]) => v.registryId).filter(Boolean))];
    const takenDomains = new Set<string>();
    const takenRegistries = new Set<string>();
    if (checkDomains.length > 0) {
      const r = await client.query(
        "select domain_norm from public.company where domain_norm = any($1)",
        [checkDomains],
      );
      for (const row of r.rows) takenDomains.add(row.domain_norm);
    }
    if (checkRegistries.length > 0) {
      const r = await client.query(
        "select registry_id from public.company where registry_id = any($1)",
        [checkRegistries],
      );
      for (const row of r.rows) takenRegistries.add(row.registry_id);
    }

    const summary = emptySummary();
    summary.total = staged.rows.length;

    for (const row of staged.rows) {
      if (row.status !== "valid" || !normalized.has(row.id)) {
        // invalid / duplicate_in_file / conflict_existing / revalidation-failed
        if (row.status === "invalid") summary.invalid += 1;
        else if (row.status === "duplicate_in_file") summary.duplicateInFile += 1;
        else summary.conflictExisting += 1;
        if (row.status === "valid") {
          await client.query(
            "update public.import_row set status = 'invalid' where id = $1",
            [row.id],
          );
          summary.invalid += 1;
        }
        continue;
      }
      const v = normalized.get(row.id)!;
      if (
        (v.domainNorm && takenDomains.has(v.domainNorm)) ||
        (v.registryId && takenRegistries.has(v.registryId))
      ) {
        await client.query(
          `update public.import_row set status = 'conflict_existing',
             error = '[{"field":"row","message":"conflict detected at commit time"}]'
           where id = $1`,
          [row.id],
        );
        summary.conflictExisting += 1;
        continue;
      }
      await client.query(`savepoint t003_row`);
      try {
        const c = await client.query(
          `insert into public.company
             (name, domain_norm, registry_id, registry_type, agency_type, country,
              country_code, region, website_url, discovery_status)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'candidate') returning id`,
          [
            v.name,
            v.domainNorm,
            v.registryId,
            v.registryType,
            v.agencyType,
            v.country,
            v.countryCode,
            v.region,
            v.websiteUrl,
          ],
        );
        const companyId: string = c.rows[0].id;
        await client.query(
          `insert into public.discovery_record
             (company_id, source_key, collection_method, retrieval_status, note)
           values ($1, null, 'import', 'ok', $2)`,
          [companyId, `import batch ${batchId} row ${row.row_number}`],
        );
        await client.query(
          `insert into public.audit_log
             (entity_type, entity_id, actor, transition_from, transition_to, reason)
           values ('company', $1, $2, null, 'candidate', $3)`,
          [companyId, actor, `csv import batch ${batchId}`],
        );
        await client.query(
          `update public.import_row set status = 'imported', company_id = $2 where id = $1`,
          [row.id, companyId],
        );
        await client.query(`release savepoint t003_row`);
        if (v.domainNorm) takenDomains.add(v.domainNorm);
        if (v.registryId) takenRegistries.add(v.registryId);
        summary.imported += 1;
      } catch (e: unknown) {
        await client.query(`rollback to savepoint t003_row`);
        const code = (e as { code?: string }).code;
        if (code === "23505") {
          await client.query(
            `update public.import_row set status = 'skipped',
               error = '[{"field":"row","message":"unique conflict at commit (concurrent write)"}]'
             where id = $1`,
            [row.id],
          );
          summary.skipped += 1;
        } else {
          throw e;
        }
      }
    }

    await client.query(
      `update public.import_batch set status = 'committed', committed_at = now()
       where id = $1`,
      [batchId],
    );
    await client.query(
      `insert into public.audit_log
         (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('import_batch', $1, $2, 'draft', 'committed', $3)`,
      [
        batchId,
        actor,
        `imported=${summary.imported} skipped=${summary.skipped} ` +
          `invalid=${summary.invalid} dup=${summary.duplicateInFile} ` +
          `conflicts=${summary.conflictExisting}`,
      ],
    );
    await client.query("commit");

    const details = await readBatchDetails(pool, batchId);
    return { batchId, alreadyCommitted: false, summary, details };
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {
      /* already rolled back */
    }
    throw e;
  } finally {
    client.release();
  }
}

async function readBatchSummary(
  client: PoolClient,
  batchId: string,
): Promise<{ summary: ImportSummary; details: PreviewRow[] }> {
  const details = await readBatchDetailsFromClient(client, batchId);
  const summary = emptySummary();
  summary.total = details.length;
  for (const d of details) {
    if (d.status === "imported") summary.imported += 1;
    else if (d.status === "skipped") summary.skipped += 1;
    else if (d.status === "invalid") summary.invalid += 1;
    else if (d.status === "duplicate_in_file") summary.duplicateInFile += 1;
    else if (d.status === "conflict_existing") summary.conflictExisting += 1;
    else if (d.status === "valid") summary.valid += 1;
  }
  return { summary, details };
}

async function readBatchDetailsFromClient(
  client: PoolClient,
  batchId: string,
): Promise<PreviewRow[]> {
  const r = await client.query(
    `select row_number, raw, status, error, formula_risk from public.import_row
     where batch_id = $1 order by row_number`,
    [batchId],
  );
  return r.rows.map((row) => ({
    rowNumber: row.row_number,
    status: row.status as ImportRowStatus,
    errors: row.error ? (JSON.parse(row.error) as RowIssue[]) : [],
    formulaRisk: row.formula_risk as boolean,
    values: row.raw as Record<string, string>,
  }));
}

async function readBatchDetails(pool: Pool, batchId: string): Promise<PreviewRow[]> {
  const client = await pool.connect();
  try {
    return await readBatchDetailsFromClient(client, batchId);
  } finally {
    client.release();
  }
}

/** Full staged batch for preview/summary endpoints. Throws 404 if missing. */
export async function getBatchPreview(
  pool: Pool,
  batchId: string,
): Promise<{
  batchId: string;
  status: string;
  summary: ImportSummary;
  rows: PreviewRow[];
}> {
  const client = await pool.connect();
  try {
    const b = await client.query(
      "select id, status from public.import_batch where id = $1",
      [batchId],
    );
    if (b.rows.length === 0) throw fail(404, "batch_not_found", "import batch not found");
    const { summary, details } = await readBatchSummary(client, batchId);
    return { batchId, status: b.rows[0].status as string, summary, rows: details };
  } finally {
    client.release();
  }
}

/**
 * Single-company creation (server-side; validates + normalizes first).
 * Optional provenance lets discovery runs record source identity without
 * changing manual/import behavior (defaults preserve existing contracts).
 */
export interface CompanyProvenance {
  sourceKey: string | null;
  collectionMethod: "manual" | "api" | "import" | "observed_page";
  sourceRecordId?: string | null;
  note: string;
  auditReason: string;
}

export async function createCompany(
  pool: Pool,
  input: Parameters<typeof validateCompanyInput>[0],
  actor: string,
  provenance?: CompanyProvenance,
): Promise<{ companyId: string }> {
  const v = validateCompanyInput(input);
  if (!v.ok) throw fail(422, "validation_failed", JSON.stringify(v.errors));
  const c = v.value!;
  const client = await pool.connect();
  try {
    await client.query("begin");
    let companyId: string;
    try {
      const r = await client.query(
        `insert into public.company
           (name, domain_norm, registry_id, registry_type, agency_type, country,
            country_code, region, website_url, discovery_status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'candidate') returning id`,
        [
          c.name,
          c.domainNorm,
          c.registryId,
          c.registryType,
          c.agencyType,
          c.country,
          c.countryCode,
          c.region,
          c.websiteUrl,
        ],
      );
      companyId = r.rows[0].id;
    } catch (e: unknown) {
      await client.query("rollback");
      if ((e as { code?: string }).code === "23505")
        throw fail(409, "duplicate_company", "domain or registry ID already exists");
      throw e;
    }
    const prov: CompanyProvenance = provenance ?? {
      sourceKey: null,
      collectionMethod: "manual",
      note: "manual entry",
      auditReason: "manual entry",
    };
    await client.query(
      `insert into public.discovery_record
         (company_id, source_key, collection_method, retrieval_status, note, source_record_id)
       values ($1, $2, $3, 'ok', $4, $5)`,
      [companyId, prov.sourceKey, prov.collectionMethod, prov.note, prov.sourceRecordId ?? null],
    );
    await client.query(
      `insert into public.audit_log
         (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('company', $1, $2, null, 'candidate', $3)`,
      [companyId, actor, prov.auditReason],
    );
    await client.query("commit");
    return { companyId };
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {
      /* already rolled back */
    }
    throw e;
  } finally {
    client.release();
  }
}
