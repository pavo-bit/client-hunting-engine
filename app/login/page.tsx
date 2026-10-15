import { redirect } from "next/navigation";
import { getAuthConfig } from "@/lib/auth/config";
import { safeNextPath } from "@/lib/auth/http";
import { SESSION_COOKIE, validateSession } from "@/lib/auth/sessions";
import { getPool } from "@/lib/intake/db";
import { cookies } from "next/headers";
import { CreativeLoginForm } from "@/components/creative-login-form";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sign in — Grayscales Opportunity Intelligence",
  description: "Operator sign in for the internal BD intelligence tool.",
};

/**
 * GET /login — PUBLIC. The app's front door: this is where every unauthenticated
 * request is redirected (middleware), so the creative operator form is the first
 * thing an operator sees and the dashboard is reachable only after a successful
 * server-side credential check.
 *
 * `next` is validated server-side (open-redirect guard) before it is used, and
 * an already-signed-in operator is sent straight to it.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const sp = await searchParams;
  const next = safeNextPath(sp.next);
  const cfg = getAuthConfig();
  if (!cfg.devOpen) {
    const jar = await cookies();
    const raw = jar.get(SESSION_COOKIE)?.value ?? "";
    if (raw) {
      try {
        const session = await validateSession(getPool(), cfg, raw);
        if (session) redirect(next);
      } catch {
        /* fall through to the form */
      }
    }
  }
  return (
    <div className="creative-login-page">
      <div className="creative-login-header">
        <p className="text-sm font-bold text-slate-900">
          Grayscales <span className="font-normal text-slate-500">Intel</span>
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Operator sign in</h1>
        <p className="mt-1 text-xs text-slate-500">
          Sign in to reach the dashboard. Failed attempts never reveal whether an
          account exists.
        </p>
      </div>
      <CreativeLoginForm next={next} />
    </div>
  );
}