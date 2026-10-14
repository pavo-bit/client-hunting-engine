import Link from "next/link";
import { Alert, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";

/** Honest status page for capabilities with no implemented backend. */
export function PlannedPage({
  trail,
  title,
  description,
  missing,
  requires,
  links,
}: {
  trail: { label: string; href?: string }[];
  title: string;
  description: string;
  missing: string[];
  requires: string;
  links?: { label: string; href: string }[];
}) {
  return (
    <div className="space-y-4">
      <PageHeader trail={trail} title={title} description={description} />
      <Alert tone="warning">
        Not implemented — this page describes scope and prerequisites. Nothing
        here is functional yet, and no data below is fabricated.
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle>What is missing</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-slate-600">
            <strong>Requires:</strong> {requires}
          </p>
          {links && links.length > 0 && (
            <p className="mt-2 text-sm">
              Available now:{" "}
              {links.map((l, i) => (
                <span key={l.href}>
                  {i > 0 && " · "}
                  <Link href={l.href} className="text-blue-700 hover:underline">
                    {l.label}
                  </Link>
                </span>
              ))}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
