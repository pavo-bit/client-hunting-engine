// Production adapter wiring (T-006). Only verified live adapters are
// registered here. The fixture stays test-only and is never registered.

import { GleifAdapter } from "./adapters/gleif";
import { AdapterRegistry, createRegistry } from "./registry";

let registry: AdapterRegistry | null = null;

/** Singleton production registry (GLEIF only, until further D-003 decisions). */
export function getProductionRegistry(): AdapterRegistry {
  if (!registry) registry = createRegistry([new GleifAdapter()]);
  return registry;
}
