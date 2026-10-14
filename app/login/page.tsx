import { redirect } from "next/navigation";
import { getAuthConfig } from "@/lib/auth/config";
import { safeNextPath } from "@/lib/auth/http";
import { SESSION_COOKIE, validateSession } from "@/lib/auth/sessions";
import { getPool } from "@/lib/intake/db";
import { cookies } from "next/headers";
import { LoginForm } from "@/components/login-form";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sign in — Grayscales Opportunity Intelligence",
  description: "Operator sign in for the internal BD intelligence tool.",
};

/**
 * GET /login — PUBLIC. Renders the operator sign-in form. Already-signed-in
 * operators are sent to their validated return path (or home). The `next`
 * parameter is validated server-side (open-redirect guard) before rendering.
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
    <div className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center gap-4 px-4 py-10">
      <div className="text-center">
        <p className="text-sm font-bold text-slate-900">
          Grayscales <span className="font-normal text-slate-500">Intel</span>
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Operator sign in</h1>
      </div>
      <LoginForm next={next} />
      <p className="max-w-md text-center text-xs text-slate-500">
        Local-only internal tool. If you reached this page unexpectedly, do not
        enter credentials — contact the tool owner.
      </p>
    </div>
  );
}
