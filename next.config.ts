import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Internal tool; no image optimization or telemetry assumptions.
  // Pin tracing root: a parent directory holds an unrelated lockfile.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
