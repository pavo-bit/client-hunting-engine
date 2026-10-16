/**
 * Single source of truth for test database URLs (Phase 4 / A2).
 *
 * WHY THIS EXISTS: the two Phase 2 permission suites previously defaulted
 * TEST_P2_URL to a HARDCODED `agency_intel_test`. In CI — which provisions
 * `agency_intel_ci` — that silently pointed the Phase 2 principal at a
 * database that does not exist, so the suites either failed obscurely or, if a
 * stale local database happened to be reachable, asserted against the wrong
 * data. A missing variable must never silently become a different database.
 *
 * CONTRACT:
 *   * every URL is loopback-only (tests may never touch a real instance);
 *   * the Phase 2 / no-access URLs are DERIVED from TEST_DATABASE_URL, so one
 *     isolated CI database safely supports the whole suite;
 *   * an explicit TEST_P2_URL / TEST_NOACCESS_URL still wins, so an operator
 *     can point a suite at a purpose-built scratch database;
 *   * an unparseable or non-loopback value throws immediately with the name
 *     of the variable to fix.
 */

export interface PrincipalUrls {
  /** Superuser/test-owner URL used for fixtures and assertions. */
  testDatabaseUrl: string;
  /** Phase 2 principal (scoped view + consumption functions only). */
  p2Url: string;
  /** Role with CONNECT only and no table grants. */
  noAccessUrl: string;
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;

function assertLoopback(name: string, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `${name} is not a valid URL. Set it to a loopback PostgreSQL URL, e.g. ` +
        `postgresql://user:pass@127.0.0.1:5434/<db>. Refusing to continue.`,
    );
  }
  if (!LOOPBACK.test(url.hostname))
    throw new Error(
      `${name} points at non-loopback host '${url.hostname}'. Tests refuse to run ` +
        `against anything but 127.0.0.1/localhost.`,
    );
  return url;
}

/** Swap credentials on an existing loopback URL, keeping host/port/database. */
function asPrincipal(base: URL, user: string, password: string): string {
  const next = new URL(base.toString());
  next.username = user;
  next.password = password;
  return next.toString();
}

export function resolveTestDatabases(
  env: NodeJS.ProcessEnv = process.env,
  defaults: { test?: string; p2User?: string; p2Password?: string; naUser?: string; naPassword?: string } = {},
): PrincipalUrls {
  const testDatabaseUrl = env.TEST_DATABASE_URL ?? defaults.test ?? "";
  if (testDatabaseUrl === "") {
    throw new Error(
      "TEST_DATABASE_URL is not set. Point it at the isolated test database " +
        "(CI: agency_intel_ci via scripts/db.mjs bootstrap). Refusing to fall back to a guess.",
    );
  }
  const base = assertLoopback("TEST_DATABASE_URL", testDatabaseUrl);

  const p2User = defaults.p2User ?? "p2_app";
  const p2Password = defaults.p2Password ?? "p2-app-local-only";
  const naUser = defaults.naUser ?? "noaccess";
  const naPassword = defaults.naPassword ?? "noaccess-local-only";

  const p2Url = env.TEST_P2_URL
    ? env.TEST_P2_URL
    : asPrincipal(base, p2User, p2Password);
  const noAccessUrl = env.TEST_NOACCESS_URL
    ? env.TEST_NOACCESS_URL
    : asPrincipal(base, naUser, naPassword);

  assertLoopback("TEST_P2_URL", p2Url);
  assertLoopback("TEST_NOACCESS_URL", noAccessUrl);

  // A derived principal URL must address the SAME database as the fixtures,
  // otherwise the suite would assert grants against an unrelated schema.
  if (!env.TEST_P2_URL) {
    const derived = new URL(p2Url);
    if (derived.pathname !== base.pathname)
      throw new Error(
        `derived TEST_P2_URL database '${derived.pathname}' does not match ` +
          `TEST_DATABASE_URL '${base.pathname}'. Set TEST_P2_URL explicitly if the ` +
          `Phase 2 principal really belongs to a different database.`,
      );
  }

  return {
    testDatabaseUrl: base.toString(),
    p2Url,
    noAccessUrl,
  };
}