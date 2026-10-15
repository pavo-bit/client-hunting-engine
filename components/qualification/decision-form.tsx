"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";

/** Human review decision. Every rule is backend-enforced; this form only collects the inputs. */
export function DecisionForm({ caseId, assessments }: { caseId: string; assessments: { assessment_id: string; version: number }[] }) {
  const router = useRouter();
  const [type, setType] = useState("accepted");
  const [assessmentId, setAssessmentId] = useState(assessments[assessments.length - 1]?.assessment_id ?? "");
  const [reason, setReason] = useState("");
  const [resumeAt, setResumeAt] = useState("");
  const [resumeCondition, setResumeCondition] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const valid =
    (type === "withdrawn" || assessmentId !== "") &&
    reason.trim().length > 0 &&
    (type !== "deferred" || resumeAt !== "" || resumeCondition.trim() !== "");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/qualification/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caseId,
          assessmentId: type === "withdrawn" && assessmentId === "" ? null : assessmentId || null,
          type,
          reason: reason.trim(),
          resumeAt: resumeAt || undefined,
          resumeCondition: resumeCondition.trim() || undefined,
        }),
      });
      const body = (await res.json()) as { code?: string; message?: string; decision?: string };
      if (!res.ok) {
        setResult({ tone: "error", text: `${body.code ?? "error"}: ${body.message ?? "refused"}` });
      } else {
        setResult({ tone: "success", text: `Recorded: ${body.decision}. Refreshing…` });
        router.refresh();
      }
    } catch {
      setResult({ tone: "error", text: "Request failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Record review decision">
      <div className="flex flex-wrap gap-3">
        <div>
          <Label htmlFor="d-type">Decision</Label>
          <select id="d-type" value={type} onChange={(e) => setType(e.target.value)} className="flex h-9 rounded-md border border-slate-300 bg-white px-2 text-sm">
            <option value="accepted">accepted — pursue</option>
            <option value="rejected">rejected — not a fit / park</option>
            <option value="deferred">deferred — postpone with resume condition</option>
            <option value="withdrawn">withdrawn — leave pursuit</option>
          </select>
        </div>
        <div>
          <Label htmlFor="d-assessment">Assessment cited</Label>
          <select id="d-assessment" value={assessmentId} onChange={(e) => setAssessmentId(e.target.value)} className="flex h-9 rounded-md border border-slate-300 bg-white px-2 text-sm">
            <option value="">—</option>
            {assessments.map((a) => (
              <option key={a.assessment_id} value={a.assessment_id}>v{a.version} ({a.assessment_id.slice(0, 8)})</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <Label htmlFor="d-reason">Reason (required — recorded verbatim)</Label>
        <Input id="d-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why this decision, in plain words" />
      </div>
      {type === "deferred" && (
        <div className="flex flex-wrap gap-3">
          <div>
            <Label htmlFor="d-resume-at">Resume at (ISO date)</Label>
            <Input id="d-resume-at" type="date" value={resumeAt} onChange={(e) => setResumeAt(e.target.value)} />
          </div>
          <div className="flex-1">
            <Label htmlFor="d-resume-cond">Resume condition (or date required)</Label>
            <Input id="d-resume-cond" value={resumeCondition} onChange={(e) => setResumeCondition(e.target.value)} placeholder="e.g. budget cycle confirmed" />
          </div>
        </div>
      )}
      <Button type="submit" disabled={!valid || busy}>
        {busy ? "Recording…" : "Record decision"}
      </Button>
      {result && <Alert tone={result.tone === "success" ? "success" : "error"}>{result.text}</Alert>}
      <p className="text-xs text-slate-500">
        Backend-enforced: suppressed and gate-rejected cases cannot be accepted; stale assessments cannot back
        accept/defer; concurrent same-assessment decisions conflict.
      </p>
    </form>
  );
}
