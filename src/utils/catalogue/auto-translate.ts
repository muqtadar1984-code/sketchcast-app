// The Auto Translate Agent's status and controls (plan "SketchCast Feature
// Plan - Auto Translate Agent.md", Revision 3 — founder, 2026-10-20). Pure:
// the page reads platform_settings 'auto_translate' (the founder's controls)
// and 'auto_translate_state' (written by the worker's agent only,
// sketchcast-ai catalogue/auto_translate.py) and hands them here; the agent
// route turns a button into a settings patch here too.
//
// Also "Approve all clean" (plan §5.2): which in-review translations of one
// language are clean enough to approve in one click, and why the rest are not.

import { blockingCount } from "./review-queue";
import type { PrecheckReport } from "./types";

export type AutoTranslateSettings = {
  enabled?: boolean;
  paused?: boolean;
  dry_run?: boolean;
  languages?: string[];
  retranslate?: string[];
  new_since?: string;
  cost_warn_usd?: number;
  summary_email?: string;
  summary_hour_utc?: number;
  /** written by Resume: a clear newer than the breaker's trip lifts it */
  breaker_cleared_at?: string;
};

export type CostWarning = {
  at: string;
  kit_id?: string;
  topic_id?: string;
  language?: string;
  total_usd: number;
  measured_usd?: number;
  text_usd?: number;
  tts_usd?: number;
  tts_estimate_usd?: number;
  images_usd?: number;
  basis?: string;
};

export type AutoTranslateState = {
  last_tick?: string;
  decision?: {
    at?: string;
    action?: "off" | "wait" | "queue";
    why?: string;
    dry_run?: boolean;
    language?: string | null;
    topic?: string | null;
    reason?: string | null;
    retry?: boolean;
  };
  remaining?: Record<string, number>;
  jawi_waiting?: number;
  breaker?: boolean;
  breaker_reason?: string | null;
  paused_until?: string | null;
  last_failure?: { at?: string; error?: string } | null;
  cost_warnings?: CostWarning[];
};

export type AgentMode = "off" | "dry_run" | "running" | "paused" | "breaker" | "throttled" | "silent";

export type AgentView = {
  mode: AgentMode;
  /** one line: what the agent is doing or why it waits */
  headline: string;
  /** the worker's last decision, as written */
  why: string | null;
  remaining: { language: string; n: number }[];
  remainingTotal: number;
  jawiWaiting: number;
  lastTickMinutes: number | null;
  warnings: CostWarning[];
  dryRun: boolean;
  enabled: boolean;
  paused: boolean;
};

/** The worker ticks every minute; this long without a tick while the
 *  agent is on means the worker is not running it (AUTO_TRANSLATE unset,
 *  the worker down or redeploying). */
export const SILENT_AFTER_MINUTES = 5;

export const LANGUAGE_ORDER = ["ar", "ms", "hi", "te", "fr", "es", "pt", "ur", "mr", "ms-arab"] as const;

export function agentView(
  settings: AutoTranslateSettings | null | undefined,
  state: AutoTranslateState | null | undefined,
  nowMs: number,
): AgentView {
  const s = settings ?? {};
  const st = state ?? {};
  const enabled = s.enabled === true;
  const dryRun = s.dry_run !== false;
  const paused = s.paused === true;
  const tick = st.last_tick ? Date.parse(st.last_tick) : NaN;
  const lastTickMinutes = Number.isFinite(tick) ? Math.max(0, Math.round((nowMs - tick) / 60000)) : null;
  const order = s.languages?.length ? s.languages : [...LANGUAGE_ORDER];
  const remaining = order.map((language) => ({ language, n: st.remaining?.[language] ?? 0 }));
  const remainingTotal = remaining.reduce((a, r) => a + r.n, 0);
  const why = st.decision?.why ?? null;
  const until = st.paused_until ? Date.parse(st.paused_until) : NaN;

  let mode: AgentMode;
  let headline: string;
  if (!enabled) {
    mode = "off";
    headline = "Off — nothing is queued.";
  } else if (lastTickMinutes === null || lastTickMinutes > SILENT_AFTER_MINUTES) {
    mode = "silent";
    headline =
      lastTickMinutes === null
        ? "On, but the worker has not run the agent yet (AUTO_TRANSLATE=1 on the worker?)."
        : `On, but the worker has not run the agent for ${lastTickMinutes} min (worker down or AUTO_TRANSLATE unset?).`;
  } else if (paused) {
    mode = "paused";
    headline = "Paused by you — nothing new is queued until Resume.";
  } else if (st.breaker) {
    mode = "breaker";
    headline = `Paused by the breaker: ${st.breaker_reason ?? "failures in a row"}.`;
  } else if (Number.isFinite(until) && until > nowMs) {
    mode = "throttled";
    headline = `Backing off after a throttle until ${new Date(until).toISOString().slice(11, 16)} UTC.`;
  } else if (dryRun) {
    mode = "dry_run";
    headline = st.decision?.topic
      ? `Dry run — would queue ${st.decision.language} · ${st.decision.topic} (${st.decision.reason}).`
      : `Dry run — ${why ?? "waiting"}.`;
  } else {
    mode = "running";
    headline =
      st.decision?.action === "queue"
        ? `Queued ${st.decision.language} · ${st.decision.topic}.`
        : `Running — ${why ?? "waiting"}.`;
  }
  return {
    mode,
    headline,
    why,
    remaining,
    remainingTotal,
    jawiWaiting: st.jawi_waiting ?? 0,
    lastTickMinutes,
    warnings: [...(st.cost_warnings ?? [])].sort((a, b) => b.at.localeCompare(a.at)),
    dryRun,
    enabled,
    paused,
  };
}

