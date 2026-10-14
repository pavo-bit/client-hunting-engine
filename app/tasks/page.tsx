import { PlannedPage } from "@/components/planned-page";
import { requireOperatorPage } from "@/lib/auth/guard";

export default async function TasksPage() {
  await requireOperatorPage("/tasks");
  return (
    <PlannedPage
      trail={[{ label: "Sales Workspace" }, { label: "Tasks" }]}
      title="Tasks & Follow-ups"
      description="Planned follow-up tracking for human-led outreach sequences."
      missing={[
        "No task/follow-up table exists in the schema (T-002/T-003 cover companies, evidence, briefs, outcomes only).",
        "No reminder, assignment, or due-date behavior is implemented.",
        "No UI for creating or completing tasks.",
      ]}
      requires="A future schema + implementation decision (owner, timing, scope). Until then, use outcome-log notes for follow-up context."
      links={[
        { label: "Outcome log", href: "/pipeline" },
        { label: "Review queue", href: "/review" },
      ]}
    />
  );
}
