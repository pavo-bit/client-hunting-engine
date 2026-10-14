// Server-side validation for manual entry + CSV rows (T-003). Pure functions.
// Never trust client-supplied IDs, statuses, or validation results — callers
// re-run these on the server before any write.

import {
  normalizeDomain,
  normalizeRegistryId,
  normalizeWebsiteUrl,
  type FieldError,
} from "./normalize";
import { isSharedHost } from "../resolve/hosts";

export const AGENCY_TYPES = [
  "web_development",
  "custom_software",
  "mobile_app",
  "ecommerce",
  "automation_consultancy",
  "other_digital",
] as const;

export type AgencyType = (typeof AGENCY_TYPES)[number];

/** Raw company input as accepted from operator UI / CSV row (all strings). */
export interface CompanyInput {
  name: string;
  domain?: string;
  registryId?: string;
  registryType?: string;
  agencyType: string;
  country: string;
  countryCode?: string;
  region?: string;
  websiteUrl?: string;
}

export interface NormalizedCompany {
  name: string;
  domainNorm: string | null;
  registryId: string | null;
  registryType: string | null;
  agencyType: AgencyType;
  country: string;
  countryCode: string | null;
  region: string | null;
  websiteUrl: string | null;
}

export interface ValidationResult {
  ok: boolean;
  value: NormalizedCompany | null;
  errors: FieldError[];
}

const err = (field: string, message: string): FieldError => ({ field, message });

export function validateCompanyInput(input: CompanyInput): ValidationResult {
  const errors: FieldError[] = [];

  const name = (input.name ?? "").trim();
  if (name.length === 0) errors.push(err("name", "name is required"));
  else if (name.length > 300) errors.push(err("name", "name exceeds 300 characters"));

  // Identity: domain and/or registry ID. Social-URL-only is rejected with an
  // actionable message (schema has no social-handle identity column; T-004+).
  const domainRaw = (input.domain ?? "").trim();
  const registryRaw = (input.registryId ?? "").trim();
  let domainNorm: string | null = null;
  let registryId: string | null = null;
  if (domainRaw.length === 0 && registryRaw.length === 0) {
    errors.push(
      err(
        "domain",
        "provide a domain or a registry ID (social-profile URLs alone are not storable identifiers yet)",
      ),
    );
  }
  if (domainRaw.length > 0) {
    const r = normalizeDomain(domainRaw);
    if (!r.ok) errors.push(err("domain", r.error));
    else if (isSharedHost(r.value)) {
      // A bare platform/social host identifies the platform, not the agency.
      // Storing it as domain_norm would corrupt identity and block unrelated
      // records via the canonical unique index — so it is never stored.
      if (registryRaw.length === 0) {
        errors.push(
          err(
            "domain",
            `${r.value} is a shared platform host, not an agency domain — provide the agency's own domain or a registry ID (keep the profile link as website URL)`,
          ),
        );
      }
      // else: drop the non-identifying host; registry identity stands alone.
    } else domainNorm = r.value;
  }
  if (registryRaw.length > 0) {
    const r = normalizeRegistryId(registryRaw);
    if (!r.ok) errors.push(err("registryId", r.error));
    else registryId = r.value;
  }

  // Optional registry type label (normalized lowercase). Used only to veto
  // registry matches when both sides state conflicting types (D-011).
  let registryType: string | null = null;
  const typeRaw = (input.registryType ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (typeRaw.length > 0) {
    if (typeRaw.length > 60)
      errors.push(err("registryType", "registry type exceeds 60 characters"));
    else registryType = typeRaw;
  }

  let agencyType: AgencyType | null = null;
  if (!(AGENCY_TYPES as readonly string[]).includes(input.agencyType)) {
    errors.push(
      err("agencyType", `must be one of: ${AGENCY_TYPES.join(", ")}`),
    );
  } else {
    agencyType = input.agencyType as AgencyType;
  }

  const country = (input.country ?? "").trim();
  if (country.length === 0) errors.push(err("country", "country is required"));
  else if (country.length > 120)
    errors.push(err("country", "country exceeds 120 characters"));

  let countryCode: string | null = null;
  const ccRaw = (input.countryCode ?? "").trim();
  if (ccRaw.length > 0) {
    const cc = ccRaw.toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc))
      errors.push(err("countryCode", "country code must be 2 ISO letters (e.g. US)"));
    else countryCode = cc;
  }

  let region: string | null = null;
  const regionRaw = (input.region ?? "").trim();
  if (regionRaw.length > 0) {
    if (regionRaw.length > 120)
      errors.push(err("region", "region exceeds 120 characters"));
    else region = regionRaw;
  }

  let websiteUrl: string | null = null;
  const webRaw = (input.websiteUrl ?? "").trim();
  if (webRaw.length > 0) {
    const r = normalizeWebsiteUrl(webRaw);
    if (!r.ok) errors.push(err("websiteUrl", r.error));
    else websiteUrl = r.value;
  }

  if (errors.length > 0) return { ok: false, value: null, errors };
  return {
    ok: true,
    value: {
      name,
      domainNorm,
      registryId,
      registryType,
      agencyType: agencyType as AgencyType,
      country,
      countryCode,
      region,
      websiteUrl,
    },
    errors: [],
  };
}
