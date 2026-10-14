// Domain normalization for intake (T-003). Pure functions — no I/O.
// Rule: normalization MUST satisfy the DB CHECKs in migration 000002
// (domain_norm is lowercase, has no leading www., contains a dot).

export interface FieldError {
  field: string;
  message: string;
}

const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Normalize a domain, URL, or bare host to canonical domain_norm. */
export function normalizeDomain(
  input: string,
): { ok: true; value: string } | { ok: false; error: string } {
  let s = input.trim().toLowerCase();
  if (s.length === 0) return { ok: false, error: "domain is empty" };
  // Strip scheme, credentials, port, path, query, fragment.
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split("@").pop() as string;
  s = s.split(/[/?#]/)[0];
  s = s.split(":")[0];
  if (s.startsWith("www.")) s = s.slice(4);
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (s.length === 0 || s.length > 253)
    return { ok: false, error: "domain length out of range" };
  if (!s.includes(".") || s.includes(" ") || s.includes(".."))
    return { ok: false, error: "not a valid bare domain (need host.tld)" };
  const labels = s.split(".");
  for (const label of labels) {
    if (!DOMAIN_LABEL.test(label))
      return { ok: false, error: `invalid domain label: ${label}` };
  }
  const tld = labels[labels.length - 1];
  if (/^[0-9]+$/.test(tld))
    return { ok: false, error: "TLD must not be all-numeric" };
  return { ok: true, value: s };
}

/**
 * Normalize a registry identifier. Registry formats vary by jurisdiction, so
 * this only trims/collapses whitespace and enforces length — matching is
 * exact (case-sensitive). Documented limitation, see D-002.
 */
export function normalizeRegistryId(
  input: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const s = input.trim().replace(/\s+/g, " ");
  if (s.length === 0) return { ok: false, error: "registry ID is empty" };
  if (s.length > 120)
    return { ok: false, error: "registry ID exceeds 120 characters" };
  return { ok: true, value: s };
}

/** Normalize an optional website URL (http/https only). */
export function normalizeWebsiteUrl(
  input: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const s = input.trim();
  if (s.length === 0) return { ok: false, error: "website URL is empty" };
  if (s.length > 2000)
    return { ok: false, error: "website URL exceeds 2000 characters" };
  if (!s.startsWith("http://") && !s.startsWith("https://"))
    return { ok: false, error: "website URL must start with http:// or https://" };
  if (s.includes(" "))
    return { ok: false, error: "website URL must not contain spaces" };
  return { ok: true, value: s };
}
