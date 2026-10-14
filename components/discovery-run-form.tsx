"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";

interface RunCounts {
  found: number;
  new: number;
  duplicates: number;
  skipped: number;
  conflicts: number;
  failed: number;
}

/** Bounded discovery run starter. Synchronous; no scheduler, no resume. */
export function DiscoveryRunForm() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/discovery/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, limit: 10, maxPages: 3 }),
      });
      const data = (await res.json()) as {
        runId?: string;
        status?: string;
        counts?: RunCounts;
        error?: string | null;
        code?: string;
        message?: string;
      };
      if (res.status === 200 && data.runId) {
        const c = data.counts!;
        setResult({
          tone: data.status === "failed" ? "error" : "success",
          text: `Run ${data.status}: found=${c.found} new=${c.new} duplicates=${c.duplicates} skipped=${c.skipped} conflicts=${c.conflicts} failed=${c.failed}${data.error ? ` — ${data.error}` : ""}`,
        });
        router.refresh();
      } else {
        setResult({ tone: "error", text: `Error ${res.status}: ${String(data.message ?? data.code)}` });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={start} className="flex max-w-xl flex-col gap-3" noValidate>
      <div>
        <Label htmlFor="dq">Entity name search (GLEIF full-text, required)</Label>
        <Input
          id="dq"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. KOTZILLA"
          minLength={1}
          maxLength={200}
          required
        />
      </div>
      <p className="text-xs text-slate-500">
        Bounded: 10 records/page, up to 3 pages, 120s timeout. Reruns are
        idempotent (stable source-record identity).
      </p>
      <div>
        <Button type="submit" disabled={busy || text.trim().length < 1}>
          {busy ? "Running…" : "Start bounded run"}
        </Button>
      </div>
      {result && (
        <Alert tone={result.tone === "success" ? "success" : "error"}>{result.text}</Alert>
      )}
    </form>
  );
}