// ── controls ────────────────────────────────────────────────────────────────

export const AGENT_CONTROLS = ["on", "off", "pause", "resume", "go_live", "dry_run"] as const;
export type AgentControl = (typeof AGENT_CONTROLS)[number];

export function isAgentControl(v: unknown): v is AgentControl {
  return typeof v === "string" && (AGENT_CONTROLS as readonly string[]).includes(v);
}

/** The settings keys one button writes — merged into the row, never a
 *  replace. Resume also clears the breaker (the worker owns the state row;
 *  it lifts the breaker when it sees a clear newer than the trip). Turning
 *  the agent ON never turns the dry run off: going live is its own button. */
export function controlPatch(action: AgentControl, nowIso: string): Partial<AutoTranslateSettings> {
  switch (action) {
    case "on":
      return { enabled: true };
    case "off":
      return { enabled: false };
    case "pause":
      return { paused: true };
    case "resume":
      return { paused: false, breaker_cleared_at: nowIso };
    case "go_live":
      return { dry_run: false };
    case "dry_run":
      return { dry_run: true };
  }
}

/** The buttons that make sense in a mode: On when off; otherwise Pause or
 *  Resume (Resume also clears a tripped breaker), Go live or Back to dry run,
 *  and Off. */
export function controlsFor(mode: AgentMode, enabled: boolean, dryRun: boolean, paused: boolean): AgentControl[] {
  if (!enabled) return ["on"];
  return [paused || mode === "breaker" ? "resume" : "pause", dryRun ? "go_live" : "dry_run", "off"];
}

// ── Approve all clean ───────────────────────────────────────────────────────

export type CleanKit = {
  id: string;
  topic_id: string;
  language: string;
  status: string;
  translation_status?: string | null;
  precheck?: PrecheckReport | null;
  presentation_generation_id: string | null;
  doc_generation_ids?: Record<string, string | null> | null;
};

export type CleanSource = {
  presentation_generation_id: string | null;
  doc_generation_ids?: Record<string, string | null> | null;
};

export type CleanVerdict = { clean: true } | { clean: false; why: string };

const present = (ids: Record<string, string | null> | null | undefined) =>
  Object.entries(ids ?? {}).filter(([, v]) => typeof v === "string" && v.length > 0) as [string, string][];

/** May this translation be approved by "Approve all clean"? In review; its
 *  pre-checks (A, and C after the render) passed with no blocking finding;
 *  and every piece its English source has is here and finished. Flags that
 *  are not blocking (a redrawn picture, a dropped near-duplicate item) do not
 *  stop it — they are what the one-by-one look and the random checks are for. */
export function cleanVerdict(kit: CleanKit, source: CleanSource | null, genStatus: ReadonlyMap<string, string>): CleanVerdict {
  if (kit.status !== "in_review" || kit.translation_status !== "in_review") {
    return { clean: false, why: `not in review (${kit.status}${kit.translation_status ? ` / ${kit.translation_status}` : ""})` };
  }
  const pre = kit.precheck;
  if (!pre) return { clean: false, why: "not checked" };
  const blocking = blockingCount(pre);
  if (blocking > 0) return { clean: false, why: `${blocking} blocking finding${blocking === 1 ? "" : "s"}` };
  if (pre.ok === false) return { clean: false, why: "the pre-check did not pass" };
  if (pre.post_render && pre.post_render.ok === false) return { clean: false, why: "the post-render check did not pass" };
  if (!source) return { clean: false, why: "the English source kit is gone" };
  const video = kit.presentation_generation_id;
  if (!video) return { clean: false, why: "no video" };
  if (genStatus.get(video) !== "done") return { clean: false, why: `video ${genStatus.get(video) ?? "missing"}` };
  const mine = new Map(present(kit.doc_generation_ids));
  for (const [kind] of present(source.doc_generation_ids)) {
    const gid = mine.get(kind);
    if (!gid) return { clean: false, why: `missing ${kind.replace(/_/g, " ")}` };
    const st = genStatus.get(gid);
    if (st !== "done") return { clean: false, why: `${kind.replace(/_/g, " ")} ${st ?? "missing"}` };
  }
  return { clean: true };
}

/** Every generation id a set of kits and their sources point at. */
export function generationIdsOf(kits: readonly (CleanKit | CleanSource)[]): string[] {
  const ids = new Set<string>();
  for (const k of kits) {
    if (k.presentation_generation_id) ids.add(k.presentation_generation_id);
    for (const [, v] of present(k.doc_generation_ids)) ids.add(v);
  }
  return [...ids];
}

/** Whether the Translations page keeps refreshing itself. Not only while a
 *  cell is queued or translating: between two runs nothing is, for up to a
 *  minute, until the agent's next tick queues the next kit — a page that
 *  stopped there never showed the next run until a manual refresh (founder,
 *  2026-10-23). So it also stays live while the agent will queue more
 *  (running, or throttled and waiting to resume) and while an approved fix
 *  waits for the lane. Paused, off, the breaker and dry run stay quiet. */
export function translationsPageLive(cellsLive: boolean, mode: AgentMode | null | undefined, fixQueued: number): boolean {
  return cellsLive || mode === "running" || mode === "throttled" || fixQueued > 0;
}
