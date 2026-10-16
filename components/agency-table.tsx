"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowUpDown } from "lucide-react";
import { Badge } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, THead, TH, TD } from "@/components/ui/table";

export interface AgencyRow {
  id: string;
  name: string;
  domain_norm: string | null;
  registry_id: string | null;
  agency_type: string;
  country: string;
  country_code: string | null;
  discovery_status: string;
  created_at: string;
  /** Present in server-side directory results; absent in older callers. */
  evidence_count?: number;
  latest_evidence_at?: string | null;
  latest_source_key?: string | null;
}

const statusTone: Record<string, "default" | "info" | "success" | "warning" | "danger"> = {
  candidate: "default",
  resolved: "info",
  qualified: "success",
  rejected: "danger",
  archived: "warning",
};

function SortButton({ label, onToggle }: { label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex cursor-pointer items-center gap-1 font-medium text-slate-600 hover:text-slate-900"
    >
      {label}
      <ArrowUpDown className="size-3" aria-hidden="true" />
    </button>
  );
}

export function AgencyTable({ rows }: { rows: AgencyRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [filter, setFilter] = useState("");

  const columns = useMemo<ColumnDef<AgencyRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => (
          <SortButton label="Agency" onToggle={() => column.toggleSorting()} />
        ),
        cell: ({ row }) => (
          <span>
            <Link href={`/agencies/${row.original.id}`} className="text-blue-700 hover:underline">
              {row.original.name}
            </Link>{" "}
            {row.original.domain_norm?.endsWith(".example") && (
              <Badge variant="info" title="Synthetic development fixture">
                synthetic
              </Badge>
            )}
          </span>
        ),
      },
      {
        accessorKey: "domain_norm",
        header: "Domain",
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      {
        accessorKey: "agency_type",
        header: ({ column }) => (
          <SortButton label="Type" onToggle={() => column.toggleSorting()} />
        ),
      },
      {
        accessorKey: "country",
        header: ({ column }) => (
          <SortButton label="Country" onToggle={() => column.toggleSorting()} />
        ),
        cell: ({ row }) =>
          row.original.country_code
            ? `${row.original.country} (${row.original.country_code})`
            : row.original.country,
      },
      {
        accessorKey: "discovery_status",
        header: "State",
        cell: ({ getValue }) => {
          const s = getValue<string>();
          return <Badge variant={statusTone[s] ?? "default"}>{s}</Badge>;
        },
      },
      {
        id: "evidence",
        header: ({ column }) => (
          <SortButton label="Evidence" onToggle={() => column.toggleSorting()} />
        ),
        accessorFn: (row) => row.evidence_count ?? 0,
        cell: ({ row }) => {
          const n = row.original.evidence_count ?? 0;
          if (n === 0) {
            return (
              <Badge variant="warning" title="No observations captured — provenance is missing">
                none
              </Badge>
            );
          }
          return (
            <span>
              {n}{" "}
              <span className="text-xs text-slate-500">
                {row.original.latest_source_key ?? "unknown source"}
              </span>
            </span>
          );
        },
      },
      {
        accessorKey: "latest_evidence_at",
        header: "Newest observation",
        cell: ({ getValue }) => {
          const v = getValue<string | null | undefined>();
          return v ? new Date(v).toISOString().slice(0, 10) : "—";
        },
      },
    ],
    [],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div className="space-y-3">
      <Input
        type="search"
        aria-label="Filter agencies"
        placeholder="Filter by name, domain, type, country, status…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="max-w-sm"
      />
      <Table>
        <THead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <TH key={h.id}>
                  {flexRender(h.column.columnDef.header, h.getContext())}
                </TH>
              ))}
            </tr>
          ))}
        </THead>
        <tbody>
          {table.getRowModel().rows.length === 0 ? (
            <tr>
              <TD colSpan={7} className="py-8 text-center text-slate-500">
                {rows.length === 0
                  ? "No agencies yet. Add one manually or import a CSV."
                  : "No agencies match this filter."}
              </TD>
            </tr>
          ) : (
            table.getRowModel().rows.map((r) => (
              <tr key={r.id}>
                {r.getVisibleCells().map((c) => (
                  <TD key={c.id}>
                    {flexRender(c.column.columnDef.cell, c.getContext())}
                  </TD>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </Table>
      <p className="text-xs text-slate-500" aria-live="polite">
        {table.getRowModel().rows.length} of {rows.length} shown. Rows with a
        synthetic badge use fictional `.example` domains (development fixtures).
      </p>
    </div>
  );
}
