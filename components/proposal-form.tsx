"use client";

// Proposal drafting form (RHF + Zod for structure; server revalidates
// everything, runs the estimation model, and enforces eligibility).
// Estimates shown here are indicative ranges, never quotes.

import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/card";
import { FieldError, Input, Label } from "@/components/ui/input";

const itemSchema = z.object({
  name: z.string().trim().min(1, "item name required"),
  complexity: z.enum(["S", "M", "L", "XL"]),
  kind: z.enum(["feature", "integration", "data_migration", "security", "testing"]),
});

const schema = z.object({
  title: z.string().trim().min(1, "title is required").max(300),
  scopeIn: z.string().trim().max(4000),
  scopeOut: z.string().trim().max(4000),
  feasibility: z.enum(["high", "medium", "low", "unknown"]),
  assumptions: z.string().trim().min(1, "assumptions are required — ranges without them are forbidden"),
  dependencies: z.string().trim().max(4000),
  costLow: z.string().trim(),
  costHigh: z.string().trim(),
  costCurrency: z.string().trim(),
  pricingModel: z.enum(["fixed_scope", "time_and_materials", "not_defined", ""]),
  timelineLo: z.string().trim(),
  timelineHi: z.string().trim(),
  itemsText: z.string().trim(),
  contingencyPct: z.string().trim(),
});

type Form = z.infer<typeof schema>;

function parseItems(text: string): { name: string; complexity: string; kind: string }[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => {
      const [name, complexity, kind] = l.split("|").map((s) => s.trim());
      return { name: name ?? "", complexity: complexity ?? "", kind: kind ?? "" };
    });
}

export function ProposalForm({ hypothesisId }: { hypothesisId: string }) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: "",
      scopeIn: "",
      scopeOut: "",
      feasibility: "medium",
      assumptions: "",
      dependencies: "",
      costLow: "",
      costHigh: "",
      costCurrency: "",
      pricingModel: "",
      timelineLo: "",
      timelineHi: "",
      itemsText: "",
      contingencyPct: "15",
    },
  });
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function onSubmit(v: Form) {
    setResult(null);
    const num = (s: string): number | null => (s.trim() === "" ? null : Number(s));
    const body = {
      hypothesisId,
      title: v.title,
      scopeIn: v.scopeIn || undefined,
      scopeOut: v.scopeOut || undefined,
      feasibility: v.feasibility,
      assumptions: v.assumptions,
      dependencies: v.dependencies || undefined,
      capabilityKeys: undefined,
      items: parseItems(v.itemsText),
      contingencyPct: v.contingencyPct.trim() === "" ? undefined : Number(v.contingencyPct),
      costLow: num(v.costLow),
      costHigh: num(v.costHigh),
      costCurrency: v.costCurrency.trim() === "" ? null : v.costCurrency.trim().toUpperCase(),
      pricingModel: v.pricingModel === "" ? null : v.pricingModel,
      timelineLoWeeks: num(v.timelineLo),
      timelineHiWeeks: num(v.timelineHi),
    };
    const res = await fetch("/api/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { id?: string; code?: string; message?: string };
    if (res.status === 201 && data.id) {
      router.push(`/proposals/${data.id}`);
    } else {
      setResult({ tone: "error", text: `Error ${res.status} (${String(data.code ?? "")}): ${String(data.message ?? "")}` });
    }
  }

  const field = (name: keyof Form, label: string, extra?: React.ReactNode) => (
    <div key={name}>
      <Label htmlFor={`p-${name}`}>{label}</Label>
      {extra ?? (
        <Input id={`p-${name}`} {...register(name)} aria-invalid={!!errors[name]} />
      )}
      <FieldError message={errors[name]?.message as string | undefined} />
    </div>
  );

  return (
    <div className="space-y-3">
      <form onSubmit={handleSubmit(onSubmit)} className="grid max-w-2xl gap-3" noValidate>
        {field("title", "Project title *")}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="p-scopeIn">In scope</Label>
            <Input id="p-scopeIn" {...register("scopeIn")} />
          </div>
          <div>
            <Label htmlFor="p-scopeOut">Out of scope (explicit exclusions)</Label>
            <Input id="p-scopeOut" {...register("scopeOut")} />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="p-feasibility">Feasibility</Label>
            <select id="p-feasibility" {...register("feasibility")} className="flex h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm">
              {(["high", "medium", "low", "unknown"] as const).map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="p-dependencies">Dependencies & integrations</Label>
            <Input id="p-dependencies" {...register("dependencies")} />
          </div>
        </div>
        {field("assumptions", "Assumptions * (ranges without these are forbidden)")}
        <div>
          <Label htmlFor="p-items">Effort line items (one per line: name | S/M/L/XL | feature/integration/data_migration/security/testing)</Label>
          <Input id="p-items" {...register("itemsText")} placeholder="Client intake form | M | feature" />
          <FieldError message={errors.itemsText?.message} />
          <p className="text-xs text-slate-500">
            Leave empty for no estimate (insufficient information) — precision will not be invented.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {field("contingencyPct", "Contingency % (0–100)")}
          {field("costLow", "Cost low (optional, with high + currency)")}
          {field("costHigh", "Cost high")}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {field("costCurrency", "Currency (e.g. USD — never converted)")}
          <div>
            <Label htmlFor="p-pricingModel">Pricing model</Label>
            <select id="p-pricingModel" {...register("pricingModel")} className="flex h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm">
              <option value="">—</option>
              <option value="fixed_scope">fixed_scope</option>
              <option value="time_and_materials">time_and_materials</option>
              <option value="not_defined">not_defined</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {field("timelineLo", "Timeline lo (wks)")}
            {field("timelineHi", "Timeline hi (wks)")}
          </div>
        </div>
        <div>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving draft…" : "Save proposal draft"}
          </Button>
        </div>
      </form>
      {result && <Alert tone={result.tone === "success" ? "success" : "error"}>{result.text}</Alert>}
      <p className="max-w-2xl text-xs text-slate-500">
        Draft only. Effort ranges come from estimation model v1 (documented
        baselines + contingency); timelines and prices are your explicit inputs
        with assumptions, or absent. Nothing here is a quote or commitment.
      </p>
    </div>
  );
}
