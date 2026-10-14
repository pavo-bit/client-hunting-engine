"use client";

// Human decision dialog for one duplicate candidate. Accepting merges
// (older record wins) after explicit confirmation; reason is required to
// reject or defer; conflicting registries need an explicit override tick.

import { useEffect, useState } from "react";
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

interface PreviewData {
  winner: { id: string; name: string };
  loser: { id: string; name: string };
  moves: Record<string, number>;
  stays: string[];
}

export function DecisionDialog({
  candidateId,
  names,
  conflicting,
  linkedRows,
}: {
  candidateId: string;
  names: string;
  conflicting: boolean;
  linkedRows: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [allowConflict, setAllowConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    fetch(`/api/candidates/${candidateId}/preview`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setPreview(d as PreviewData);
      })
      .catch(() => setPreview(null));
  }, [open, candidateId]);

  async function decide(decision: "accepted" | "rejected" | "deferred") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reason, allowConflict }),
      });
      const data = (await res.json()) as { message?: string; code?: string; summary?: string };
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
        <DialogTitle>Decide duplicate</DialogTitle>
        <DialogDescription>
          {names} — accepting merges both records (older wins). This cannot be
          undone except by restoring from backup.
        </DialogDescription>
        {preview ? (
          <div className="rounded-md bg-slate-50 p-3 text-sm">
            <p>
              <strong>Winner (kept):</strong> {preview.winner.name}
            </p>
            <p>
              <strong>Loser (archived + aliased):</strong> {preview.loser.name}
            </p>
            <ul className="mt-1 list-disc pl-5">
              {Object.entries(preview.moves).map(([t, n]) => (
                <li key={t}>
                  {t}: {n} row{n === 1 ? "" : "s"} move{n === 1 ? "" : ""}
                </li>
              ))}
            </ul>
            {preview.stays.map((s) => (
              <p key={s} className="mt-1 text-xs text-slate-600">
                {s}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-500">Loading merge impact…</p>
        )}
        {conflicting && (
          <Alert tone="error">
            Conflicting registry IDs: automatic merging was blocked. Accepting
            requires the override below and will be recorded in the audit log.
          </Alert>
        )}
        <div>
          <Label htmlFor={`reason-${candidateId}`}>Reason (required to reject or defer)</Label>
          <Input
            id={`reason-${candidateId}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. same domain, confirmed same legal entity"
          />
        </div>
        {conflicting && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allowConflict}
              onChange={(e) => setAllowConflict(e.target.checked)}
            />
            Override registry conflict (recorded)
          </label>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={() => decide("deferred")}>
            Defer
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => decide("rejected")}>
            Reject
          </Button>
          <Button disabled={busy} onClick={() => decide("accepted")}>
            {busy ? "Working…" : "Accept + merge"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
