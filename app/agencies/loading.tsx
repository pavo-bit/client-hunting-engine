import { Skeleton } from "@/components/ui/card";

export default function AgenciesLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading agencies">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-96" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
