import { NextRequest, NextResponse } from "next/server";
import { createRegistry } from "@/lib/discovery/registry";
import { AgencyDirectoryFixture } from "@/lib/discovery/fixtures/agency-directory";
import { requireOperatorApi } from "@/lib/auth/guard";

/**
 * GET /api/adapters — read-only registry listing (sanitized metadata only).
 * Fixture adapters are registered here for inspection; production registers
 * none. Listing never executes adapters or touches the network, and responses
 * carry metadata only (no configuration values of any kind).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireOperatorApi(req);
  if (!auth.ok) return auth.response!;
  const registry = createRegistry([new AgencyDirectoryFixture()]);
  return NextResponse.json(
    {
      contractVersion: 1,
      adapters: registry.list(),
      note: "Fixture only — no live discovery. See Source Registry for the 12 approved categories and their access rules.",
    },
    { status: 200 },
  );
}
