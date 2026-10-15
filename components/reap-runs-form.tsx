"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";

interface Candidate {
  id: string;
  adapterId: string;
  startedAt: string;
  ageMinutes: number;
}

interface ReapResponse {
  dryRun: boolean;
  staleAfterMinutes: number;
  considered: Candidate[];
  reaped: { runId: string; tasksFailed: number }[];
  code?: string;
  message?: string;
}

/**
 * Crashed/stalled run recovery (B-D6). Operator-triggered, explicit threshold
 * (no default is invented), dry-run first. No scheduler, no resume: reaped
 * runs become `failed` with a reason and stay in history.
 */
export function ReapRunsForm() {
  const router = useRouter();
  const [minutes, setMinutes] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReapResponse | null>(null);
  const valid = /^\d+$/.test(minutes) && Number.parseInt(minutes, 10) >= 1;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/discovery/reap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staleAfterMinutes: Number.parseInt(minutes, 10), dryRun }),
      });
      const data = (await res.json()) as ReapResponse;
      setResult(data);
      if (res.ok && !data.dryRun) router.refresh();
    } catch {
      setResult({ dryRun, staleAfterMinutes: 0, considered: [], reaped: [], message: "network error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-3" noValidate>
      <div>
        <Label htmlFor="reap-min">
          Runs still &quot;running&quot; after (minutes) — you state this; the system has no default
        </Label>
        <Input
          id="reap-min"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          placeholder="e.g. 120"
          inputMode="numeric"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
        Dry run first (list candidates, change nothing)
      </label>
      <div>
        <Button type="submit" variant={dryRun ? "outline" : "default"} disabled={!valid || busy}>
          {busy ? "Working…" : dryRun ? "List stale runs" : "Reap stale runs"}
        </Button>
      </div>
      {result && (
        <Alert tone={result.code ? "error" : result.reaped.length > 0 ? "success" : "info"}>
          {result.code
            ? `Error ${result.code}: ${String(result.message)}`
            : `${result.dryRun ? "Dry run: " : "Reaped "}${result.considered.length} stale run(s) older than ${result.staleAfterMinutes} min.` +
              (result.dryRun
                ? ""
                : ` Closed ${result.reaped.length}; tasks marked failed: ${result.reaped.reduce((n, r) => n + r.tasksFailed, 0)}.`) +
              (result.considered.length > 0 && result.dryRun
                ? " " + result.considered.map((c) => `${c.adapterId} (${c.ageMinutes}m)`).join(", ")
                : "")}
        </Alert>
      )}
    </form>
  );
}