"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";

/** Manual planned-refresh starter. Explicit operator action; no scheduling,
 *  no autonomy. One task row per query; thresholds optional and explicit. */
export function RefreshPlanForm() {
  const router = useRouter();
  const [queries, setQueries] = useState<string[]>([""]);
  const [lowYield, setLowYield] = useState("");
  const [concCap, setConcCap] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const valid =
    queries.some((q) => q.trim().length > 0) &&
    queries.length <= 25 &&
    (lowYield === "" || /^\d+$/.test(lowYield)) &&
    (concCap === "" || /^\d+$/.test(concCap));

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const tasks = queries
        .map((q) => q.trim())
        .filter((q) => q.length > 0)
        .map((queryText) => ({ adapterId: "gleif-lei", queryText }));
      const stop =
        lowYield !== "" && concCap !== ""
          ? { lowYieldStreak: Number.parseInt(lowYield, 10), concentrationCap: Number.parseInt(concCap, 10) }
          : undefined;
      const res = await fetch("/api/discovery/refreshes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks, ...(stop ? { stop } : {}) }),
      });
      const data = (await res.json()) as {
        runId?: string;
        status?: string;
        tasksPlanned?: number;
        tasksDone?: number;
        code?: string;
        message?: string;
      };
      if (res.status === 201 && data.runId) {
        setResult({
          tone: "success",
          text: `Refresh ${data.status}: ${data.tasksDone}/${data.tasksPlanned} tasks done.`,
        });
        router.push(`/discovery?refresh=${data.runId}`);
        router.refresh();
      } else {
        setResult({ tone: "error", text: `Error ${res.status}: ${String(data.message ?? data.code)}` });
      }
    } catch {
      setResult({ tone: "error", text: "Network error — the refresh may still be running; check history." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={start} className="flex max-w-xl flex-col gap-3" noValidate>
      {queries.map((q, i) => (
        <div key={i} className="flex items-end gap-2">
          <div className="flex-1">
            <Label htmlFor={`rq${i}`}>Query {i + 1} (GLEIF full-text)</Label>
            <Input
              id={`rq${i}`}
              value={q}
              onChange={(e) =>
                setQueries((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
              }
              placeholder="e.g. Acme Webworks"
              maxLength={200}
            />
          </div>
          {queries.length > 1 && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setQueries((prev) => prev.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          )}
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={queries.length >= 25}
          onClick={() => setQueries((prev) => [...prev, ""])}
        >
          Add query (up to 25 tasks)
        </Button>
      </div>
      <div className="flex gap-3">
        <div>
          <Label htmlFor="rq-low">Low-yield stop streak (optional, no default)</Label>
          <Input
            id="rq-low"
            value={lowYield}
            onChange={(e) => setLowYield(e.target.value)}
            placeholder="e.g. 3"
            inputMode="numeric"
          />
        </div>
        <div>
          <Label htmlFor="rq-cap">Concentration cap (optional, no default)</Label>
          <Input
            id="rq-cap"
            value={concCap}
            onChange={(e) => setConcCap(e.target.value)}
            placeholder="e.g. 5"
            inputMode="numeric"
          />
        </div>
      </div>
      <p className="text-xs text-slate-500">
        Synchronous manual refresh: runs in request scope, then reports.
        Stopping thresholds are yours to state — the system invents none.
      </p>
      <div>
        <Button type="submit" disabled={!valid || busy}>
          {busy ? "Running refresh…" : "Start manual refresh"}
        </Button>
      </div>
      {result && (
        <Alert tone={result.tone === "success" ? "success" : "error"}>{result.text}</Alert>
      )}
    </form>
  );
}
