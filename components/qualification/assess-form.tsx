"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";

/** Explicit assessment runner. Nothing runs until the operator submits; every version resolves explicitly. */
export function AssessForm({
  opportunityId,
  defaults,
}: {
  opportunityId?: string;
  defaults: { policy: string | null; catalog: string | null; rubric: string | null; capacity: string | null };
}) {
  const [opp, setOpp] = useState(opportunityId ?? "");
  const [policy, setPolicy] = useState(defaults.policy ?? "");
  const [catalog, setCatalog] = useState(defaults.catalog ?? "");
  const [rubric, setRubric] = useState(defaults.rubric ?? "");
  const [capacity, setCapacity] = useState(defaults.capacity ?? "");
  const [contact, setContact] = useState("");
  const [timeline, setTimeline] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string; detail?: string } | null>(null);

  const uuidOk = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opp);
  const valid = uuidOk && policy !== "" && catalog !== "" && rubric !== "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const answers: Record<string, unknown> = {};
      if (contact !== "") answers.contactChannelKnown = contact === "yes";
      if (timeline !== "") {
        const n = Number.parseInt(timeline, 10);
        if (Number.isFinite(n) && n >= 0) answers.timelineMonths = n;
      }
      const res = await fetch("/api/qualification/assess", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          opportunityId: opp,
          policyVersion: policy,
          catalogVersion: catalog,
          rubricVersion: rubric,
          capacityVersion: capacity === "" ? null : capacity,
          operatorAnswers: answers,
          asOf: new Date().toISOString(),
          idempotencyKey: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`,
        }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        setResult({ tone: "error", text: `${String(body.code ?? "error")}: ${String(body.message ?? "refused")}` });
      } else {
        setResult({
          tone: "success",
          text: `Recorded v${String(body.version)} — outcome ${String(body.outcome)}, composite ${String(body.composite ?? "none")}, band ${String(body.band ?? "none")}${body.replayed ? " (replayed)" : ""}.`,
          detail: `assessment ${String(body.assessmentId)} · case ${String(body.caseId)}`,
        });
      }
    } catch {
      setResult({ tone: "error", text: "Request failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Run assessment">
      <div>
        <Label htmlFor="a-opp">Opportunity id (uuid)</Label>
        <Input id="a-opp" value={opp} onChange={(e) => setOpp(e.target.value.trim())} placeholder="opportunity uuid from Discovery" />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="a-policy">Policy version (active)</Label>
          <Input id="a-policy" value={policy} onChange={(e) => setPolicy(e.target.value.trim())} placeholder="required — never defaulted" />
        </div>
        <div>
          <Label htmlFor="a-catalog">Catalog version (active)</Label>
          <Input id="a-catalog" value={catalog} onChange={(e) => setCatalog(e.target.value.trim())} placeholder="required — never defaulted" />
        </div>
        <div>
          <Label htmlFor="a-rubric">Rubric version (active)</Label>
          <Input id="a-rubric" value={rubric} onChange={(e) => setRubric(e.target.value.trim())} placeholder="required — never defaulted" />
        </div>
        <div>
          <Label htmlFor="a-cap">Capacity version (optional)</Label>
          <Input id="a-cap" value={capacity} onChange={(e) => setCapacity(e.target.value.trim())} placeholder="optional — order-only when set" />
        </div>
        <div>
          <Label htmlFor="a-contact">Contact channel known? (operator answer)</Label>
          <select id="a-contact" value={contact} onChange={(e) => setContact(e.target.value)} className="flex h-9 rounded-md border border-slate-300 bg-white px-2 text-sm">
            <option value="">unknown (missing, never assumed)</option>
            <option value="yes">yes</option>
            <option value="no">no</option>
          </select>
        </div>
        <div>
          <Label htmlFor="a-timeline">Timeline months (operator answer)</Label>
          <Input id="a-timeline" value={timeline} onChange={(e) => setTimeline(e.target.value)} placeholder="unknown (missing, never assumed)" />
        </div>
      </div>
      <Button type="submit" disabled={!valid || busy}>
        {busy ? "Assessing…" : "Run assessment"}
      </Button>
      {result && (
        <Alert tone={result.tone === "success" ? "success" : "error"}>
          {result.text}
          {result.detail && <span className="block font-mono text-xs">{result.detail}</span>}
        </Alert>
      )}
    </form>
  );
}
