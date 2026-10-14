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

const DECISIONS = ["submit", "request_info", "accept", "reject", "archive"] as const;

/**
 * Review decision. "Accepted" means Grayscales pursues internally — never
 * client acceptance. Rationale required; terminal states stay decided.
 */
export function ProposalDecisionDialog({ proposalId }: { proposalId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<string>("submit");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/decision`, {
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
        <DialogTitle>Record proposal decision</DialogTitle>
        <DialogDescription>
          Submit for review, request information, accept for internal pursuit,
          reject, or archive. “Accepted” never means the client agreed.
        </DialogDescription>
        <div>
          <Label htmlFor={`prop-dec-${proposalId}`}>Decision</Label>
          <select
            id={`prop-dec-${proposalId}`}
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
          <Label htmlFor={`prop-why-${proposalId}`}>Rationale (required)</Label>
          <Input
            id={`prop-why-${proposalId}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why this decision?"
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
