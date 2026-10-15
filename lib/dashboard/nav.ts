"use client";

// Single navigation registry. Every href must resolve to a real page —
// enforced by tests/dashboard.test.ts (nav <-> route inventory check).

import {
  Activity,
  Building2,
  CalendarDays,
  ClipboardCheck,
  ClipboardList,
  Database,
  FileText,
  FlaskConical,
  GitBranch,
  Import as ImportIcon,
  LayoutDashboard,
  Lightbulb,
  ListChecks,
  Mails,
  Microscope,
  Scale,
  ScrollText,
  Search,
  ShieldCheck,
  Crosshair,
  Settings,
  KanbanSquare,
  Layers,
  Briefcase,
  Package,
  Target,
  Wrench,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Machine-readable capability state; shown as a badge, never hidden. */
  state: "live" | "partial" | "planned";
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: "Command Center",
    items: [
      { href: "/overview", label: "Overview", icon: LayoutDashboard, state: "live" },
      { href: "/today", label: "Today", icon: CalendarDays, state: "live" },
      { href: "/activity", label: "Activity & Status", icon: Activity, state: "live" },
    ],
  },
  {
    title: "Agency Intelligence",
    items: [
      { href: "/agencies", label: "Directory", icon: Building2, state: "live" },
      { href: "/search", label: "Global Search", icon: Search, state: "live" },
      { href: "/agencies/new", label: "Add Agency", icon: ClipboardList, state: "live" },
      { href: "/discovery", label: "Discovery", icon: Search, state: "partial" },
      { href: "/opportunities", label: "Opportunities", icon: Crosshair, state: "partial" },
      { href: "/resolve", label: "Identity Resolution", icon: GitBranch, state: "partial" },
      { href: "/research", label: "Research Workspace", icon: FlaskConical, state: "partial" },
    ],
  },
  {
    title: "Evidence & Diagnosis",
    items: [
      { href: "/evidence", label: "Evidence Ledger", icon: Database, state: "live" },
      { href: "/hypotheses", label: "Hypotheses", icon: Lightbulb, state: "live" },
      { href: "/projects", label: "Project Proposals", icon: Layers, state: "live" },
    ],
  },
  {
    title: "Evaluation & Review",
    items: [
      { href: "/scores", label: "Opportunity Ranking", icon: Scale, state: "live" },
      { href: "/review", label: "Review Queue", icon: ListChecks, state: "live" },
      { href: "/commercial", label: "Commercial Evaluation", icon: Briefcase, state: "partial" },
    ],
  },
  {
    title: "Qualification",
    items: [
      { href: "/qualification", label: "Pursuit Queue", icon: Target, state: "partial" },
      { href: "/qualification/assess", label: "Assess Console", icon: Microscope, state: "partial" },
      { href: "/qualification/research", label: "Research Tasks", icon: ClipboardCheck, state: "partial" },
      { href: "/qualification/policy", label: "Policy & Capacity", icon: ShieldCheck, state: "partial" },
      { href: "/qualification/audit", label: "Decisions & Metrics", icon: ListChecks, state: "partial" },
    ],
  },
  {
    title: "Sales Workspace",
    items: [
      { href: "/briefs", label: "Opportunity Briefs", icon: FileText, state: "live" },
      { href: "/outreach", label: "Outreach Drafts", icon: Mails, state: "live" },
      { href: "/pipeline", label: "Sales Pipeline", icon: KanbanSquare, state: "live" },
      { href: "/tasks", label: "Tasks & Follow-ups", icon: ClipboardList, state: "planned" },
    ],
  },
  {
    title: "System & Governance",
    items: [
      { href: "/import", label: "Imports", icon: ImportIcon, state: "live" },
      { href: "/catalog", label: "Service Catalog", icon: Package, state: "partial" },
      { href: "/sources", label: "Source Registry", icon: Database, state: "live" },
      { href: "/audit", label: "Audit & Failures", icon: ScrollText, state: "live" },
      { href: "/admin", label: "Administration", icon: Wrench, state: "live" },
      { href: "/settings", label: "Settings & Access", icon: Settings, state: "partial" },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);
