// Server-side feature flags. Default OFF so nothing lights up in production by
// accident — set the env var to exactly "true" to enable.

/**
 * School analytics (Admin / Principal / Coordinator oversight). Gated because it
 * exposes minors' data upward; keep OFF in prod until the RLS migration (0009)
 * is applied and verified on a test tenant.
 */
export function schoolAnalyticsEnabled(): boolean {
  return process.env.FEATURE_SCHOOL_ANALYTICS === "true";
}
