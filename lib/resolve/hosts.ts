// Shared/platform host denylist for the domain rule (T-004).
//
// THREAT MODEL: exact normalized-domain matches are high-confidence ONLY
// when the host identifies one company. Bare platform or social hosts
// (pasted from a listing or profile URL) would collide across unrelated
// companies, so the domain rule skips them. Records stay resolvable via
// registry, alias, and name rules. Subdomains of these hosts still match
// exactly (a shared full host implies a shared site); the list is a
// PROPOSAL seed (D-011) — extend only with evidence, never silently.

const SHARED_HOSTS: ReadonlySet<string> = new Set(
  [
    // Social / professional networks (profile URLs normalize to these).
    "linkedin.com",
    "facebook.com",
    "instagram.com",
    "x.com",
    "twitter.com",
    "tiktok.com",
    "youtube.com",
    // Directories / review platforms (listing URLs normalize to these).
    "crunchbase.com",
    "clutch.co",
    "trustpilot.com",
    "g2.com",
    "glassdoor.com",
    "indeed.com",
    // Site builders, bare roots only (see module note on subdomains).
    "wixsite.com",
    "weebly.com",
    "wordpress.com",
    "blogspot.com",
    "squarespace.com",
    "godaddysites.com",
    "webflow.io",
    // App platforms, bare roots only.
    "github.io",
    "gitlab.io",
    "netlify.app",
    "vercel.app",
    "herokuapp.com",
    "firebaseapp.com",
  ].map((h) => h.toLowerCase()),
);

export function isSharedHost(domainNorm: string | null): boolean {
  if (!domainNorm) return false;
  return SHARED_HOSTS.has(domainNorm.toLowerCase());
}

export function sharedHostCount(): number {
  return SHARED_HOSTS.size;
}
