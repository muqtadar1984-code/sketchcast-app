// Server-side feature flags. Default OFF so nothing lights up in production by
// accident — set the env var to exactly "true" to enable.

import type { SupabaseClient } from "@supabase/supabase-js";
import { consoleModeOn } from "./console-routing";

/**
 * Console subdomain — when NEXT_PUBLIC_CONSOLE_HOST is set (e.g.
 * "console.sketchcast.app"), the staff console moves to its OWN subdomain with its
 * own sign-in (/staff-login), is removed from the main app host, and console access
 * is hard-restricted to @sketchcast.app accounts. Unset ⇒ legacy behavior (console
 * at /console on the main host). The whole feature is one env var — the kill switch.
 * See src/utils/console-routing.ts + docs/CONSOLE.md.
 */
export function consoleSubdomainEnabled(): boolean {
  return consoleModeOn();
}

/**
 * School analytics (Admin / Principal / Coordinator oversight). Gated because it
 * exposes minors' data upward; keep OFF in prod until the RLS migration (0009)
 * is applied and verified on a test tenant.
 */
export function schoolAnalyticsEnabled(): boolean {
  return process.env.FEATURE_SCHOOL_ANALYTICS === "true";
}

/**
 * Tenant-aware variant: the global env flag, OR the per-school override in
 * schools.config (0042) — {"school_analytics": true}. Lets ONE tenant (e.g. the
 * sales demo school) show the leadership suite without lighting it up for every
 * teacher in prod. Reads through the caller's own session client: schools_read
 * RLS only ever returns the user's OWN school row, so this leaks nothing.
 * Best-effort — pre-0042 DBs (no config column) simply resolve to "off".
 */
export async function schoolAnalyticsEnabledFor(
  supabase: SupabaseClient,
  schoolId: string | null | undefined,
): Promise<boolean> {
  if (schoolAnalyticsEnabled()) return true;
  if (!schoolId) return false;
  const { data, error } = await supabase
    .from("schools")
    .select("config")
    .eq("id", schoolId)
    .maybeSingle();
  if (error) return false;
  const cfg = (data?.config ?? null) as { school_analytics?: unknown } | null;
  return cfg?.school_analytics === true;
}

/**
 * School-briefing assistant ("Ask about your school") — the leadership chat on
 * /dashboard/school that answers from a live, RLS-scoped analytics snapshot.
 * Requires the analytics suite to be on for the tenant, then its OWN gate:
 * global env FEATURE_SCHOOL_ASSISTANT, or per-school
 * schools.config {"school_assistant": true} (the demo-tenant rollout path).
 */
export async function schoolAssistantEnabledFor(
  supabase: SupabaseClient,
  schoolId: string | null | undefined,
): Promise<boolean> {
  if (!(await schoolAnalyticsEnabledFor(supabase, schoolId))) return false;
  if (process.env.FEATURE_SCHOOL_ASSISTANT === "true") return true;
  if (!schoolId) return false;
  const { data, error } = await supabase
    .from("schools")
    .select("config")
    .eq("id", schoolId)
    .maybeSingle();
  if (error) return false;
  const cfg = (data?.config ?? null) as { school_assistant?: unknown } | null;
  return cfg?.school_assistant === true;
}

/**
 * Role hats ("one hat at a time") — multi-role adults wear exactly one active
 * hat (principal / coordinator / teacher / parent): only that hat's tabs and
 * surfaces render, switched via the header dropdown or a portal role door.
 * Presentation-only (an active_hat cookie) — RLS and server checks unchanged,
 * so the flag can flip freely. Single-hat users see no difference.
 */
