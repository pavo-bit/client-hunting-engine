import Link from "next/link";

export default function NotFound() {
  return (
    <div className="space-y-3 py-10 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-slate-600">
        Nothing exists at this address. Brief refs look like{" "}
        <code>BR-2026-001</code>.
      </p>
      <p>
        <Link href="/overview" className="text-blue-700 hover:underline">
          Back to Overview
        </Link>
      </p>
    </div>
  );
}
