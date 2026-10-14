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
import { CLAIM_STATUSES } from "@/lib/evidence/assessment";

/**
 * Human assessment dialog. Verified/disputed/withdrawn/superseded are
 * human-only; automatic promotion is limited to corroborated (server
 * enforced). Rationale always required. This only records an assessment —
 * it never fetches external facts.
 */
export function AssessDialog({ claimId, current }: { claimId: string; current: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("verified");
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flagBusy, setFlagBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/assess`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, rationale }),
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

  async function flag() {
    setFlagBusy(true);
    try {
      await fetch(`/api/claims/${claimId}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flag: true, reason: rationale || "flagged for review from claim page" }),
      });
      router.refresh();
    } finally {
      setFlagBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Assess
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Record assessment (currently {current})</DialogTitle>
        <DialogDescription>
          Your decision, rationale, and identity are stored permanently.
          Verified requires human judgment — the system never self-verifies.
        </DialogDescription>
        <div>
          <Label htmlFor={`assess-to-${claimId}`}>New status</Label>
          <select
            id={`assess-to-${claimId}`}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="flex h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
          >
            {CLAIM_STATUSES.filter((s) => s !== current).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor={`assess-why-${claimId}`}>Rationale (required)</Label>
          <Input
            id={`assess-why-${claimId}`}
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="Why is this assessment justified?"
          />
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={flagBusy} onClick={flag}>
            Flag for review
          </Button>
          <Button disabled={busy || rationale.trim() === ""} onClick={submit}>
            {busy ? "Recording…" : "Record assessment"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
