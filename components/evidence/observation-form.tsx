"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";

/**
 * Manual observation form. Posts to POST /api/evidence/ingest; every rule
 * (auth, CSRF, source gate, validation, privacy tripwire, idempotency) is
 * enforced server-side — this form only collects inputs and renders the
 * returned code/message verbatim. No URL is ever fetched by the client or
 * the server; the URL is recorded as provenance text.
 */
const PREDICATES = [
  "identity",
  "provides_service",
  "operates_in",
  "announced",
  "hiring",
  "contact",
  "partnership",
  "growth",
  "service_request",
  "other",
];

export function ObservationForm({
  companyId,
  enabledSources,
}: {
  companyId: string;
  enabledSources: string[];
}) {
  const router = useRouter();
  const [company, setCompany] = useState(companyId);
  const [sourceKey, setSourceKey] = useState(enabledSources[0] ?? "");
  const [url, setUrl] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [observedAt, setObservedAt] = useState("");
  const [publishedAt, setPublishedAt] = useState("");
  const [predicate, setPredicate] = useState("announced");
  const [text, setText] = useState("");
  const [reliability, setReliability] = useState("B");
  const [credibility, setCredibility] = useState("2");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const uuidOk = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(company);
  const valid = uuidOk && sourceKey !== "" && url.trim() !== "" && text.trim() !== "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const toIso = (d: string): string | undefined =>
        d === "" ? undefined : new Date(`${d}T00:00:00Z`).toISOString();
      const res = await fetch("/api/evidence/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          companyId: company,
          sourceKey,
          url: url.trim(),
          excerpt: excerpt.trim() === "" ? undefined : excerpt.trim(),
          observedAt: toIso(observedAt),
          claim: {
            predicate,
            text: text.trim(),
            reliability,
            credibility: Number.parseInt(credibility, 10),
            expiresAt: toIso(expiresAt),
            publishedAt: toIso(publishedAt),
          },
        }),
      });
      const body = (await res.json()) as {
        code?: string;
        message?: string;
        snapshotId?: string;
        existed?: boolean;
        claimId?: string | null;
      };
      if (!res.ok) {
        setResult({ tone: "error", text: `${body.code ?? "error"}: ${body.message ?? "refused"}` });
      } else if (body.existed) {
        setResult({
          tone: "success",
          text: `Duplicate submission collapsed: no new rows (snapshot ${String(body.snapshotId).slice(0, 8)}…).`,
        });
        router.refresh();
      } else {
        setResult({
          tone: "success",
          text: `Recorded: snapshot ${String(body.snapshotId).slice(0, 8)}… / claim ${String(body.claimId).slice(0, 8)}…. Refreshing…`,
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
    <form onSubmit={submit} className="space-y-3" aria-label="Record manual observation">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="o-company">Company id (uuid, must already exist)</Label>
          <Input id="o-company" value={company} onChange={(e) => setCompany(e.target.value.trim())} placeholder="copy from the agency directory" />
        </div>
        <div>
          <Label htmlFor="o-source">Source (enabled only)</Label>
          <select id="o-source" value={sourceKey} onChange={(e) => setSourceKey(e.target.value)} className="flex h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm">
            {enabledSources.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <Label htmlFor="o-url">Source URL (recorded as provenance, never fetched)</Label>
        <Input id="o-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
      </div>
      <div>
        <Label htmlFor="o-excerpt">Factual excerpt (≤2000 bytes, no personal contact data)</Label>
        <Input id="o-excerpt" value={excerpt} onChange={(e) => setExcerpt(e.target.value)} placeholder="short verbatim extract" />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <Label htmlFor="o-observed">Observed at</Label>
          <Input id="o-observed" type="date" value={observedAt} onChange={(e) => setObservedAt(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="o-published">Published at (source date, if stated)</Label>
          <Input id="o-published" type="date" value={publishedAt} onChange={(e) => setPublishedAt(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="o-expires">Expires at (optional)</Label>
          <Input id="o-expires" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <Label htmlFor="o-predicate">Signal family</Label>
          <select id="o-predicate" value={predicate} onChange={(e) => setPredicate(e.target.value)} className="flex h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm">
            {PREDICATES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="o-rel">Reliability (A–D)</Label>
          <select id="o-rel" value={reliability} onChange={(e) => setReliability(e.target.value)} className="flex h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm">
            {["A", "B", "C", "D"].map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="o-cred">Credibility (1–5)</Label>
          <select id="o-cred" value={credibility} onChange={(e) => setCredibility(e.target.value)} className="flex h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm">
            {["1", "2", "3", "4", "5"].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <Label htmlFor="o-text">Claim text (factual, 1–2000 chars)</Label>
        <Input id="o-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="what the source states" />
      </div>
      <Button type="submit" disabled={!valid || busy}>
        {busy ? "Recording…" : "Record observation"}
      </Button>
      {result && <Alert tone={result.tone === "success" ? "success" : "error"}>{result.text}</Alert>}
      <p className="text-xs text-slate-500">
        Disabled sources are refused before any write; identical resubmissions collapse without duplicating;
        personal emails and personal profiles are refused by validation.
      </p>
    </form>
  );
}
