"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Downloads the CURRENT filtered directory via GET /api/export, which applies
 * the same filter parser and SQL builder as the page. The export is therefore
 * a download of exactly what is on screen, not a separate report.
 */
export function ExportButton({ query }: { query: string }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function download(format: "csv" | "json") {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const sep = query.includes("?") ? "&" : "?";
      const res = await fetch(`/api/export${sep}${query}${query ? "&" : ""}format=${format}`, {
        headers: { accept: format === "csv" ? "text/csv" : "application/json" },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
        setNote(`${body.code ?? "error"}: ${body.message ?? "export failed"}`);
        return;
      }
      const capped = res.headers.get("X-Export-Capped") === "true";
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `agencies-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNote(
        capped
          ? "Exported, but the row cap was reached — narrow the filters for a complete file."
          : "Exported the current filtered view.",
      );
    } catch {
      setNote("Export failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="secondary" disabled={busy} onClick={() => download("csv")}>
        {busy ? "Preparing…" : "Export CSV"}
      </Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={() => download("json")}>
        JSON
      </Button>
      {note && (
        <span className="text-xs text-slate-600" role="status" aria-live="polite">
          {note}
        </span>
      )}
    </div>
  );
}