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

/**
 * Teacher beta (capped trial + feedback loop). The flag gates the beta UI
 * surfaces; the caps themselves are DB triggers keyed off profiles.beta_tester
 * (migration 0011), so they hold server-side regardless of this flag.
 */
export function teacherBetaEnabled(): boolean {
  return process.env.FEATURE_TEACHER_BETA === "true";
}

/**
 * Platform console (/console — SketchCast staff only) + in-portal issue
 * reporting. Access itself is gated per-request by requirePlatformAdmin();
 * this flag lets the whole surface stay dark until migration 0014 is applied.
 */
export function platformConsoleEnabled(): boolean {
  return process.env.FEATURE_PLATFORM_CONSOLE === "true";
}
