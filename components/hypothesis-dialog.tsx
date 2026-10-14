"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";

const DECISIONS = ["validate", "defer", "reject", "request_evidence", "supersede"] as const;

/**
 * Human review decision. Validation records the reviewer's judgment on
 * documented information — it never proves the company's internal problem.
 */
export function HypothesisDecisionDialog({ hypothesisId }: { hypothesisId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<string>("validate");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/hypotheses/${hypothesisId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reason }),
      });
      const data = (await res.json()) as { message?: string; code?: string };
      if (res.status === 200) {
        setOpen(false);
        router.refresh();
      } else {
        setError(`Error ${res.status} (${String(data.code ?? "")}): ${String(data.message ?? "")}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Decide
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Record review decision</DialogTitle>
        <DialogDescription>
          Your decision and rationale are stored permanently with your name.
          Validating means you judge the hypothesis worth pursuing on the
          documented evidence — not that the problem is proven.
        </DialogDescription>
        <div>
          <Label htmlFor={`hyp-dec-${hypothesisId}`}>Decision</Label>
          <select
            id={`hyp-dec-${hypothesisId}`}
            value={decision}
            onChange={(e) => setDecision(e.target.value)}
            className="flex h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
          >
            {DECISIONS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor={`hyp-why-${hypothesisId}`}>Rationale (required)</Label>
          <Input
            id={`hyp-why-${hypothesisId}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What did you review, and why this decision?"
          />
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={busy || reason.trim() === ""} onClick={submit}>
            {busy ? "Recording…" : "Record decision"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Explicit generation run for one company (never runs inside intake). */
export function HypothesisGenerateButton({ companyId }: { companyId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/hypotheses/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId }),
      });
      const data = (await res.json()) as {
        hypotheses?: { ruleId: string; status: string; created: boolean }[];
        noSupportedHypothesis?: boolean;
        message?: string;
      };
      if (res.status === 200) {
        setResult(
          data.noSupportedHypothesis
            ? "Insufficient evidence for a credible hypothesis — nothing generated (by design)."
            : `Evaluated: ${(data.hypotheses ?? []).map((h) => `${h.ruleId} (${h.status}${h.created ? ", new" : ""})`).join("; ") || "no rows"}`,
        );
        router.refresh();
      } else {
        setResult(`Error ${res.status}: ${String(data.message ?? "")}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-2">
      <Button type="button" variant="outline" disabled={busy} onClick={run}>
        {busy ? "Evaluating…" : "Generate hypotheses"}
      </Button>
      {result && (
        <Alert tone={result.startsWith("Error") ? "error" : "info"}>{result}</Alert>
      )}
    </span>
  );
}
