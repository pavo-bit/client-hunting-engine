"use client";

// AUTH-001 operator login form (client component).
// Convenience validation only — the server re-validates everything. The only
// values ever sent are email + password (+ the validated return path); no env,
// no implementation detail, and no secret besides the password itself leaves
// the browser, and then only over the login POST.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, Alert } from "@/components/ui/card";
import { Input, Label, FieldError } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

// Client-side convenience pattern, carried over from the former "Creative
// Login Form" reference folder (removed in scope cleanup; provenance in the
// AUTH-001 report). The server applies its own validation; this only avoids
// a pointless round-trip.
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

type State =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "error"; code: string; message: string };

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailTouched, setEmailTouched] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });

  const emailBad = emailTouched && !EMAIL_RE.test(email.trim());
  const canSubmit = state.kind !== "busy" && EMAIL_RE.test(email.trim()) && password.length > 0;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) {
      setEmailTouched(true);
      return;
    }
    setState({ kind: "busy" });
    let res: Response;
    try {
      res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, next }),
      });
    } catch {
      setState({
        kind: "error",
        code: "network",
        message: "Could not reach the server. Check that the app is running locally and retry.",
      });
      return;
    }
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { next?: string };
      const target = typeof data.next === "string" && data.next.startsWith("/") ? data.next : "/";
      router.push(target);
      router.refresh();
      return;
    }
    if (res.status === 429) {
      setState({
        kind: "error",
        code: "rate_limited",
        message: "Too many attempts. Wait a few minutes and try again.",
      });
      return;
    }
    if (res.status === 503) {
      setState({
        kind: "error",
        code: "unavailable",
        message: "Operator authentication is not configured on this server. Provision a credential first.",
      });
      return;
    }
    setState({
      kind: "error",
      code: "invalid",
      message: "Invalid email or password.",
    });
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Operator sign in</CardTitle>
        <p className="pt-1 text-sm text-slate-600">
          Internal tool. One authorized operator. Sessions expire automatically.
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate aria-label="Operator sign in">
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="login-email">Email</Label>
              <Input
                id="login-email"
                name="email"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => setEmailTouched(true)}
                aria-invalid={emailBad}
                aria-describedby={emailBad ? "login-email-error" : undefined}
                placeholder="operator@example.com"
              />
              {emailBad && (
                <span id="login-email-error">
                  <FieldError message="Enter a valid email address." />
                </span>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
              />
            </div>
            {state.kind === "error" && (
              <Alert tone={state.code === "rate_limited" || state.code === "unavailable" ? "warning" : "error"}>
                {state.message}
              </Alert>
            )}
            <Button type="submit" className="w-full" disabled={!canSubmit}>
              {state.kind === "busy" ? "Signing in…" : "Sign in"}
            </Button>
            <p className="text-xs text-slate-500">
              Protected by rate limiting. Failed attempts never say whether the email exists.
            </p>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
