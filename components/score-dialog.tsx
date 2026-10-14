"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/card";

/** Explicit score_v1 evaluation run (gated; ineligible hypotheses get no row). */
export function ScoreEvaluateButton({ hypothesisId }: { hypothesisId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/scores/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hypothesisId }),
      });
      const data = (await res.json()) as {
        total?: number;
        band?: string;
        message?: string;
        code?: string;
      };
      if (res.status === 201) {
        setResult(`Scored ${data.total} (${data.band}) — see Ranking for why.`);
        router.refresh();
      } else {
        setResult(`Not scored (${res.status}): ${String(data.message ?? data.code ?? "")}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-2">
      <Button type="button" variant="outline" disabled={busy} onClick={run}>
        {busy ? "Scoring…" : "Evaluate score"}
      </Button>
      {result && (
        <Alert tone={result.startsWith("Not scored") ? "error" : "info"}>{result}</Alert>
      )}
    </span>
  );
}
