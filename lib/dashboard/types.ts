// Typed read contracts for dashboard server components (no new API routes:
// reads run server-side against Postgres; mutations stay on existing APIs).

export interface AgencyRow {
  id: string;
  name: string;
  domain_norm: string | null;
  registry_id: string | null;
  agency_type: string;
  country: string;
  country_code: string | null;
  region: string | null;
  website_url: string | null;
  discovery_status: string;
  created_at: string;
}

export interface DiscoveryRow {
  id: string;
  company_name: string;
  source_key: string | null;
  source_platform: string | null;
  collection_method: string;
  retrieval_status: string;
  retrieved_at: string;
  note: string | null;
}

export interface SnapshotRow {
  id: string;
  company_name: string;
  source_key: string;
  url: string;
  fetched_at: string;
  sha256: string;
  retention_class: string;
  suppressed: boolean;
  excerpt: string | null;
}

export interface ClaimRow {
  id: string;
  company_name: string;
  claim_text: string;
  claim_status: "observed" | "corroborated" | "inferred" | "assumed";
  source_reliability: string;
  info_credibility: number;
  source_key: string;
  snapshot_url: string;
  fetched_at: string;
  observed_at: string | null;
  expires_at: string | null;
  stale: boolean;
}

export interface HypothesisRow {
  id: string;
  company_name: string;
  title: string;
  opportunity_category: string;
  status: string;
  rule_id: string | null;
  rule_version: string | null;
  confidence_rationale: string | null;
  rejection_reason: string | null;
  supports: number;
  contradicts: number;
}

export interface ProjectRow {
  id: string;
  hypothesis_title: string;
  company_name: string;
  title: string;
  feasibility: string;
  effort_lo_days: number | null;
  effort_hi_days: number | null;
  cost_low: string | null;
  cost_high: string | null;
  cost_currency: string | null;
  assumptions: string;
  capability_fit: string | null;
  capabilities: string[];
  validation_questions: string | null;
}

export interface ScoreRow {
  id: string;
  hypothesis_title: string;
  company_name: string;
  weight_version: string;
  fit: number;
  evidence: number;
  opportunity: number;
  feasibility: number;
  timing: number;
  deductions: number;
  total: number;
  band: string;
  gates_passed: boolean;
  created_at: string;
}

export interface BriefRow {
  ref: string;
  company_name: string;
  hypothesis_title: string;
  status: string;
  reviewer: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface BriefDetail extends BriefRow {
  hypothesis_id: string;
  score_total: number | null;
  score_band: string | null;
  markdown: string;
  drafts: { id: string; channel: string; subject: string | null }[];
  outcomes: {
    id: string;
    outcome: string;
    channel: string | null;
    sent_at_manual: string | null;
    rejection_code: string | null;
    recorded_by: string;
  }[];
}

export interface DraftRow {
  id: string;
  brief_ref: string;
  company_name: string;
  channel: string;
  subject: string | null;
  body: string;
}

export interface OutcomeRow {
  id: string;
  brief_ref: string;
  company_name: string;
  outcome: string;
  channel: string | null;
  sent_at_manual: string | null;
  rejection_code: string | null;
  note: string | null;
  recorded_by: string;
  created_at: string;
}

export interface SourceRow {
  key: string;
  category: string;
  platform: string;
  reliability_prior: string;
  enabled: boolean;
  kind: "category" | "connector";
}

export interface AuditRow {
  id: string;
  entity_type: string;
  entity_id: string;
  actor: string;
  transition_from: string | null;
  transition_to: string | null;
  reason: string | null;
  created_at: string;
}

export interface FailureRow {
  id: string;
  entity_type: string;
  entity_id: string | null;
  cause_class: string;
  detail: string | null;
  resolved: boolean;
  occurred_at: string;
}

export interface ImportBatchRow {
  id: string;
  filename: string;
  total_rows: number;
  status: string;
  created_by: string;
  created_at: string;
  imported: number;
  skipped: number;
  invalid: number;
}

export interface OverviewCounts {
  companies: number;
  companiesByStatus: { status: string; n: number }[];
  claims: number;
  claimsByStatus: { status: string; n: number }[];
  hypotheses: number;
  briefs: number;
  briefsByStatus: { status: string; n: number }[];
  outcomes: number;
  batches: number;
  failuresOpen: number;
  migrationsApplied: number;
}
