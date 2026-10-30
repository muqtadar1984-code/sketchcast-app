// The lesson map of a kit the Board just adopted, prepared AT ADOPT TIME
// (2026-10-31; founder: "upload all the documents … so that it can be started
// at the earliest"). The Board used to ask for the map only when SK first
// needed it, and so SK said "the lesson map isn't ready" mid-lesson.
//
// After POST /api/present/adopt has made her copy, the route schedules this
// (next/server `after`, so the reply is not held): deriveAndStore on her new
// lesson. That either COPIES a ready map another generation holds for the same
// files (the catalogue source's, or another teacher's copy: no model call), or
// — the first copy of a source — derives it once. By the time the Board asks
// (GET /api/sk/manifest) the map is ready, or `building` and polled.
//
// Only for a user the SK Shell is on for (the manifest route's own gate): a map
// nobody will read is not built. One sk_actions row (manifest.build, via
// "adopt"), like the route's POST. Never throws: the Board still asks and
// builds on demand if this did not run.

import { skShellEnabledFor } from "@/utils/flags";
import type { ReadResult } from "@/sk/manifest/store";
import type { DeriveStats } from "@/sk/manifest/service";
import type { SkActionRow } from "@/sk/shell/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type AdoptMapDeps = {
  /** her own session (the Shell gate reads her profile and school as her) */
  session: { auth: { getUser: () => Promise<{ data: { user: any } }> }; from: (table: string) => any };
  /** the service role (sk_manifests, artifacts, storage), as the manifest route uses it */
  admin: unknown;
  derive: (admin: any, generationId: string) => Promise<ReadResult & { stats?: DeriveStats }>;
  audit?: (row: SkActionRow) => Promise<void>;
  shellOn?: typeof skShellEnabledFor;
  now?: () => number;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export type AdoptMapOutcome = { ran: false; why: "no_user" | "shell_off" | "error" } | { ran: true; status: string; copiedFrom: string | null };

export async function prepareAdoptedMap(deps: AdoptMapDeps, kitId: string): Promise<AdoptMapOutcome> {
  const now = deps.now ?? (() => Date.now());
  try {
    const {
      data: { user },
    } = await deps.session.auth.getUser();
    if (!user) return { ran: false, why: "no_user" };
    const { data: profile } = await deps.session.from("profiles").select("role, school_id").eq("id", user.id).maybeSingle();
    const role = (profile?.role as string | null) ?? null;
    const schoolId = (profile?.school_id as string | null) ?? null;
    const shellOn = deps.shellOn ?? skShellEnabledFor;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(await shellOn(deps.session as any, user, role, schoolId))) return { ran: false, why: "shell_off" };
    const started = now();
    const r = await deps.derive(deps.admin, kitId);
    const copiedFrom = r.stats?.copiedFrom ?? null;
    await deps.audit?.({
      actor_id: user.id,
      school_id: schoolId,
      role,
      hat: null,
      action: "manifest.build",
      tier: "queued",
      kind: "job",
      params: { generationId: kitId, via: "adopt" },
      ok: r.status === "ready" || r.status === "building",
      result: { status: r.status, ...(copiedFrom ? { copiedFrom } : {}), ...(r.status !== "ready" && "reason" in r && r.reason ? { reason: r.reason } : {}) },
      error: r.status === "failed" ? ("reason" in r ? r.reason : undefined) : undefined,
      session_id: null,
      generation_id: kitId,
      turn_id: null,
      at: new Date(started).toISOString(),
      ms: now() - started,
    });
    return { ran: true, status: r.status, copiedFrom };
  } catch (e) {
    console.warn("[present/adopt] lesson map not prepared:", (e as Error).message);
    return { ran: false, why: "error" };
  }
}
