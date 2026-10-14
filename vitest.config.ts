import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import path from "path";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@": root },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 60000,
    // Every suite talks to the SAME local PostgreSQL instance. Running files
    // concurrently lets one file's fixture writes race another file's global
    // assertions (row counts, pending-candidate scans), which makes results
    // non-deterministic. Files therefore run one at a time.
    fileParallelism: false,
  },
});
