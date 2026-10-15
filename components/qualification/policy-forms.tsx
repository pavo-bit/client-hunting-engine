"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";

/** Policy version lifecycle: lint/dry-run a definition, store a draft, publish or retire explicitly. */
export function PolicyForms() {
  const router = useRouter();
  const [kind, setKind] = useState("policy");
  const [version, setVersion] = useState("");
  const [definition, setDefinition] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function act(action: "lint" | "draft" | "publish" | "retire") {
    setBusy(true);
    setResult(null);
    try {
      let parsed: unknown = {};
      if (action === "lint" || action === "draft") {
        try {
          parsed = JSON.parse(definition);
        } catch {
          setResult({ tone: "error", text: "definition is not valid JSON." });
          setBusy(false);
          return;
        }
      }
      const res = await fetch("/api/qualification/policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, kind, version: version.trim(), definition: parsed }),
      });
      const body = (await res.json()) as { ok?: boolean; problems?: string[]; code?: string; message?: string; status?: string };
      if (!res.ok || body.ok === false) {
        const detail = body.problems ? body.problems.join("; ") : `${body.code ?? "error"}: ${body.message ?? "refused"}`;
        setResult({ tone: "error", text: detail });
      } else if (action === "lint") {
        setResult({ tone: "success", text: "Lint passed — structure valid. Linting never activates." });
      } else {
        setResult({ tone: "success", text: `${version} is now ${body.status}.` });
        router.refresh();
      }
    } catch {
      setResult({ tone: "error", text: "Request failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3" aria-label="Policy version lifecycle">
      <div className="flex flex-wrap gap-3">
        <div>
          <Label htmlFor="p-kind">Kind</Label>
          <select id="p-kind" value={kind} onChange={(e) => setKind(e.target.value)} className="flex h-9 rounded-md border border-slate-300 bg-white px-2 text-sm">
            {["policy", "service_catalog", "rubric", "capacity"].map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="p-version">Version</Label>
          <Input id="p-version" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="e.g. policy-v1" className="w-48" />
        </div>
      </div>
      <div>
        <Label htmlFor="p-def">Definition JSON (lint/draft only)</Label>
        <textarea
          id="p-def"
          value={definition}
          onChange={(e) => setDefinition(e.target.value)}
          rows={6}
          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-xs"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy} onClick={() => act("lint")}>Lint (dry-run)</Button>
        <Button type="button" disabled={busy || version.trim() === ""} onClick={() => act("draft")}>
          Store draft
        </Button>
        <Button type="button" disabled={busy || version.trim() === ""} onClick={() => act("publish")}>
          Publish (activate)
        </Button>
        <Button type="button" disabled={busy || version.trim() === ""} onClick={() => act("retire")}>
          Retire
        </Button>
      </div>
      {result && <Alert tone={result.tone === "success" ? "success" : "error"}>{result.text}</Alert>}
      <p className="text-xs text-slate-500">
        Drafts never alter live rankings — nothing reads drafts. Publication and retirement are explicit,
        audited acts. With owner decisions open, keep everything draft.
      </p>
    </div>
  );
}
