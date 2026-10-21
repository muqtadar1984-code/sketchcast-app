import "server-only";
import type { Admin } from "@/app/api/library/lib";
import { OPEN_STATUSES, quotaDay, type AgentSettings, type QueueItem, type Round } from "@/utils/catalogue/youtube-agent";

// The YouTube Publishing Agent's state for the YouTube view (migration 0150):
// the settings row, every OPEN queue item, the last few that finished, the
// open round and whether today's daily round ran. Service role; the page has
// already called requireLibraryMember(). A database without 0150 answers
// { available: false } and the view simply shows no agent panel.

const ITEM_COLUMNS = "id, kit_id, topic_id, language, status, round_id, job_id, attempts, last_error, added_at, updated_at";
const ROUND_COLUMNS = "id, trigger, quota_day, status, created_at, started_at, finished_at, summary";
const RECENT = 30;

export type AgentLoad =
  | { available: false }
  | {
      available: true;
      settings: AgentSettings;
      open: QueueItem[];
      recent: QueueItem[];
      openRound: Round | null;
      dailyDoneToday: boolean;
      lastRound: Round | null;
    };

const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || /youtube_publish_(queue|rounds)/.test(e.message ?? ""));

export async function loadPublishAgent(admin: Admin, nowMs: number = Date.now()): Promise<AgentLoad> {
  const [settingsQ, openQ, recentQ, roundsQ, dailyQ] = await Promise.all([
    admin.from("platform_settings").select("value").eq("key", "youtube_publish_agent").maybeSingle(),
    admin.from("youtube_publish_queue").select(ITEM_COLUMNS).in("status", [...OPEN_STATUSES]).order("added_at"),
    admin.from("youtube_publish_queue").select(ITEM_COLUMNS).not("status", "in", `(${OPEN_STATUSES.join(",")})`).order("updated_at", { ascending: false }).limit(RECENT),
    admin.from("youtube_publish_rounds").select(ROUND_COLUMNS).order("created_at", { ascending: false }).limit(5),
    admin.from("youtube_publish_rounds").select("id").eq("trigger", "daily").eq("quota_day", quotaDay(nowMs)).limit(1),
  ]);
  if ([openQ.error, recentQ.error, roundsQ.error, dailyQ.error].some(missing)) return { available: false };
  const failed = settingsQ.error ?? openQ.error ?? recentQ.error ?? roundsQ.error ?? dailyQ.error;
  if (failed) throw new Error(failed.message);
  const rounds = (roundsQ.data ?? []) as Round[];
  return {
    available: true,
    settings: ((settingsQ.data?.value ?? {}) as AgentSettings) || {},
    open: (openQ.data ?? []) as QueueItem[],
    recent: (recentQ.data ?? []) as QueueItem[],
    openRound: rounds.find((r) => r.status === "requested" || r.status === "running") ?? null,
    dailyDoneToday: (dailyQ.data ?? []).length > 0,
    lastRound: rounds.find((r) => r.status === "done") ?? null,
  };
}
