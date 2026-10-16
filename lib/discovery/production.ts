// Production adapter wiring (T-006). Only verified live adapters are
// registered here. The fixture stays test-only and is never registered.

import { GleifAdapter } from "./adapters/gleif";
import { GreenhouseAdapter } from "./adapters/greenhouse";
import { AdapterRegistry, createRegistry } from "./registry";

let registry: AdapterRegistry | null = null;

/**
 * Singleton production registry. Registration NEVER executes an adapter.
 * GreenhouseJobBoard is registered PASSIVELY: its `public.source` row ships
 * disabled, so it appears in listings but every run is refused until the
 * licensing decision in docs/P2_SOURCE_SELECTION.md §5 is recorded AND the
 * owner enables the source.
 */
export function getProductionRegistry(): AdapterRegistry {
  if (!registry)
    registry = createRegistry([new GleifAdapter(), new GreenhouseAdapter()]);
  return registry;
}
