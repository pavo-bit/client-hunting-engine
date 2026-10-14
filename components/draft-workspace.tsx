"use client";

// Draft workspace: list versions, create, revise, approve. Copy-only:
// approval means "ready for a human to copy", and the application has no
// mechanism to deliver text anywhere.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CopyButton } from "@/components/copy-button";

export interface DraftRow {
  id: string;
  channel: string;
  status: string;
  version: number;
  subject: string | null;
  body: string;
  unverified_points: string | null;
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

function DraftActions({ draft, briefRef }: { draft: DraftRow; briefRef: string }) {
  const router = useRouter();
  const [reviseOpen, setReviseOpen] = useState(false);
  const [body, setBody] = useState(draft.body);
  const [unverified, setUnverified] = useState(draft.unverified_points ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function revise() {
    setBusy(true);
    setMsg(null);
    try {
      const { status, data } = await postJson(`/api/drafts/${draft.id}/revise`, {
        body,
        unverifiedPoints: unverified,
      });
      if (status === 201) router.refresh();
      else setMsg(`Error ${status}: ${String(data.message ?? "")}`);
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "submit" | "approve") {
    setBusy(true);
    setMsg(null);
    try {
      const { status, data } = await postJson(`/api/drafts/${draft.id}/decision`, {
        decision,
        reason: decision === "approve" ? "reviewed: claims trace to brief evidence" : "sent for review",
      });
      if (status === 200) router.refresh();
      else setMsg(`Error ${status} (${String(data.code ?? "")}): ${String(data.message ?? "")}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <CopyButton text={draft.body} label={`Copy draft v${draft.version}`} />
      <Dialog open={reviseOpen} onOpenChange={setReviseOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline" disabled={draft.status === "ready"}>
            Revise
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Revise draft (creates v{draft.version + 1})</DialogTitle>
          <DialogDescription>
            Edits create a new version; history is preserved. Clear the
            unverified field to resolve flagged assertions.
          </DialogDescription>
          <div>
            <Label htmlFor={`rev-body-${draft.id}`}>Body</Label>
            <Input id={`rev-body-${draft.id}`} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <div>
            <Label htmlFor={`rev-unv-${draft.id}`}>Unverified assertions (blocks approval while set)</Label>
            <Input
              id={`rev-unv-${draft.id}`}
              value={unverified}
              onChange={(e) => setUnverified(e.target.value)}
              placeholder="Empty means every claim traces to evidence"
            />
          </div>
          {msg && <Alert tone="error">{msg}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setReviseOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || body.trim() === ""} onClick={revise}>
              {busy ? "Saving…" : "Save new version"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {draft.status === "draft" && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => decide("submit")}>
          Submit
        </Button>
      )}
      {draft.status === "in_review" && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => decide("approve")}>
          Approve
        </Button>
      )}
      {msg && !reviseOpen && <Alert tone="error">{msg}</Alert>}
    </div>
  );
}

export function DraftWorkspace({ briefRef, drafts }: { briefRef: string; drafts: DraftRow[] }) {
  const router = useRouter();
  const [formOpen, setFormOpen] = useState(false);
  const [channel, setChannel] = useState("email");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [unverified, setUnverified] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setMsg(null);
    try {
      const { status, data } = await postJson("/api/drafts", {
        briefRef,
        channel,
        subject: subject || undefined,
        body,
        unverifiedPoints: unverified || undefined,
      });
      if (status === 201) {
        setFormOpen(false);
        setSubject("");
        setBody("");
        setUnverified("");
        router.refresh();
      } else {
        setMsg(`Error ${status}: ${String(data.message ?? "")}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Outreach drafts ({drafts.length}) — copy-only, never sent</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {drafts.length === 0 && (
          <p className="text-sm text-slate-500">
            No drafts yet. Drafts ground personalization in brief evidence; a human copies and sends them independently.
          </p>
        )}
        {drafts.map((d) => (
          <div key={d.id} className="space-y-2 rounded-md border border-slate-200 p-3">
            <p className="text-sm">
              <strong>v{d.version} · {d.channel}</strong>{" "}
              <Badge variant={d.status === "ready" ? "success" : "info"}>{d.status}</Badge>{" "}
              {d.unverified_points && <Badge variant="warning">unverified assertions — approval blocked</Badge>}
            </p>
            {d.subject && <p className="text-sm text-slate-600">Subject: {d.subject}</p>}
            <pre className="whitespace-pre-wrap font-sans text-sm">{d.body}</pre>
            {d.unverified_points && (
              <p className="text-xs text-amber-800">Needs verification: {d.unverified_points}</p>
            )}
            <DraftActions draft={d} briefRef={briefRef} />
          </div>
        ))}
        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline">
              New draft
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogTitle>New outreach draft</DialogTitle>
            <DialogDescription>
              Use only traceable facts from the brief. List anything unproven
              as unverified — approval stays blocked until resolved.
            </DialogDescription>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="nd-channel">Channel</Label>
                <select
                  id="nd-channel"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
                >
                  {["email", "dm", "contact_form", "note"].map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="nd-subject">Subject</Label>
                <Input id="nd-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
              </div>
            </div>
            <div>
              <Label htmlFor="nd-body">Body</Label>
              <Input id="nd-body" value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="nd-unv">Unverified assertions (optional, blocks approval)</Label>
              <Input id="nd-unv" value={unverified} onChange={(e) => setUnverified(e.target.value)} />
            </div>
            {msg && <Alert tone="error">{msg}</Alert>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setFormOpen(false)}>
                Cancel
              </Button>
              <Button disabled={busy || body.trim() === ""} onClick={create}>
                {busy ? "Saving…" : "Save draft"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
