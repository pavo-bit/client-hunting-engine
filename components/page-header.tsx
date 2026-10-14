import Link from "next/link";
import { ChevronRight } from "lucide-react";

export function PageHeader({
  trail,
  title,
  description,
  actions,
}: {
  trail: { label: string; href?: string }[];
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-4 space-y-1">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-1 text-xs text-slate-500">
          {trail.map((t, i) => (
            <li key={t.label} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-3" aria-hidden="true" />}
              {t.href ? (
                <Link href={t.href} className="hover:underline">
                  {t.label}
                </Link>
              ) : (
                <span aria-current="page">{t.label}</span>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{title}</h1>
          {description && (
            <p className="max-w-3xl text-sm text-slate-600">{description}</p>
          )}
        </div>
        {actions && <div className="flex gap-2">{actions}</div>}
      </div>
    </div>
  );
}
