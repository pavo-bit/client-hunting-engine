"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";

/** Operator workflow controls for one research task: status moves, due flag, notes. */
export function TaskControls({
  taskId,
  status,
  dueAt,
}: {
  taskId: string;
  status: string;
  dueAt: string | null;
}) {
  const router = useRouter();
  const [to, setTo] = useState(status === "open" ? "accepted" : status === "accepted" ? "done" : "open");
  const [due, setDue] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/qualification/research/${taskId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { code?: string; message?: string; status?: string };
      if (!res.ok) {
        setResult({ tone: "error", text: `${data.code ?? "error"}: ${data.message ?? "refused"}` });
      } else {
        setResult({ tone: "success", text: `Updated — status ${data.status}.` });
        router.refresh();
      }
    } catch {
      setResult({ tone: "error", text: "Request failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2" aria-label={`Research task controls ${taskId.slice(0, 8)}`}>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor={`t-status-${taskId}`}>Move to</Label>
          <select
            id={`t-status-${taskId}`}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="flex h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
          >
            {["open", "accepted", "done", "dismissed"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <Button type="button" disabled={busy} onClick={() => patch({ status: to, notes: notes.trim() || undefined })}>
          Move
        </Button>
        <div>
          <Label htmlFor={`t-due-${taskId}`}>
            Due flag{dueAt ? ` (now ${new Date(dueAt).toLocaleDateString()})` : " (none)"}
          </Label>
          <div className="flex gap-2">
            <Input id={`t-due-${taskId}`} type="date" value={due} onChange={(e) => setDue(e.target.value)} className="w-40" />
            <Button type="button" disabled={busy || due === ""} onClick={() => patch({ dueAt: new Date(`${due}T00:00:00Z`).toISOString() })}>
              Set
            </Button>
            {dueAt && (
              <Button type="button" disabled={busy} onClick={() => patch({ dueAt: null })}>
                Clear
              </Button>
            )}
          </div>
        </div>
      </div>
      <div>
        <Label htmlFor={`t-notes-${taskId}`}>Operator notes (sent with a status move)</Label>
        <Input id={`t-notes-${taskId}`} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="what was learned, where it is filed" />
      </div>
      {result && <Alert tone={result.tone === "success" ? "success" : "error"}>{result.text}</Alert>}
    </div>
  );
}
