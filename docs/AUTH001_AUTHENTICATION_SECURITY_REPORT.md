# AUTH001_AUTHENTICATION_SECURITY_REPORT — Operator Authentication

> Date: 2026-10-13. Scope: integrate the supplied login folder, implement
> end-to-end operator authentication, protect every page and API route, retire
> the development-only open mode. No product features added. T-013 NOT started.

## Verdict: PASS

---

## 1. Login-folder integration — what was reused and what was not

> Addendum 2026-10-14 (scope cleanup): the `Creative Login Form/` folder
> described below was removed after verification that nothing imports it at
> runtime (only `components/login-form.tsx`'s comment referenced it, now
> reworded to past tense). Checksums at removal: index.html 11086 bytes
> `CC5079E5…`, script.js 20932 bytes `5EADF8CF…`, style.css 1609 bytes
> `2F4F4854…` (prefixes). The email-pattern reuse stands as recorded; the
> section below is otherwise preserved verbatim as the historical record.

The supplied folder is `Creative Login Form/` (root): a standalone GSAP-animated
**name + email + checkbox** demo (`index.html`, `style.css`, `script.js`). It is
not an operator login: it has no password field, no error states, no server
wiring, and it loads its animation engine from the **unpkg CDN at runtime**
(`<script src="https://unpkg.com/gsap@3/dist/gsap.min.js">`), which is
incompatible with a local-only internal tool.

| Reused | How |
|---|---|
| Client-side email regex (`/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/`) | Adopted as the convenience-validation pattern in `components/login-form.tsx`, with the server re-validating independently |
| Labeled-input structure (`label` + input + inline error) | Adopted via the existing `Label`/`Input`/`FieldError` primitives |

| Deliberately NOT ported | Why |
|---|---|
| GSAP animation stack + SVG scene | Requires a third-party CDN script at runtime; a checkbox-gated "spray to reveal submit" interaction is inappropriate for authentication UX |
| Name + "agree to whatever" checkbox model | Replaced by the required email + password credential |
| Unpkg CDN dependency | No external runtime dependency was introduced anywhere in this task |

