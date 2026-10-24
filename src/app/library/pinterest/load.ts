import "server-only";
import type { Admin } from "@/app/api/library/lib";
import { utcDay, type AgentSettings, type Board, type Pin, type PinStats, type PinView, type Round } from "@/utils/catalogue/pinterest";

// The Pinterest tab's reads (migration 0154). Service role; every page has
// already called requireLibraryMember(). A database without 0154 answers
// { available: false } and the pages say which migration to apply.

const PIN_COLUMNS =
  "id, source_kind, source_ref, topic_id, kit_id, language, format, template, board_id, grade_band, title, description, " +
  "alt_text, link, back_translation, ai_modified, images, status, precheck, edited, reject_reason, approved_by, approved_at, " +
  "round_id, pinterest_pin_id, posted_at, attempts, last_error, created_at, updated_at";
const BOARD_COLUMNS = "id, language, board_key, name, description, status, pinterest_board_id, approved_at";
const ROUND_COLUMNS = "id, trigger, day, status, created_at, started_at, finished_at, summary";
const SIGN_TTL_SECONDS = 60 * 60;
const REVIEW_LIMIT = 60;
const COUNTED = ["in_review", "approved", "scheduled", "posting", "posted", "failed", "rejected"] as const;
const POSTED_LIMIT = 60;

export type PinterestLoad =
  | { available: false }
  | {
      available: true;
      settings: AgentSettings;
      boards: Board[];
      counts: Record<string, number>;
      review: PinView[];
      approved: PinView[];
      scheduled: PinView[];
      failed: PinView[];
      rejected: PinView[];
      posted: PinView[];
      stats: Record<string, PinStats>;
      openRound: Round | null;
      lastRound: Round | null;
      dailyDoneToday: boolean;
      lastPostedByTopicLang: Record<string, string>;
    };

const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || /pinterest_/.test(e.message ?? ""));

