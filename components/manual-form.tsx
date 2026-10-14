"use client";

// Shared manual agency form (React Hook Form + Zod). Client validation is a
// courtesy — POST /api/companies revalidates everything server-side.

import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/card";
import { FieldError, Input, Label } from "@/components/ui/input";

const manualSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(300),
    domain: z.string().trim(),
    registryId: z.string().trim().max(120),
    registryType: z.string().trim().max(60),
    agencyType: z.enum([
      "web_development",
      "custom_software",
      "mobile_app",
      "ecommerce",
      "automation_consultancy",
      "other_digital",
    ]),
    country: z.string().trim().min(1, "country is required").max(120),
    countryCode: z
      .string()
      .trim()
      .max(2)
      .refine((s) => s === "" || /^[A-Za-z]{2}$/.test(s), "2 ISO letters (e.g. US)"),
    region: z.string().trim().max(120),
    websiteUrl: z.string().trim(),
  })
  .superRefine((v, ctx) => {
    if (v.domain === "" && v.registryId === "") {
      ctx.addIssue({
        code: "custom",
        path: ["domain"],
        message: "provide a domain or a registry ID",
      });
    }
  });

type ManualFormValues = z.infer<typeof manualSchema>;

export function ManualForm() {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ManualFormValues>({
    resolver: zodResolver(manualSchema),
    defaultValues: {
      name: "",
      domain: "",
      registryId: "",
      registryType: "",
      agencyType: "web_development",
      country: "",
      countryCode: "",
      region: "",
      websiteUrl: "",
    },
  });
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function onSubmit(values: ManualFormValues) {
    setResult(null);
    const res = await fetch("/api/companies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (res.status === 201) {
      setResult({ tone: "success", text: `Saved agency ${data.companyId as string}` });
      reset();
    } else {
      const serverErrors = Array.isArray(data.errors)
        ? (data.errors as { message: string }[]).map((e) => e.message).join("; ")
        : String(data.message ?? "failed");
      setResult({ tone: "error", text: `Error ${res.status} (${String(data.code)}): ${serverErrors}` });
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={handleSubmit(onSubmit)} className="grid max-w-xl gap-3" noValidate>
        <div>
          <Label htmlFor="m-name">Name *</Label>
          <Input id="m-name" {...register("name")} aria-invalid={!!errors.name} />
          <FieldError message={errors.name?.message} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="m-domain">Domain</Label>
            <Input id="m-domain" placeholder="example.com" {...register("domain")} aria-invalid={!!errors.domain} />
            <FieldError message={errors.domain?.message} />
          </div>
          <div>
            <Label htmlFor="m-registry">Registry ID</Label>
            <Input id="m-registry" {...register("registryId")} aria-invalid={!!errors.registryId} />
            <FieldError message={errors.registryId?.message} />
          </div>
          <div>
            <Label htmlFor="m-regtype">Registry type (optional)</Label>
            <Input id="m-regtype" placeholder="e.g. companies-house" {...register("registryType")} />
            <FieldError message={errors.registryType?.message} />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="m-type">Agency type</Label>
            <select id="m-type" {...register("agencyType")} className="flex h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm">
              {["web_development", "custom_software", "mobile_app", "ecommerce", "automation_consultancy", "other_digital"].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="m-country">Country *</Label>
            <Input id="m-country" {...register("country")} aria-invalid={!!errors.country} />
            <FieldError message={errors.country?.message} />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="m-cc">Country code</Label>
            <Input id="m-cc" placeholder="US" {...register("countryCode")} aria-invalid={!!errors.countryCode} />
            <FieldError message={errors.countryCode?.message} />
          </div>
          <div>
            <Label htmlFor="m-region">Region</Label>
            <Input id="m-region" {...register("region")} />
          </div>
          <div>
            <Label htmlFor="m-web">Website</Label>
            <Input id="m-web" placeholder="https://…" {...register("websiteUrl")} />
          </div>
        </div>
        <div>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : "Save agency"}
          </Button>
        </div>
      </form>
      {result && (
        <Alert tone={result.tone === "success" ? "success" : "error"}>{result.text}</Alert>
      )}
    </div>
  );
}
