"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/card";

/** Explicit resolution run for one company (never runs inside intake). */
export function ResolveButton({ companyId }: { companyId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId }),
      });
      const data = (await res.json()) as {
        skipped?: string | null;
        candidates?: unknown[];
        autoMerged?: { summary: string }[];
      };
      if (res.status === 200) {
        const parts: string[] = [];
        if (data.skipped) parts.push(data.skipped);
        parts.push(`${data.candidates?.length ?? 0} candidate(s)`);
        for (const m of data.autoMerged ?? []) parts.push(`auto-merged: ${m.summary}`);
        setResult(parts.join("; "));
        router.refresh();
      } else {
        setResult(`Error ${res.status}: ${String((data as { message?: string }).message ?? "")}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-2">
      <Button type="button" variant="outline" disabled={busy} onClick={run}>
        {busy ? "Resolving…" : "Run resolution"}
      </Button>
      {result && (
        <Alert tone={result.startsWith("Error") ? "error" : "info"}>{result}</Alert>
      )}
    </span>
  );
}
