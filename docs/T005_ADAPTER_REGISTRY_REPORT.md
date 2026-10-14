# T005_ADAPTER_REGISTRY_REPORT — Adapter Interface + Registry

> Date: 2026-10-13. Stack: Next.js 15.5.27 + Docker Compose postgres:17.11. No live acquisition, no network code, no T-006 started.

## Contract and registry design

- `lib/discovery/types.ts` — contract v1: manifest (stable id/version/category/capabilities/limitations/access/maxPageSize), `validateConfig`, `discover` (AbortSignal), pure `normalize`/`provenance`, non-invasive `health`; result model (ok/empty/partial/failed) with explicit `partial` flag + page tokens; versioned `NormalizedDiscovery` (modelVersion 1, missingFields/warnings); failure causes incl. `cancelled`/`timeout`/`misconfigured` with retryable flags. `ADAPTER_CONTRACT_VERSION = 1`.
- `lib/discovery/registry.ts` — deterministic registry: manifest validation (id pattern, S-01..S-12 only, capability vocabulary, page-size bounds, declared access), duplicate rejection, config + capability gating before invocation, limit clamping, timeout wrapper, cached health. Registration/listing never execute or fetch. No dynamic loading or remote plugins.
- `lib/discovery/fetch-guard.ts` — preventive SSRF denylist (schemes, credentials-in-URL, loopback/private/link-local/metadata incl. disguised IPv4 + IPv6 forms). No caller fetches yet; future live adapters must apply it (DNS TOCTOU documented as residual).
- Separation enforced: adapters produce observations; intake validation + identity resolution decide canonicity. Normalized output is intake-compatible (CompanyInput-shaped).

## Files changed and migrations

- Created: `lib/discovery/{types,registry,fetch-guard}.ts`, `lib/discovery/fixtures/agency-directory.ts`, `app/api/adapters/route.ts`, `tests/adapters.test.ts`, this report.
- Modified: `app/sources/page.tsx` (framework-adapter section, fixture-labeled), docs (SOURCE_INTEGRATION_PLAN §1, IMPLEMENTATION module row, LOW_LEVEL T-005, DECISIONS D-013).
- Migrations: none (registry is code-side; DB source policy table unchanged). No schema change was justified.

## Fixture adapter behavior

`agency-directory-fixture` (S-05, v0.1.0): deterministic synthetic records (`Fixture Agency N (SYNTHETIC)`, `fixture-<seed>-<n>.example`, US/DE/SG rotation) via seeded PRNG; scenarios ok/empty/partial (two-page walk, explicit flags)/malformed (missing name, bad URL → warnings, never throws)/error (per-cause retryable flags); AbortSignal cancellation; latency option; config validation; health without fetching. Not registered in production code.

## API/UI additions

- `GET /api/adapters` — read-only, intentionally ungated (matches GET conventions), sanitized metadata only (static-tested secret-free).
- Sources page section lists framework adapters with fixture limitations + no-live-discovery notice.

## Security and compliance controls

- Source payloads typed untrusted; normalize coerces defensively.
- Zero-network proven by stubbed-fetch test; listing/registration proven side-effect-free by call counting.
- No secrets in manifests/listings/diagnostics (scanned); config validation rejects unknown fields.
- No scraping, crawling, social integrations, or outreach paths added (no-send scan extended earlier still passes in full suite).
- Local-only posture unchanged; mutating routes untouched (still token-gated).

## Tests executed and exact results

- `tests/adapters.test.ts`: **19/19 pass** — registration valid/invalid/dup/unknown, config + capability gating, no-exec proof, determinism, empty, two-page partial walk (3+2, flags, deduped ids), failure causes + retry flags, cancellation (pre-abort + mid-wait), registry timeout, zero-network (fetch stub uncalled), normalization gaps, malformed tolerance, fetch-guard allow/block matrix (22 URLs), intake compat (valid + invalid), T-004 compat (fixture company resolves), API static contract.
- Full `npx vitest run`: **8 files, 111/111 pass** (T-002/T-003/T-004 regressions intact).
- `npx tsc --noEmit`: clean (two strictness fixes during development: contextual stub types, fixture cause cast).
- `npm run build`: clean. Endpoint smoke on production build: `GET /api/adapters` → 1 adapter, contract 1; `/sources` 200 with fixture row; server stopped after.
- Mid-task issues (all fixed with evidence): tsc literal-widening ×2, own doc comment tripping the secret scan (reworded), Docker daemon outage (environmental; relaunched, volume data intact).

## Deferred capabilities and risks

- Live connectors (each needs individual D-003 evaluation), `lookup` implementations, DNS-resolve-and-revalidate, production adapter registration, remote plugin loading (forbidden by design).
- Fixture `maxPageSize` 25 and shared-host/identity semantics live in intake/resolve, not adapters.
- `zod@4` installed incidentally earlier (schemas use basic API; suite green).

## Verdict: PASS

All acceptance gates hold: typed interface + registry, deterministic network-free fixture, separated registration/invocation, provenance retained, partial/failed explicit, intake + identity intact, 111/111 + tsc + build green, Docker workflows operational, no Supabase, no scraping, no outreach, no T-006 started.
