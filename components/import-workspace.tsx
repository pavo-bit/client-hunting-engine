"use client";

// CSV upload -> preview -> dialog-confirmed commit. Client component; all
// validation and commits happen server-side (POST /api/imports*).

import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, THead, TH, TD } from "@/components/ui/table";

interface PreviewRow {
  rowNumber: number;
  status: string;
  errors: { field: string; message: string }[];
  formulaRisk: boolean;
  values: Record<string, string>;
}

interface Preview {
  batchId: string;
  summary: Record<string, number>;
  rows: PreviewRow[];
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, never> };
}

const statusTone: Record<string, "default" | "info" | "success" | "warning" | "danger"> = {
  valid: "success",
  invalid: "danger",
  duplicate_in_file: "warning",
  conflict_existing: "warning",
};

function PreviewTable({ rows }: { rows: PreviewRow[] }) {
  const columns = useMemo<ColumnDef<PreviewRow>[]>(
    () => [
      { accessorKey: "rowNumber", header: "Row" },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ getValue, row }) => (
          <span className="inline-flex items-center gap-1">
            <Badge variant={statusTone[getValue<string>()] ?? "default"}>
              {getValue<string>()}
            </Badge>
            {row.original.formulaRisk && (
              <Badge variant="warning" title="Cell starts with = + - @ — never evaluated; escape before spreadsheet export">
                formula-risk
              </Badge>
            )}
          </span>
        ),
      },
      { id: "name", header: "Name", accessorFn: (r) => r.values.name },
      {
        id: "domain",
        header: "Domain",
        accessorFn: (r) => r.values.domain || r.values.registry_id,
      },
      {
        id: "issues",
        header: "Issues",
        accessorFn: (r) => r.errors.map((e) => e.message).join("; "),
      },
    ],
    [],
  );
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });
  return (
    <Table>
      <THead>
        {table.getHeaderGroups().map((hg) => (
          <tr key={hg.id}>
            {hg.headers.map((h) => (
              <TH key={h.id}>{flexRender(h.column.columnDef.header, h.getContext())}</TH>
            ))}
          </tr>
        ))}
      </THead>
      <tbody>
        {table.getRowModel().rows.map((r) => (
          <tr key={r.id}>
            {r.getVisibleCells().map((c) => (
              <TD key={c.id}>{flexRender(c.column.columnDef.cell, c.getContext())}</TD>
            ))}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function ImportWorkspace() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmResult, setConfirmResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function onFile(f: File | undefined) {
    if (!f) return;
    setPreviewError("");
    setPreview(null);
    setConfirmResult(null);
    setUploading(true);
    try {
      const csv = await f.text();
      const { status, data } = await postJson("/api/imports", { filename: f.name, csv });
      if (status === 200) setPreview(data as unknown as Preview);
      else setPreviewError(`Error ${status} (${String(data.code)}): ${String(data.message)}`);
    } finally {
      setUploading(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    setConfirming(true);
    try {
      const { status, data } = await postJson(`/api/imports/${preview.batchId}/confirm`, {});
      if (status === 200) {
        const s = data.summary as Record<string, number>;
        setConfirmResult({
          tone: "success",
          text:
            `Imported=${s.imported} skipped=${s.skipped} invalid=${s.invalid} ` +
            `duplicates=${s.duplicateInFile} conflicts=${s.conflictExisting}` +
            (data.alreadyCommitted ? " (already committed — no rewrite)" : ""),
        });
      } else {
        setConfirmResult({ tone: "error", text: `Error ${status}: ${String(data.message)}` });
      }
    } finally {
      setConfirming(false);
      setDialogOpen(false);
    }
  }

  const shownRows = preview ? preview.rows.slice(0, 200) : [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>1 · Upload and preview</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            type="file"
            accept=".csv,text/csv"
            aria-label="Upload CSV file"
            disabled={uploading}
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          {uploading && <p className="text-sm text-slate-600">Validating and staging…</p>}
          {previewError && <Alert tone="error">{previewError}</Alert>}
          {preview && (
            <div className="space-y-3">
              <Alert tone="info">
                Batch {preview.batchId}: valid={preview.summary.valid} invalid=
                {preview.summary.invalid} duplicates={preview.summary.duplicateInFile}{" "}
                conflicts={preview.summary.conflictExisting}. Nothing is committed
                until you confirm.
              </Alert>
              <PreviewTable rows={shownRows} />
              {preview.rows.length > 200 && (
                <p className="text-xs text-slate-500">
                  Showing 200 of {preview.rows.length} staged rows.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle>2 · Confirm and commit</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button disabled={confirming || preview.summary.valid === 0}>
                  Review confirmation
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogTitle>Confirm import?</DialogTitle>
                <DialogDescription>
                  This commits {preview.summary.valid} valid row
                  {preview.summary.valid === 1 ? "" : "s"} to the agency
                  directory in one transaction (partial-success: conflicting
                  rows are skipped with reasons, never silently dropped).
                  Invalid, duplicate, and conflicting rows are not imported.
                </DialogDescription>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={confirm} disabled={confirming}>
                    {confirming ? "Committing…" : "Confirm import"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
            {confirmResult && (
              <Alert tone={confirmResult.tone === "success" ? "success" : "error"}>
                {confirmResult.text}
              </Alert>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