export async function loadPinterest(admin: Admin, nowMs: number = Date.now()): Promise<PinterestLoad> {
  // per-status counts as head queries: exact past PostgREST's 1000-row page
  const countQs = COUNTED.map((s) => admin.from("pinterest_pins").select("id", { count: "exact", head: true }).eq("status", s));
  const [settingsQ, boardsQ, reviewQ, approvedQ, scheduledQ, failedQ, postedQ, roundsQ, dailyQ, rejectedQ] = await Promise.all([
    admin.from("platform_settings").select("value").eq("key", "pinterest_agent").maybeSingle(),
    admin.from("pinterest_boards").select(BOARD_COLUMNS).order("language").order("board_key"),
    admin.from("pinterest_pins").select(PIN_COLUMNS).eq("status", "in_review").order("created_at").limit(REVIEW_LIMIT),
    admin.from("pinterest_pins").select(PIN_COLUMNS).eq("status", "approved").order("approved_at"),
    admin.from("pinterest_pins").select(PIN_COLUMNS).in("status", ["scheduled", "posting"]).order("approved_at"),
    admin.from("pinterest_pins").select(PIN_COLUMNS).eq("status", "failed").order("updated_at", { ascending: false }).limit(30),
    admin.from("pinterest_pins").select(PIN_COLUMNS).eq("status", "posted").order("posted_at", { ascending: false }).limit(POSTED_LIMIT),
    admin.from("pinterest_publish_rounds").select(ROUND_COLUMNS).order("created_at", { ascending: false }).limit(5),
    admin.from("pinterest_publish_rounds").select("id").eq("trigger", "daily").eq("day", utcDay(nowMs)).limit(1),
    admin.from("pinterest_pins").select(PIN_COLUMNS).eq("status", "rejected").order("updated_at", { ascending: false }).limit(40),
  ]);
  const countRs = await Promise.all(countQs);
  const all = [boardsQ, reviewQ, approvedQ, scheduledQ, failedQ, postedQ, roundsQ, dailyQ, rejectedQ, ...countRs];
  if (all.some((q) => missing(q.error))) return { available: false };
  const failedQuery = settingsQ.error ?? all.find((q) => q.error)?.error;
  if (failedQuery) throw new Error(failedQuery.message);

  const boards = (boardsQ.data ?? []) as Board[];
  const boardName = new Map(boards.map((b) => [b.id, b.name]));
  const counts: Record<string, number> = {};
  COUNTED.forEach((s, i) => (counts[s] = countRs[i].count ?? 0));

  const lists = [reviewQ, approvedQ, scheduledQ, failedQ, postedQ, rejectedQ].map((q) => (q.data ?? []) as unknown as Pin[]);
  const everyPin = lists.flat();

  // topic titles, one read
  const topicIds = [...new Set(everyPin.map((p) => p.topic_id).filter((x): x is string => !!x))];
  const titles = new Map<string, string>();
  if (topicIds.length) {
    const t = await admin.from("topics").select("id, title").in("id", topicIds);
    for (const r of (t.data ?? []) as { id: string; title: string }[]) titles.set(r.id, r.title);
  }

  // images: signed for an hour, for the cards a reviewer looks at
  const paths = [...new Set(everyPin.flatMap((p) => (p.images ?? []).map((i) => i.path)).filter(Boolean))];
  const signed = new Map<string, string>();
  if (paths.length) {
    const { data } = await admin.storage.from("pinterest-pins").createSignedUrls(paths, SIGN_TTL_SECONDS);
    for (const u of data ?? []) if (u?.path && u.signedUrl && !u.error) signed.set(u.path, u.signedUrl);
  }
  const view = (p: Pin): PinView => ({
    ...p,
    images: p.images ?? [],
    imageUrls: (p.images ?? []).map((i) => signed.get(i.path) ?? null),
    topicTitle: p.topic_id ? titles.get(p.topic_id) ?? null : null,
    boardName: p.board_id ? boardName.get(p.board_id) ?? null : null,
  });
  const [review, approved, scheduled, failed, posted, rejected] = lists.map((l) => l.map(view));

  // the topic gap: when each topic last posted in each language
  const lastPostedByTopicLang: Record<string, string> = {};
  const recentPosts = await admin
    .from("pinterest_pins")
    .select("topic_id, language, posted_at")
    .eq("status", "posted")
    .gte("posted_at", new Date(nowMs - 30 * 86_400_000).toISOString());
  for (const r of (recentPosts.data ?? []) as { topic_id: string | null; language: string; posted_at: string | null }[]) {
    if (!r.posted_at) continue;
    const key = `${r.topic_id ?? ""}|${r.language}`;
    if (!lastPostedByTopicLang[key] || lastPostedByTopicLang[key] < r.posted_at) lastPostedByTopicLang[key] = r.posted_at;
  }

  // 7- and 30-day totals for the posted list
  const stats: Record<string, PinStats> = {};
  if (posted.length) {
    const since30 = utcDay(nowMs - 30 * 86_400_000);
    const since7 = utcDay(nowMs - 7 * 86_400_000);
    const s = await admin
      .from("pinterest_pin_stats")
      .select("pin_row_id, day, impression, save, outbound_click")
      .in("pin_row_id", posted.map((p) => p.id))
      .gte("day", since30);
    for (const r of (s.data ?? []) as { pin_row_id: string; day: string; impression: number | null; save: number | null; outbound_click: number | null }[]) {
      const e = (stats[r.pin_row_id] ??= { d7: { impression: 0, save: 0, outbound: 0 }, d30: { impression: 0, save: 0, outbound: 0 } });
      const add = (b: PinStats["d7"]) => {
        b.impression += r.impression ?? 0;
        b.save += r.save ?? 0;
        b.outbound += r.outbound_click ?? 0;
      };
      add(e.d30);
      if (r.day >= since7) add(e.d7);
    }
  }

  const rounds = (roundsQ.data ?? []) as Round[];
  return {
    available: true,
    settings: ((settingsQ.data?.value ?? {}) as AgentSettings) || {},
    boards,
    counts,
    review,
    rejected,
    approved,
    scheduled,
    failed,
    posted,
    stats,
    openRound: rounds.find((r) => r.status === "requested" || r.status === "running") ?? null,
    lastRound: rounds.find((r) => r.status === "done") ?? null,
    dailyDoneToday: (dailyQ.data ?? []).length > 0,
    lastPostedByTopicLang,
  };
}
