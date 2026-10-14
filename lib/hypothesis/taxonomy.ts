// Controlled hypothesis taxonomy, version 1 (T-008). Candidate categories
// only — never claims about a specific company. Each entry documents what
// may support it, what is insufficient alone, alternatives, validation
// questions, and when generation is forbidden.

export const TAXONOMY_VERSION = "1" as const;

export type OpportunityCategory =
  | "integrations"
  | "automation_workflows"
  | "portals_dashboards"
  | "testing_qa"
  | "reporting_analytics"
  | "ecommerce_tooling"
  | "mobile_delivery"
  | "other_digital";

export interface TaxonomyEntry {
  category: OpportunityCategory;
  problem: string;
  legitimateSupport: string[];
  insufficientAlone: string[];
  alternatives: string[];
  questions: string[];
  interventions: string[];
  mustNotGenerate: string[];
}

export const TAXONOMY: TaxonomyEntry[] = [
  {
    category: "portals_dashboards",
    problem:
      "Client onboarding, intake, or status communication may rely on manual channels (email, calls) where a portal could help — unknown until validated.",
    legitimateSupport: [
      "announced offerings describing onboarding/services without mentioning a portal",
      "contact/intake evidence showing email-based intake",
      "hiring for client-facing operations roles",
    ],
    insufficientAlone: [
      "advertising web development services",
      "holding a legal entity identifier",
      "any single uncorroborated observation",
    ],
    alternatives: [
      "intake is already handled by an adequate portal",
      "clients prefer high-touch manual onboarding",
      "the announcement is marketing, not an operational signal",
    ],
    questions: [
      "How do new clients reach you today, step by step?",
      "What breaks most often in that process?",
      "Is there an existing client login or portal, and what does it cover?",
      "Who would pilot a change, and what would success look like?",
    ],
    interventions: [
      "Discovery of the intake workflow, then a scoped pilot portal (intake form + status page) — proposal only, never a commitment",
    ],
    mustNotGenerate: [
      "from legal-identity records alone",
      "from merely offering web services",
      "when evidence shows an adequate portal already exists and is uncontradicted",
    ],
  },
  {
    category: "automation_workflows",
    problem:
      "A growing team may be coordinating work informally; internal workflow tooling needs are unknown until validated.",
    legitimateSupport: [
      "hiring signals indicating team growth",
      "announced service expansion without described operations",
    ],
    insufficientAlone: [
      "hiring developers (never proves tech debt or delivery problems)",
      "company size or age alone",
    ],
    alternatives: [
      "growth is planned and already tool-supported",
      "hiring replaces attrition rather than expanding",
      "coordination works well at current scale",
    ],
    questions: [
      "What breaks when two more people join the team?",
      "Which recurring tasks consume the most manual effort?",
      "What tools coordinate delivery today?",
    ],
    interventions: [
      "Workflow audit of one recurring process, then a small automation pilot — proposal only",
    ],
    mustNotGenerate: [
      "from legal-identity records alone",
      "from headcount numbers without hiring evidence",
    ],
  },
  {
    category: "integrations",
    problem:
      "Public mentions of APIs, integrations, or multi-system delivery may indicate integration work worth scoping — scope and need unknown until validated.",
    legitimateSupport: [
      "announcements mentioning APIs, integrations, webhooks, or data sync",
      "service listings describing multi-platform delivery",
    ],
    insufficientAlone: [
      "offering integration services to clients",
      "a competitor shipping an integration",
    ],
    alternatives: [
      "mentions describe client work, not internal need",
      "integrations already exist and suffice",
    ],
    questions: [
      "Which systems must share data today, and how?",
      "Where does manual re-entry happen between systems?",
      "What does the current integration surface cover?",
    ],
    interventions: [
      "Integration-surface mapping, then one scoped connector pilot — proposal only",
    ],
    mustNotGenerate: [
      "from legal-identity records alone",
      "from a competitor's feature set",
    ],
  },
  {
    category: "reporting_analytics",
    problem:
      "Operational visibility may rely on manual reporting; the actual gap is unknown until validated.",
    legitimateSupport: [
      "announcements or listings mentioning reports, dashboards, or analytics delivery",
      "hiring for operations or analyst roles",
    ],
    insufficientAlone: [
      "an old website (never proves poor conversion or revenue)",
      "absence of public metrics (absence of evidence is not evidence)",
    ],
    alternatives: [
      "reporting already exists internally and is not public",
      "metrics are reviewed adequately today",
    ],
    questions: [
      "Which numbers do you check weekly, and where do they come from?",
      "How long does month-end reporting take, and who does it?",
      "What decision was delayed for lack of data recently?",
    ],
    interventions: [
      "One-metric pilot dashboard over existing data — proposal only",
    ],
    mustNotGenerate: [
      "from legal-identity records alone",
      "from website age or design quality",
      "from missing public metrics",
    ],
  },
  {
    category: "testing_qa",
    problem:
      "QA maturity is unknown; observed release or quality signals may warrant questions — never assertions — about testing practice.",
    legitimateSupport: [
      "announced QA/testing services with described process gaps",
      "hiring for QA roles alongside delivery growth",
    ],
    insufficientAlone: [
      "assumed manual QA without corroboration",
      "a single visible defect",
    ],
    alternatives: [
      "testing is rigorous but not publicly described",
      "quality issues were one-off and addressed",
    ],
    questions: [
      "How is a release verified before it ships?",
      "What does the QA process cover, and what escapes it?",
      "Who owns quality, and what would they change?",
    ],
    interventions: [
      "Test-coverage review of one product area, then a small automation pilot — proposal only",
    ],
    mustNotGenerate: [
      "from legal-identity records alone",
      "from assumed internal practices without corroboration",
    ],
  },
];

/** Categories with no v1 generation rule: insufficient evidence patterns
 *  are defined, so the engine stays silent rather than fabricating. */
export const RULELESS_CATEGORIES: OpportunityCategory[] = [
  "ecommerce_tooling",
  "mobile_delivery",
  "other_digital",
];
