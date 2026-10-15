"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";

/** Operator-triggered reconciliation: preview first (reads nothing into state), then run explicitly. */
export function ReconcilePanel() {
  const router = useRouter();
  const [consumer, setConsumer] = useState("operator");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function preview() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/qualification/reconcile", { method: "GET" });
      const body = (await res.json()) as { casesChecked: number; wouldDrift: string[]; orphaned: string[] };
      if (!res.ok) {
        setResult({ tone: "error", text: "Preview failed." });
      } else {
        setResult({
          tone: "success",
          text: `${body.casesChecked} cases checked: ${body.wouldDrift.length} would drift, ${body.orphaned.length} orphaned. Nothing written.`,
        });
      }
    } catch {
      setResult({ tone: "error", text: "Request failed." });
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/qualification/reconcile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consumer, idempotencyKey: key.trim() === "" ? undefined : key.trim() }),
      });
      const body = (await res.json()) as {
        code?: string;
        message?: string;
        consume?: { claimed: number; applied: number; rejected: number };
        backfill?: { checked: number; casesCreated: number };
        reconcile?: { casesChecked: number; drifted: number; orphaned: string[] };
      };
      if (!res.ok) {
        setResult({ tone: "error", text: `${body.code ?? "error"}: ${body.message ?? "refused"}` });
      } else {
        setResult({
          tone: "success",
          text: `consume claimed ${body.consume?.claimed}, applied ${body.consume?.applied}; backfill checked ${body.backfill?.checked}, created ${body.backfill?.casesCreated}; reconcile checked ${body.reconcile?.casesChecked}, drifted ${body.reconcile?.drifted}.`,
        });
        router.refresh();
      }
    } catch {
      setResult({ tone: "error", text: "Request failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3" aria-label="Reconciliation controls">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="r-consumer">Consumer name</Label>
          <Input id="r-consumer" value={consumer} onChange={(e) => setConsumer(e.target.value)} className="w-48" />
        </div>
        <div>
          <Label htmlFor="r-key">Idempotency key (optional)</Label>
          <Input id="r-key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="repeat safely" className="w-56" />
        </div>
        <Button type="button" disabled={busy || consumer.trim() === ""} onClick={preview}>
          Preview drift
        </Button>
        <Button type="button" disabled={busy || consumer.trim() === ""} onClick={run}>
          {busy ? "Working…" : "Run reconcile"}
        </Button>
      </div>
      {result && <Alert tone={result.tone === "success" ? "success" : "error"}>{result.text}</Alert>}
      <p className="text-xs text-slate-500">
        No scheduler exists — this panel is the trigger. Backfill runs inside the reconcile call; event
        consumption uses the named consumer&apos;s watermark.
      </p>
    </div>
  );
}