The login UI is a normal App Router page (`app/login/page.tsx` + client
`components/login-form.tsx`) built from the application's own design system
(Card/Input/Label/Button/Alert), so no second frontend and no duplicate login
system exist. It is deliberately **outside** navigation (added to the orphan-page
test's FUNNELS set with rationale): it is reached by redirect, never by nav link.

## 2. Authentication and session architecture

- **Credential:** single authorized operator. `OPERATOR_EMAIL` + scrypt password
  hash (`N=16384, r=8, p=1`, 256-bit salt, 512-bit key, constant-time compare)
  from `OPERATOR_PASSWORD_HASH`. Node built-in `crypto` only — no new
  dependencies, no Redis, no new infrastructure. Password verification is
  server-only (`lib/auth/password.ts`, never imported by client components).
- **Provisioning:** `node scripts/operator.mjs init|hash|check`. The password is
  read from stdin/TTY, never argv; only the hash is printed for the operator to
  paste into the untracked `.env`. No endpoint can create or replace the
  credential.
- **Sessions:** opaque 256-bit tokens (base64url cookie `gsid`), **SHA-256 digest
  only** in `public.operator_session` (migration `20261014000001`). Sliding
  12h TTL capped by a 24h absolute maximum, enforced server-side on every
  validation. Every login mints a fresh identifier and revokes all prior
  sessions (fixation-safe by construction; single-operator tool holds exactly
  one live session). Logout revokes server-side, then clears the cookie
  (idempotent — bare logout still returns ok without leaking session existence).
- **Cookies:** `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=TTL`; `Secure` in
  production / over https. (`__Host-` prefix rejected: it forces `Secure`
  always, which would break plain-http localhost operation; the conditional flag
  satisfies the stated requirement.)
- **Rate limiting:** in-memory per ip|email buckets (5 failures / 10 min →
  10-min lock; success clears). Proportionate for a single-process local tool;
  documented, with `_resetRateLimit` for deterministic tests.
- **Enumeration resistance:** unknown email, wrong password → byte-identical
  401s; unknown emails still burn a full scrypt verification (dummy hash) for
  timing parity; lockouts refuse even correct passwords while locked.
- **CSRF:** cookie-authenticated POST/PUT/PATCH/DELETE require a same-origin
  `Origin`/`Referer` matching the `Host` header (403 otherwise). Bearer service
  callers skip it (no ambient browser authority). The check compares against
  the Host header only — never `req.url`, after observing Next.js normalize
  `127.0.0.1` to `localhost` in constructed URLs.
- **Open redirects:** `safeNextPath()` allows only single-leading-slash absolute
  paths (no `//`, no backslashes, no scheme, ≤500 chars); applied to `?next=`
  and the login body's `next` on both render and success paths.
- **Audit:** login success/failure, logout, expiry, and revocation append to the
  existing append-only `audit_log` (`entity_type='auth'`); entity_id is the
  operator email for attribution; passwords, hashes, and tokens are never
  recorded (asserted by scan tests). Business actions are attributed to the
  authenticated session email, which takes precedence over the old
  client-supplied `actor` label everywhere.
- **Legacy token migration (decision):** `OPERATOR_API_TOKEN`, when configured
  non-empty, remains valid as an **explicit service credential** for scripted
  API clients (exact `Bearer` match, CSRF-exempt). When empty or missing it
  grants **nothing** — the old "empty means open" semantics are removed from
  `checkOperatorToken` (deliberate breaking change; `tests/auth.test.ts`
  rewritten to assert closed-by-default). There is no open mode in production:
  `AUTH_DEV_OPEN=1` is honored only when `NODE_ENV != production`, and
  `assertAuthAvailable()` throws at boot when production has neither a
  credential nor a service token.

## 3. Files changed and migration details

**New:** `db/migrations/20261014000001_operator_sessions.sql` (session table +
indexes + RLS/revoke, additive),
`db/migrations/20261014000002_operator_sessions_fix.sql` (drops the misconceived
`expires_at > created_at` check — it made expired sessions un-revocable; found
by the expiry test, see §6),
`lib/auth/{password,config,sessions,ratelimit,http,guard}.ts`,
`app/api/auth/{login,logout,session}/route.ts`, `app/login/page.tsx`,
`components/login-form.tsx`, `scripts/operator.mjs`, `tests/auth_session.test.ts`
(16 tests), `.gitignore` (none existed; covers `.env`, secrets, build output,
backups).

**Modified:** all 38 non-auth `app/api/**/route.ts` (session-first guard, CSRF
on mutations, operator attribution), all 29 `app/**/page.tsx` (page guard with
validated return path; 3 sync components made async), `lib/intake/http.ts`
(closed bearer semantics), `components/shell.tsx` (auth-aware banner: operator
email + sign-out; login page gets neutral chrome), `app/settings/page.tsx`
(auth disclosure, replacing "Absent"), `tests/auth.test.ts` (15 unit tests for
the new contract), `tests/gleif.test.ts` (static route-authorization contract
updated), `tests/dashboard.test.ts` (`/login` funnel), `tests/seed.test.ts`
(migration count 23 → 25), `.env` (dev-only credential appended),
`.env.example` (placeholders + `$`-escaping warning).

**Not changed:** no existing migration edited or retimestamped; no seed change;
no domain library changed; no `lib` business logic; no Supabase; no outreach
path; no new npm dependency; no git history exists in this workspace (no `.git`;
nothing to audit — stated so it is not assumed checked).

## 4. Threat model and security controls

| Threat | Control | Evidence |
|---|---|---|
| Anonymous page access | `requireOperatorPage()` first line of all 29 pages → 307 to `/login?next=` | Smoke §6.1; every page statically contains exactly one guard call (script-verified) |
| Anonymous API reads | `requireOperatorApi()` on all 39 handlers → 401 JSON, no data | Smoke §6.2–3; handler/gate count parity script-verified |
| Anonymous mutations | Same guard + CSRF origin check → 401/403 | Smoke §6.8a–b; integration CSRF tests |
| Credential guessing | scrypt cost + 5/10-min lockout + generic 401s + timing parity | Smoke §6.11 (4×401 then 429); unit timing-parity test |
| Session theft/replay | 256-bit opaque ids, digest-only storage, 12h/24h bounds, rotation kills priors | Rotation/expiry/revocation tests; storage-shape test |
| Fixation | Login never reuses an identifier; priors revoked | Rotation test (old token 401s) |
| CSRF | Origin/Referer-vs-Host on cookie mutations | 403s without/evil origin; 201 with same origin |
| Open redirect | `safeNextPath` on render + success payload | 15 unit vectors; live evil-`next` → `"next":"/"` |
| Enumeration | Identical 401s, dummy-hash timing, locked-correct-also-429 | Byte-equality assertions |
| Secret leakage | Nothing secret in bodies/cookies/URLs/logs; bodies scanned in tests | Cookie attrs asserted; scan assertions throughout |
| Missing production secrets | Shape-validated config + `assertAuthAvailable()` boot gate | 503 login + config unit tests |
| Legacy bypass | Empty bearer grants nothing (closed default) | Anonymous + empty/wrong bearer 401 tests |
| Audit tampering | Reuses append-only trigger (blocks even owner DELETE — verified when test cleanup hit it) | Trigger source cited; no audit UPDATE/DELETE anywhere |

## 5. Test commands and exact execution results

- `node scripts/db.mjs migrate` (dev + test): `already up to date` (25 applied, latest `20261014000002_operator_sessions_fix.sql`).
- `node scripts/db.mjs seed` ×2: `seed ok` ×2. `node scripts/db.mjs verify`: `verify ok`.
- `npx vitest run`: **18 files, 266 passed, 1 skipped (opt-in), 0 failed** — includes 15 rewritten `auth.test.ts` unit tests and 16 new `auth_session.test.ts` integration tests (real route handlers in-process against the test DB: login states, cookie attributes, rotation, expiry, revocation, logout, CSRF matrix, bearer matrix, audit-without-secrets, fail-closed). Two regressions from the contract change (`gleif` static gate test, `seed` migration count) were updated, not weakened.
- `npx tsc --noEmit`: clean. `npm run build`: `Compiled successfully` (no source file newer than the build).
- `node scripts/operator.mjs check .env`: both present.
- Production-build HTTP smoke (`next start -p 3101`, loopback): anonymous `/review` → **307 `/login?next=%2Freview`**; `/` → 307 `/login`; anonymous API read/mutation → **401** with no data; `/login` renders email+password fields, no secret text; bad/unknown logins → byte-identical generic **401**; valid login → 200 + `gsid=…; Path=/; Max-Age=43200; Secure; HttpOnly; SameSite=lax`; authenticated `/review` → 200; cookie POST without/evil Origin → **403**; same-Origin POST → **201** audited as `actor='operator@example.com'`; logout → 200 + cleared cookie + session dead; evil `next` in login body → `"next":"/"`; 4 credential failures → **429** lockout. Smoke company and sessions removed afterwards (3 companies / 5 claims intact, 0 sessions).

## 6. Incidents during implementation (all resolved, none hidden)

1. **Codemod miss:** two GET handlers in mixed files (`/api/companies`, `/api/discovery/runs`, `/api/proposals`) initially ungated — caught by the handler/gate parity script, fixed by hand, parity re-verified.
2. **Codemod regex miss:** page-guard insertion failed on `) {` spacing (v1 added imports only) — caught by the exactly-one-guard check, rewritten, re-verified (29/29).
3. **Expiry un-revocable (real design bug):** `expires_at > created_at` CHECK made the revoke-after-expiry UPDATE violate its own table constraint. Fixed by additive migration `...02` dropping that check; expiry/revocation is an application predicate, covered by tests. The bug never reached production use.
4. **`$`-expansion incident (real, significant):** Next.js expands `$VAR` inside `.env` at boot, silently mangling the scrypt hash (`scrypt$16384$…` → `scrypt6384…`) and causing mystery 401s. Resolved by (a) storing the hash `$`-escaped (`\$`, verified byte-level what Next resolves it to), (b) `operator.mjs` printing/checking the escaped form and failing `check` on unescaped `$`, (c) `getAuthConfig()` shape-validating the post-expansion hash so mangling fails closed (503) instead of confusing, (d) a regression test with the exact mangled string, (e) `.env.example` warning. The dev password itself was regenerated with exact bytes after a PowerShell-pipeline mangling suspicion (ruled out — the `$` expansion was the cause).
5. **Test-client quirks (not product bugs):** PS 5.1 drops `Cookie` headers (used curl.exe for cookie smoke); Windows curl passes single quotes literally (used `@file` bodies); in-process `NextRequest` carries no Host header and rewrites `127.0.0.1`→`localhost` in `req.url` (tests set Host explicitly; the guard intentionally compares against Host only).

## 7. Remaining vulnerabilities and limitations

1. **Single-operator, password-only.** No MFA, no lockout notification channel, no password-expiry policy. Appropriate for a local-only single-operator tool; must be revisited before any exposure.
2. **In-memory rate limiting** does not survive restarts and does not share across processes. Bounded impact locally (restart clears the ledger — observed during smoke); a multi-process deployment would need a DB-backed ledger.
3. **No `Secure`-over-plain-HTTP concern for browsers on localhost** (Chrome/Firefox send `Secure` cookies to `http://localhost`), but non-browser HTTP clients must handle the flag; `next dev` (NODE_ENV=development) omits `Secure`.
4. **Session absolute cap (24h) forces daily re-login** — a usability cost accepted for the security posture; tunable via `AUTH_SESSION_MAX_SEC`.
5. **Failed-login audit rows are attacker-writable** (bounded by the rate limiter: ≤5 per 10 min per key). Lockout rejections are deliberately not audited to prevent log-bloat as a DoS vector.
6. **`AUTH_DEV_OPEN=1` bypass exists** but is unreachable in production by construction (`!isProduction` gate + boot assertion). It must never be set outside local development; grep-able in one place (`lib/auth/config.ts`).
7. **No git history** in this workspace, so historical credential leakage could not be audited — stated, not assumed. `.gitignore` now excludes `.env` and secrets for any future repository.
8. **The dev `.env` credential is a documented placeholder** (`operator@example.com` / dictionary-derivable password, same posture as `POSTGRES_PASSWORD=postgres`). Production MUST run `node scripts/operator.mjs init`; the boot gate refuses to serve otherwise.
9. Owner decisions unchanged: **D-004, D-005, D-006 (weights still need n≥30), D-008** remain OPEN.

## 8. Local-only confirmation

`compose.yaml` still binds `127.0.0.1:${POSTGRES_PORT}:5432`; the app server was exercised only on `127.0.0.1:3101`; `DATABASE_URL`/`TEST_DATABASE_URL` refuse non-loopback hosts (in `scripts/db.mjs`, and every test asserts loopback before connecting); no port was opened publicly, no cloud resource provisioned, no remote endpoint contacted (the only network calls in tests are the pre-existing opt-in GLEIF live smoke, skipped by default). The shell banner now reads "local-only build, do not expose publicly" with sign-in state.
