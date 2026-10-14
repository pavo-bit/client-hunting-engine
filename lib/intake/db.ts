// Server-side Postgres access. Docker Compose PostgreSQL, direct pg driver.
// The connection string default targets the LOCAL compose stack
// (localhost-only binding, dev database). Production MUST set DATABASE_URL;
// the value must never reach client code. No Supabase, no remote.

import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ??
        "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel",
      max: 5,
    });
  }
  return pool;
}
