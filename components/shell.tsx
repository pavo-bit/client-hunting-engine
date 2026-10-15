"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Search, TriangleAlert, LogOut } from "lucide-react";
import { ALL_NAV_ITEMS, NAV_GROUPS } from "@/lib/dashboard/nav";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/card";

const stateTone: Record<string, "default" | "info" | "success" | "warning"> = {
  live: "success",
  partial: "warning",
  planned: "default",
};

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <div className="space-y-4">
      {NAV_GROUPS.map((group) => (
        <div key={group.title}>
          <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            {group.title}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active =
                pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm",
                      active
                        ? "bg-blue-600 font-medium text-white"
                        : "text-slate-300 hover:bg-slate-800 hover:text-white",
                    )}
                  >
                    <item.icon className="size-4 shrink-0" aria-hidden="true" />
                    <span className="flex-1">{item.label}</span>
                    {item.state !== "live" && (
                      <Badge
                        variant={stateTone[item.state]}
                        className="bg-slate-700 text-[10px] text-slate-200"
                      >
                        {item.state}
                      </Badge>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [operator, setOperator] = useState<string | null>(null);

  // Authenticated-operator state for the banner + logout. /api/auth/session
  // returns auth state only (no private data), so polling it is safe. The
  // login page manages its own chrome and skips the operator fetch.
  useEffect(() => {
    if (pathname === "/login") {
      setOperator(null);
      return;
    }
    let live = true;
    fetch("/api/auth/session", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: unknown) => {
        if (!live) return;
        const rec = d as { authenticated?: boolean; email?: string } | null;
        setOperator(rec && rec.authenticated === true && typeof rec.email === "string" ? rec.email : null);
      })
      .catch(() => {
        if (live) setOperator(null);
      });
    return () => {
      live = false;
    };
  }, [pathname]);

  async function onLogout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* cookie is cleared server-side on next load regardless */
    }
    setOperator(null);
    router.push("/login");
    router.refresh();
  }

  const onLoginPage = pathname === "/login";

  // The sign-in page is a SEPARATE page, not a dashboard screen: no sidebar,
  // no search bar, no section footer. The operator meets one form first and
  // enters the dashboard only after the server accepts the credential. Only
  // the security notice is shared, because it applies to both.
  if (onLoginPage) {
    return (
      <div className="min-h-screen bg-slate-100 text-slate-900">
        <div
          role="note"
          className="flex items-center justify-center gap-2 bg-amber-100 px-4 py-1.5 text-xs text-amber-900"
        >
          <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
          <span>
            Local internal tool — sign in to continue. Trusted local use only; do
            not expose publicly.
          </span>
        </div>
        <main id="main" className="min-h-[calc(100vh-2rem)]">
          {children}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <div
        role="note"
        className="flex items-center justify-center gap-2 bg-amber-100 px-4 py-1.5 text-xs text-amber-900"
      >
        <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
        {onLoginPage ? (
          <span>Local internal tool — sign in to continue. Trusted local use only; do not expose publicly.</span>
        ) : operator ? (
          <span className="inline-flex items-center gap-2">
            <span>
              Signed in as <strong>{operator}</strong> · local-only build, do not expose publicly.
            </span>
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex items-center gap-1 rounded border border-amber-300 bg-white/60 px-2 py-0.5 font-medium hover:bg-white"
            >
              <LogOut className="size-3" aria-hidden="true" />
              Sign out
            </button>
          </span>
        ) : (
          <span>Local internal tool — sign in required. Trusted local use only; do not expose publicly.</span>
        )}
      </div>
      <div className="flex">
        <nav
          aria-label="Primary"
          className="sticky top-0 hidden h-screen w-60 shrink-0 overflow-y-auto bg-slate-900 p-4 text-slate-200 md:block"
        >
          <p className="px-3 pb-3 text-sm font-bold text-white">
            Grayscales <span className="font-normal text-slate-400">Intel</span>
          </p>
          <NavList />
        </nav>
        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
            <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5 md:px-6">
              <button
                type="button"
                className="rounded-md border border-slate-300 px-2 py-1 text-sm md:hidden"
                aria-expanded={mobileOpen}
                aria-controls="mobile-nav"
                onClick={() => setMobileOpen((v) => !v)}
              >
                Menu
              </button>
              <form
                role="search"
                aria-label="Search agencies"
                className="relative ml-auto w-full max-w-xs"
                onSubmit={(e) => {
                  e.preventDefault();
                  router.push(`/agencies${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`);
                  setMobileOpen(false);
                }}
              >
                <Search
                  className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search agencies…"
                  aria-label="Search agencies by name, domain, or country"
                  className="h-9 w-full rounded-md border border-slate-300 bg-white pl-8 pr-2 text-sm"
                />
              </form>
            </div>
            {mobileOpen && (
              <nav
                id="mobile-nav"
                aria-label="Primary (mobile)"
                className="border-t border-slate-800 bg-slate-900 p-4 md:hidden"
              >
                <NavList onNavigate={() => setMobileOpen(false)} />
              </nav>
            )}
          </header>
          <div className="mx-auto max-w-6xl px-4 py-5 md:px-6">
            <main id="main">{children}</main>
            <footer className="mt-10 border-t border-slate-200 pt-3 text-xs text-slate-500">
              Internal tool · human-only outreach ·{" "}
              {ALL_NAV_ITEMS.length} sections · synthetic `.example` data is
              labeled where shown.
            </footer>
          </div>
        </div>
      </div>
    </div>
  );
}
