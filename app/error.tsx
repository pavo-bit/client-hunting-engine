"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("dashboard error:", error);
  }, [error]);
  return (
    <div className="space-y-3 py-10 text-center" role="alert">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-slate-600">
        {error.message || "An unexpected error occurred while loading this page."}{" "}
        {error.digest && <span className="text-xs">(ref {error.digest})</span>}
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        Try again
      </button>
    </div>
  );
}
