"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";

const STATES = ["draft", "needs_owner_review", "approved"] as const;

/** Approval-state change with rationale (audited). Content stays owner-owned. */
export function CatalogStatusButton({ capKey, current }: { capKey: string; current: string }) {
  const router = useRouter();
  const [status, setStatus] = useState(current);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/catalog/${encodeURIComponent(capKey)}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, reason }),
      });
      const data = (await res.json()) as { message?: string; code?: string };
      if (res.status === 200) router.refresh();
      else setMsg(`Error ${res.status}: ${String(data.message ?? "")}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <select
        value={status}
        onChange={(e) => setStatus(e.target.value)}
        aria-label={`Approval state for ${capKey}`}
        className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs"
      >
        {STATES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <Input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Rationale (required)"
        aria-label="Rationale"
        className="h-8 w-44 text-xs"
      />
      <Button size="sm" variant="outline" disabled={busy || reason.trim() === ""} onClick={submit}>
        Set
      </Button>
      {msg && <Alert tone="error">{msg}</Alert>}
    </span>
  );
}
