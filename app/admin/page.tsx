import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Alert, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";
import { adminStatus } from "@/lib/qualification/dashboard";
import { ReconcilePanel } from "@/components/qualification/reconcile-panel";

export const dynamic = "force-dynamic";

/**
 * GET /admin — administration and recovery. Status displays plus explicit
 * operator triggers (reconciliation). Backup/restore and migration checks run
 * as documented terminal commands — this page shows their latest artifacts,
 * it does not execute shell commands from the browser.
 */
export default async function AdminPage() {
  await requireOperatorPage("/admin");
  let status: Awaited<ReturnType<typeof adminStatus>> | null = null;
  let error: string | null = null;
  try {
    status = await adminStatus();
  } catch {
    error = "Local database unreachable.";
  }
  // Latest backup manifest on disk (read-only directory scan).
  let backups: { file: string; taken: string; bytes: number }[] = [];
  try {
    const dir = join(process.cwd(), "backups");
    backups = readdirSync(dir)
      .filter((f) => f.endsWith(".dump.manifest.json"))
      .map((f) => {
        try {
          const m = JSON.parse(readFileSync(join(dir, f), "utf8")) as { timestamp?: string; bytes?: number };
          return { file: f.replace(".manifest.json", ""), taken: String(m.timestamp ?? "?"), bytes: Number(m.bytes ?? 0) };
        } catch {
          return { file: f.replace(".manifest.json", ""), taken: "?", bytes: 0 };
        }
      })
      .sort((a, b) => (a.taken < b.taken ? 1 : -1))
      .slice(0, 4);
  } catch {
    backups = [];
  }

  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "System & Governance" }, { label: "Administration" }]}
        title="Administration and recovery"
        description="Operator-triggered verification, reconciliation and recovery. Manual only — nothing here runs itself."
      />
      {error || !status ? (
        <Alert tone="error">{error ?? "Could not load."}</Alert>
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle>Reconciliation (explicit trigger)</CardTitle></CardHeader>
            <CardContent>
              <ReconcilePanel />
            </CardContent>
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Event consumers</CardTitle></CardHeader>
              <CardContent>
                <SimpleTable
                  caption="Consumer watermarks and dead letters"
                  columns={["Consumer", "Watermark", "Applied", "Dead"]}
                  rows={status.consumers.map((c) => [
                    <span key={`c${c.consumer_name}`} className="font-mono text-xs">{c.consumer_name}</span>,
                    <span key={`w${c.consumer_name}`}>{c.last_outbox_id}</span>,
                    <span key={`a${c.consumer_name}`}>{c.applied_count}</span>,
                    <span key={`d${c.consumer_name}`}>{c.dead_count}</span>,
                  ])}
                  empty="No consumers have claimed yet."
                />
                {status.unsettledByConsumer.length > 0 && (
                  <p className="mt-2 text-xs text-amber-700">
                    Unsettled: {status.unsettledByConsumer.map((u) => `${u.consumer_name} (${u.n})`).join(", ")} —
                    reclaim via reconcile.
                  </p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Migrations and data</CardTitle></CardHeader>
              <CardContent>
                <SimpleTable
                  caption="Schema and store status"
                  columns={["Signal", "Value"]}
                  rows={[
                    ["Migrations applied", String(status.migrationsApplied)],
                    ["Outbox events", String(status.outboxTotal)],
                    ["Qualification cases", String(status.casesTotal)],
                    ["Canonical check", status.verificationNote],
                  ]}
                  empty="No status."
                />
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader><CardTitle>Backups and recovery</CardTitle></CardHeader>
            <CardContent>
              <SimpleTable
                caption="Recent backup manifests (latest 4 kept)"
                columns={["Dump", "Taken", "Bytes"]}
                rows={backups.map((b) => [
                  <span key={`f${b.file}`} className="font-mono text-xs">{b.file}</span>,
                  <span key={`t${b.file}`} className="text-xs">{b.taken}</span>,
                  <span key={`b${b.file}`} className="text-xs">{b.bytes}</span>,
                ])}
                empty="No backup manifests on disk."
              />
              <p className="mt-2 text-xs text-slate-600">
                Backup, verify and isolated-restore run in the terminal (runbook §3):{" "}
                <span className="font-mono">node scripts/backup.mjs backup|verify|restore</span>. Restores
                target scratch databases only — the live database cannot be overwritten by the script, by
                construction. See <Link href="/qualification/audit" className="text-blue-700 hover:underline">audit</Link> for
                integrity expectations.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
