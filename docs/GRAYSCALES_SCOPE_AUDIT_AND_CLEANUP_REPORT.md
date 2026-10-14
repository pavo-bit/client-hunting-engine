# GRAYSCALES_SCOPE_AUDIT_AND_CLEANUP_REPORT

> Read-only audit first, removal plan second, smallest safe execution last.
> No EIP/VaultForge integration was added to Grayscales at any point.

## Verdict: PASS

Scope is clean, required functionality is preserved, all relevant checks
pass. One orphaned demo folder removed with provenance preserved.

## 1. Actual scope findings

The owner's hypothesis — EIP/VaultForge responsibilities mixed into
Grayscales — is **not confirmed by evidence**. Exhaustive identifier and
behavior sweeps over `app/`, `lib/`, `scripts/`, `db/`, `tests/`, `docs/`,
`agents/`, `compose.yaml`, and dependencies found:

- **Zero** references to EIP, VaultForge, telemetry, threat detection,
  remediation governance, backup custody/orchestration, recovery-point
  services, DR APIs, or cross-project integrations (only benign substring
  hits: "tamper-evidence" describing Grayscales' own audit guarantees,
  "orchestration" in two comments meaning local function sequencing,
  "threat rules" in the app's own QA role docs).
- **28/28 tables** map to owned Grayscales domains (intake, discovery,
  evidence, identity, hypotheses, proposals, briefs/sales, scoring, auth,
  audit/ops, migrations). No telemetry/incident/custody/vault tables.
- **Single compose service** (`postgres:17.11`, loopback-only). No
  schedulers, no extra services, no new infrastructure.
- **All dependencies imported** by product/test code (pg, next, react,
  forms/validation, tables, UI primitives, icons, TS, vitest). None orphaned.
- `scripts/backup.mjs` is an ordinary `pg_dump -Fc` + `pg_restore` workflow
  (version-matched tools, local files, manifests) — explicitly **not**
  VaultForge per the mission's own rule (§3: do not confuse the two).
- `failure_log` + cause classes are adapter/operational failure quarantine
  (FR-007/G6), not incident correlation or RCA.
- Health endpoint, request-ID middleware, boot validation, session hygiene,
  and the CI workflow are basic operational safeguards — proportionate,
  tested, and explicitly in Grayscales' owned list.

## 2. Classification table (by behavior, not labels)

| Component / file(s) | Responsibility | Usage / dependencies | In Grayscales? | Evidence | Action |
|---|---|---|---|---|---|
| Agency research + sales stack (`app/`, `lib/intake|discovery|resolve|evidence|hypothesis|proposal|sales|scoring|review|outcomes|search`, 28 tables) | Core product workflows | Everything; tested 300 green | Yes | Spec §§1–4, all T-reports | KEEP |
| AUTH-001 (`lib/auth`, login/logout/session, guards, `operator_session`) | Operator authN/Z, attribution, audit | Every page + API handler | Yes | Owned list; parity scripts | KEEP |
| `scripts/backup.mjs`, `backups/` dumps | Ordinary PG backup/restore | Runbook + M3 drills | Yes | Mission §3 keep-rule | KEEP |
| `failure_log`, `/audit` page | Operational failure quarantine + visibility | FR-007/G6, tests | Yes | Cause classes are adapter-level | KEEP |
| Health/logging/boot/CI (`/api/health`, `middleware.ts`, `instrumentation.ts`, `lib/ops`, `.github/`) | Basic ops observability + gates | M3 smoke + tests | Yes | Owned list; no metrics stack | KEEP |
| `Creative Login Form/` (index.html, script.js, style.css) | Third-party animated demo, superseded | **Zero runtime imports** (verified sweep); only a code comment + AUTH-001 prose referenced it | No | Import scan empty; AUTH-001 §1 records the only reuse (email regex, preserved in code) | **REMOVE** (executed §4) |
| Nothing else | — | — | — | Sweeps above | KEEP (no SIMPLIFY: no mechanism found disproportionate; no REVIEW items left ambiguous) |

## 3. Confirmed cross-project contamination

**None.** No EIP/VaultForge product feature was ever implemented inside
Grayscales — there was nothing to disconnect and no integration to avoid
adding. The single removal (§4) is orphaned demo clutter, not
cross-project functionality.

## 4. Exact files and schema changes

- **Deleted:** `Creative Login Form/index.html` (11,086 B, sha256
  `CC5079E5…`), `script.js` (20,932 B, `5EADF8CF…`), `style.css`
  (1,609 B, `2F4F4854…`) — prefixes recorded; full values in shell history,
  not needed for rollback (generic third-party demo; project value — the
  email pattern — preserved in `components/login-form.tsx`).
- **Edited (provenance only):** `components/login-form.tsx` comment →
  past tense; `docs/AUTH001_…_REPORT.md` → dated addendum (original prose
  preserved).
- **Schema/migrations:** none (no table touched). **Env/docker/tests:**
  untouched. Rollback strategy: not required — deletion verified
  dependency-free before and after (import sweep + full suite + build);
  contents reproducible from upstream; no business data, audit history, or
  secret was inside (static HTML/CSS/JS, no credentials — verified by read).
- Data-loss/security/regression risk of this removal: **nil** (static files,
  never served, never imported).

## 5. Data-preservation and rollback evidence

- Dev seed intact (3 companies / 5 claims / 1 hypothesis — verified §6).
- `backups/` untouched incl. legacy `pre-migration-20261013.dump`.
- No migration added, edited, or retimestamped; no database reset.
- Rollback for the deletion is unnecessary per §4; had it been needed, the
  checksums above identify the exact bytes.

## 6. Full verification results (executed post-cleanup)

| Gate | Result |
|---|---|
| `migrate` (dev + test) | `already up to date` (26) |
| `seed` ×2 + `verify` | `seed ok` ×2, `verify ok` |
| `npx vitest run` | **23 files / 300 passed / 1 skipped / 0 failed** |
| `npx tsc --noEmit` | Clean |
| `npm run build` | `Compiled successfully` |
| Docker/PG health | `healthy` |
| Auth smoke (anon 307/401 → login 200 → authed 200 → logout → 401) | Re-executed §7 |
| Business data intact | Dev counts unchanged; pilot store untouched |

## 7. Auth smoke re-execution (post-cleanup proof)

Because the cleanup touched a login-adjacent comment, the auth cycle was
re-proved live on the production build rather than assumed intact: anonymous
`/review` → 307 `/login?next=%2Freview`; anonymous `/api/companies` → 401;
bad login → generic 401; valid login → 200 + hardened cookie; authenticated
`/review` + `/api/search` → 200; logout → 200 with cleared cookie; reuse of
the old cookie → 401. Smoke server stopped, temp files removed, dev sessions
cleaned afterwards.

## 8. Remaining ambiguous items

**None.** Every component inspected classified KEEP or REMOVE-executed; the
REVIEW bucket is empty.

## 9. Local-only + core-workflow confirmation

Grayscales remains local-only (loopback DB + app ports, boot gate, no public
exposure, no cloud) and retains every core workflow: discovery → resolve →
evidence → hypotheses → proposals → scoring → briefs → review queue →
human-only drafts → pipeline/outcomes → learning reports, with auth,
attribution, and audit intact. Nothing in this cleanup added, moved, or
weakened any of them.
