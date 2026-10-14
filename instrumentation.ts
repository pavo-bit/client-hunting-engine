// MILESTONE 3: production boot validation (Node runtime, runs once at server
// start). Fails CLOSED: a production server without a provisioned operator
// credential (or explicit service token) refuses to boot instead of serving
// open or serving a login that can never succeed. The boot line carries no
// secrets — only booleans and the loopback-verified database host.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getAuthConfig, assertAuthAvailable } = await import("@/lib/auth/config");
    const cfg = getAuthConfig();
    assertAuthAvailable(cfg);
    const dbHost = (() => {
      try {
        return new URL(process.env.DATABASE_URL ?? "postgresql://127.0.0.1/agency_intel").hostname;
      } catch {
        return "unparseable";
      }
    })();
    console.log(
      JSON.stringify({
        event: "boot",
        env: cfg.isProduction ? "production" : "development",
        auth_configured: cfg.configured,
        dev_open: cfg.devOpen,
        service_token_set: cfg.serviceToken !== "",
        db_host: dbHost,
      }),
    );
  }
}