export function roleHatsEnabled(): boolean {
  return process.env.FEATURE_ROLE_HATS === "true";
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

/**
 * Parent portal: parent role, children links, test-paper generation, parent
 * invites. Client surfaces (signup role picker) additionally read
 * NEXT_PUBLIC_FEATURE_PARENT_PORTAL — set both in Vercel; server checks are
 * authoritative. DB guards (kind trigger, child cap) hold regardless.
 */
export function parentPortalEnabled(): boolean {
  return process.env.FEATURE_PARENT_PORTAL === "true";
}

/**
 * AI support agent: "Report an issue" on lessons/papers + automatic diagnosis
 * of failed jobs. The button additionally reads NEXT_PUBLIC_FEATURE_SUPPORT_AGENT
 * (client component); the worker side is gated by SUPPORT_AGENT_ENABLED on
 * Railway. Server checks are authoritative.
 */
export function supportAgentEnabled(): boolean {
  return process.env.FEATURE_SUPPORT_AGENT === "true";
}

/**
 * Stripe billing (adult-only hosted Checkout + Billing Portal, MYR). OFF by
 * default and stays off until Aethel Twin's Stripe account is ready — the
 * guards in src/utils/stripe/guards.ts enforce this server-side.
 */
export function billingEnabled(): boolean {
  return process.env.BILLING_ENABLED === "true";
}

/**
 * AI Tutor ("Ask Coach") — the Pro+ differentiator. A real-time, chapter-locked
 * Socratic tutor. OFF by default; ON during the free trial as the teaser, then
 * gated to the teacher_pro_plus entitlement tier (see the tutor route). The
 * client "Ask Coach" surface additionally reads NEXT_PUBLIC_FEATURE_AI_TUTOR;
 * the server check here is authoritative.
 */
export function aiTutorEnabled(): boolean {
  return process.env.FEATURE_AI_TUTOR === "true";
}

/**
 * Enforce the Pro+ entitlement on the AI Tutor. OFF during the open free trial
 * (the flag above grants access to everyone), ON afterwards so the tutor becomes
 * the paid Pro+ differentiator — gated to teacher_pro_plus / family / school
 * plans on the lesson's owner (see tutorEntitled + planGrantsTutor).
 */
export function aiTutorRequireProPlus(): boolean {
  return process.env.FEATURE_AI_TUTOR_REQUIRE_PROPLUS === "true";
}

/**
 * AI Tutor Phase 2 — the "Draw this" whiteboard sketch. Kept on its OWN flag
 * (separate from FEATURE_AI_TUTOR, which is already live) so the "Draw this"
 * button stays dark until migration 0028 is applied AND the sketch-rendering
 * worker is deployed — otherwise the button would 500. The client "Draw this"
 * surface additionally reads NEXT_PUBLIC_FEATURE_AI_TUTOR_SKETCH; this server
 * check gates the /api/tutor/sketch route and is authoritative.
 */
export function aiTutorSketchEnabled(): boolean {
  return process.env.FEATURE_AI_TUTOR_SKETCH === "true";
}

/**
 * AI Tutor Phase 1 — the persistent TAL teaching board (ERE engine). When ON,
 * Ask Coach answers by drawing on ONE board per session that mutates turn to
 * turn, instead of the stateless clip/text reply. Its own flag so the board
 * rolls out independently and always degrades to the existing text/clip tutor.
 * The client "board" surface additionally reads NEXT_PUBLIC_FEATURE_AI_TUTOR_TAL;
 * the /api/tutor/turn route check here is authoritative.
 */
export function aiTutorTalEnabled(): boolean {
  return process.env.FEATURE_AI_TUTOR_TAL === "true";
}

/**
 * AI Tutor Phase 2 — the shared board runs in the STANDALONE canvas app
 * (board.sketchcast.app), embedded via a sandboxed iframe, so a student can
 * select/point/circle/annotate objects and the tutor perceives those events.
 * This flag gates the scoped board-token mint route + the cross-origin (Bearer)
 * auth path on /api/tutor/turn. OFF by default; requires FEATURE_AI_TUTOR_TAL too
 * (the board itself). The portal iframe surface additionally reads
 * NEXT_PUBLIC_FEATURE_AI_TUTOR_CANVAS + NEXT_PUBLIC_BOARD_URL; when off, the portal
 * falls back to the Phase-1 in-app board, then text.
 */
export function aiTutorCanvasEnabled(): boolean {
  return process.env.FEATURE_AI_TUTOR_CANVAS === "true";
}

/**
 * AI Teaching Assistant — the chat tutor that REPLACES "Ask Coach" as the active
 * student path (the TAL board stays preserved behind FEATURE_AI_TUTOR_TAL, off).
 * Book-first Option-B grounding, swappable LLM provider (Gemini free tier first),
 * constrained SymPy math tool, browser voice. The client launcher additionally
 * reads NEXT_PUBLIC_FEATURE_AI_ASSISTANT; the /api/assistant check here is
 * authoritative. OFF by default.
 */
export function aiAssistantEnabled(): boolean {
  return process.env.FEATURE_AI_ASSISTANT === "true";
}

/**
 * New-joiner profile onboarding — a blocking, one-time setup (confirm Teacher /
 * Parent + fill a short profile) that a new user completes BEFORE using the app,
 * so no one lands as a silently-defaulted teacher. OFF by default; needs migration
 * 0038. The gate lives in the dashboard layout; /api/onboarding writes the
 * confirmed role with the service role.
 */
export function onboardingEnabled(): boolean {
  return process.env.FEATURE_ONBOARDING === "true";
}

/**
 * Autofix — the automated bug-fix pipeline. Staff tap "Attempt auto-fix" on a
 * reported issue → a GitHub Action (Claude Code) writes the fix on a branch + opens
 * a PR → the founder gets an email with signed Approve/Reject links → Approve
 * squash-merges to main (→ prod). OFF by default; needs migration 0039 + the GitHub
 * token/secrets (see docs/AUTOFIX.md). The client console button also reads
 * NEXT_PUBLIC_FEATURE_AUTOFIX; the /api/autofix/* routes check this and are
 * authoritative (they 404 when off — a kill switch for the whole pipeline).
 */
export function autofixEnabled(): boolean {
  return process.env.FEATURE_AUTOFIX === "true";
}
