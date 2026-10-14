"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert, Badge } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";

const STAGES = [
  "research",
  "qualified",
  "ready_for_outreach",
  "contacted",
  "responded",
  "discovery",
  "proposal_talk",
  "won",
  "lost",
  "disqualified",
  "on_hold",
] as const;

const OUTCOMES = [
  "no_reply",
  "replied",
  "positive_response",
  "negative_response",
  "referral",
  "meeting",
  "discovery_meeting",
  "proposal",
  "won",
  "lost",
  "disqualified",
  "on_hold",
] as const;

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

/** Pipeline stage recorder. Stages describe observed reality — selecting
 *  "ready_for_outreach" sends nothing and notifies nobody. */
export function PipelineDialog({ briefRef }: { briefRef: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<string>("qualified");
  const [note, setNote] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { status, data } = await postJson(`/api/briefs/${briefRef}/pipeline`, {
        stage,
        note,
        nextAction: nextAction || undefined,
        followUpDate: followUp || undefined,
      });
      if (status === 200) {
        setOpen(false);
        router.refresh();
      } else {
        setError(`Error ${status} (${String(data.code ?? "")}): ${String(data.message ?? "")}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Update pipeline
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Record pipeline stage</DialogTitle>
        <DialogDescription>
          What actually happened, in your words. This writes history — it
          sends no messages and notifies nobody.
        </DialogDescription>
        <div>
          <Label htmlFor={`pl-stage-${briefRef}`}>Stage</Label>
          <select
            id={`pl-stage-${briefRef}`}
            value={stage}
            onChange={(e) => setStage(e.target.value)}
            className="flex h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
          >
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor={`pl-note-${briefRef}`}>Explanation (required)</Label>
          <Input id={`pl-note-${briefRef}`} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor={`pl-next-${briefRef}`}>Next action</Label>
            <Input id={`pl-next-${briefRef}`} value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="No automatic reminders" />
          </div>
          <div>
            <Label htmlFor={`pl-fu-${briefRef}`}>Follow-up date</Label>
            <Input id={`pl-fu-${briefRef}`} type="date" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
          </div>
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={busy || note.trim() === ""} onClick={submit}>
            {busy ? "Recording…" : "Record stage"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Manual outcome recorder. Observed events only — nothing inferred or synced. */
export function OutcomeForm({ briefRef }: { briefRef: string }) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<string>("no_reply");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const { status, data } = await postJson(`/api/briefs/${briefRef}/outcomes`, {
        outcome,
        note: note || undefined,
      });
      if (status === 201) {
        setResult({ tone: "success", text: "Outcome recorded." });
        setNote("");
        router.refresh();
      } else {
        setResult({ tone: "error", text: `Error ${status}: ${String(data.message ?? "")}` });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-2">
      <div className="flex gap-2">
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          aria-label="Outcome"
          className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
        >
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What actually happened (optional note)"
          aria-label="Outcome note"
        />
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Record"}
        </Button>
      </div>
      {result && (
        <Alert tone={result.tone === "success" ? "success" : "error"}>{result.text}</Alert>
      )}
    </form>
  );
}

/** Brief review decision dialog. */
export function BriefDecisionDialog({ briefRef }: { briefRef: string }) {
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
      const { status, data } = await postJson(`/api/briefs/${briefRef}/decision`, {
        decision,
        reason,
      });
      if (status === 200) {
        setOpen(false);
        router.refresh();
      } else {
        setError(`Error ${status} (${String(data.code ?? "")}): ${String(data.message ?? "")}`);
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
        <DialogTitle>Record brief decision</DialogTitle>
        <DialogDescription>
          Rationale required. “Approved” means ready for internal pursuit —
          never client acceptance.
        </DialogDescription>
        <div>
          <Label htmlFor={`br-dec-${briefRef}`}>Decision</Label>
          <select
            id={`br-dec-${briefRef}`}
            value={decision}
            onChange={(e) => setDecision(e.target.value)}
            className="flex h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
          >
            {["submit", "approve", "request_info", "reject", "archive"].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor={`br-why-${briefRef}`}>Rationale (required)</Label>
          <Input id={`br-why-${briefRef}`} value={reason} onChange={(e) => setReason(e.target.value)} />
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

export function StageBadge({ stage }: { stage: string | null }) {
  if (!stage) return <span className="text-slate-400">—</span>;
  const tone =
    stage === "won"
      ? "success"
      : stage === "lost" || stage === "disqualified"
        ? "danger"
        : stage === "on_hold"
          ? "warning"
          : "info";
  return <Badge variant={tone as "success" | "danger" | "warning" | "info"}>{stage}</Badge>;
}
