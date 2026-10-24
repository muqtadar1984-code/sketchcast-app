// Pure rules for the Pinterest Pin Engine's Library controls (feature guide
// + build plan, Edtech/docs/feature-guides/pinterest-pin-engine*.md;
// migration 0154). No I/O: the routes (/api/library/pinterest/*), the loader
// and the screens share one answer, and the rules are unit-tested without a
// database.
//
// Pinterest's Developer Guidelines: "if your app allows end users to schedule
// Pin publishing, the end user must choose each Pin to be published" — so a
// pin is approved ONE AT A TIME by a platform admin (decision D1: no
// select-all, no bulk approve), and nothing here approves more than one pin.
// The worker (sketchcast-ai catalogue/pinterest/agent.py) then posts approved
// pins in rounds: at most `per_language_per_day` per language per UTC day
// after `daily_at`, plus "Run once more". It re-checks every gate before it
// posts; these rules are what the console shows and what the routes refuse.

export type PinStatus =
  | "draft" | "in_review" | "approved" | "scheduled" | "posting" | "posted" | "rejected" | "failed" | "retired";
export type PinFormat = "static" | "carousel" | "video";
export type PinImage = { path: string; width?: number; height?: number; bytes?: number; dominant_color?: string };
export type Precheck = { blocking?: string[]; warnings?: string[]; checked_at?: string };

export type Pin = {
  id: string;
  source_kind: string;
  source_ref: string;
  topic_id: string | null;
  kit_id: string | null;
  language: string;
  format: PinFormat;
  template: string;
  board_id: string | null;
  grade_band: string | null;
  title: string | null;
  description: string | null;
  alt_text: string | null;
  link: string | null;
  back_translation: { title?: string; description?: string; alt_text?: string } | null;
  ai_modified: boolean;
  images: PinImage[];
  status: PinStatus;
  precheck: Precheck | null;
  edited: boolean;
  reject_reason: string | null;
  approved_by: string | null;
  approved_at: string | null;
  round_id: string | null;
  pinterest_pin_id: string | null;
  posted_at: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

/** A pin as the console shows it: signed image URLs, its topic and board names. */
export type PinView = Pin & { imageUrls: (string | null)[]; topicTitle: string | null; boardName: string | null };
export type PinStats = { d7: { impression: number; save: number; outbound: number }; d30: { impression: number; save: number; outbound: number } };

export type BoardStatus = "planned" | "approved" | "created" | "archived";
export type Board = {
  id: string;
  language: string;
  board_key: string;
  name: string;
  description: string;
  status: BoardStatus;
  pinterest_board_id: string | null;
  approved_at: string | null;
};

export type RoundStatus = "requested" | "running" | "done";
export type Round = {
  id: string;
  trigger: "daily" | "manual";
  day: string;
  status: RoundStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  summary: Record<string, unknown> | null;
};

export type AgentSettings = {
  enabled?: boolean;
  dry_run?: boolean;
  paused?: boolean;
  daily_at?: string;
  per_language_per_day?: number;
  languages?: string[];
  min_topic_gap_days?: number;
  post_gap_minutes?: number;
  max_waiting_per_language?: number;
  summary_email?: string | null;
  breaker?: { tripped?: boolean; failures?: number; reason?: string; tripped_at?: string };
};

// ── actions ──────────────────────────────────────────────────────────────────

export type PinAction = "approve" | "unapprove" | "reject" | "edit" | "rerender" | "retry";
export const PIN_ACTIONS: readonly PinAction[] = ["approve", "unapprove", "reject", "edit", "rerender", "retry"];
export const isPinAction = (v: unknown): v is PinAction => typeof v === "string" && (PIN_ACTIONS as readonly string[]).includes(v);

export type AgentAction = "run_once" | "pause" | "resume" | "clear_breaker";
export const AGENT_ACTIONS: readonly AgentAction[] = ["run_once", "pause", "resume", "clear_breaker"];
export const isAgentAction = (v: unknown): v is AgentAction => typeof v === "string" && (AGENT_ACTIONS as readonly string[]).includes(v);

export type BoardAction = "edit" | "approve";
export const BOARD_ACTIONS: readonly BoardAction[] = ["edit", "approve"];
export const isBoardAction = (v: unknown): v is BoardAction => typeof v === "string" && (BOARD_ACTIONS as readonly string[]).includes(v);

// ── Pinterest's limits (API spec v5) ─────────────────────────────────────────

export const LIMITS = { title: 100, description: 800, alt_text: 500, link: 2048, reject_reason: 300 } as const;
/** What a feed shows of a title before it truncates (Pinterest product specs). */
export const TITLE_FEED_CHARS = 40;

export type Ok = { ok: true } | { ok: false; why: string };
const no = (why: string): Ok => ({ ok: false, why });
const OK: Ok = { ok: true };

const filled = (s: string | null | undefined) => !!s && s.trim().length > 0;
const len = (s: string | null | undefined) => [...(s ?? "")].length; // code points, as Pinterest counts

/** The copy checks the console can make on its own — lengths and presence.
 *  The worker's prechecks (numbers in the article, claims, language, link
 *  200, image measurements) arrive in `pin.precheck` and are never re-run
 *  here; an edit clears them until the worker re-checks (see editPatch). */
export function copyProblems(p: { title?: string | null; description?: string | null; alt_text?: string | null }): string[] {
  const out: string[] = [];
  if (!filled(p.title)) out.push("The title is empty.");
  else if (len(p.title) > LIMITS.title) out.push(`The title is ${len(p.title)} characters; Pinterest allows ${LIMITS.title}.`);
  if (!filled(p.description)) out.push("The description is empty.");
  else if (len(p.description) > LIMITS.description) out.push(`The description is ${len(p.description)} characters; Pinterest allows ${LIMITS.description}.`);
  if (!filled(p.alt_text)) out.push("The alt text is empty — every pin needs one.");
  else if (len(p.alt_text) > LIMITS.alt_text) out.push(`The alt text is ${len(p.alt_text)} characters; Pinterest allows ${LIMITS.alt_text}.`);
  return out;
}

/** The part of the title a feed shows, for the review card's marker. */
export function feedTitle(title: string | null | undefined): { shown: string; hidden: string } {
  const cps = [...(title ?? "")];
  return { shown: cps.slice(0, TITLE_FEED_CHARS).join(""), hidden: cps.slice(TITLE_FEED_CHARS).join("") };
}

// ── what an admin may do to one pin ──────────────────────────────────────────

export function canApprove(pin: Pick<Pin, "status" | "precheck" | "images" | "board_id" | "link" | "title" | "description" | "alt_text">): Ok {
  if (pin.status !== "in_review") return no(`Only a pin in review can be approved (this one is ${STATUS_LABEL[pin.status].toLowerCase()}).`);
  const blocking = pin.precheck?.blocking ?? [];
  if (!pin.precheck?.checked_at) return no("The worker has not checked this pin since it changed — wait for its prechecks.");
  if (blocking.length) return no(`Prechecks block it: ${blocking.join("; ")}`);
  const copy = copyProblems(pin);
  if (copy.length) return no(copy.join(" "));
  if (!pin.images?.length) return no("The pin has no image.");
  if (!pin.board_id) return no("The pin has no board.");
  if (!filled(pin.link)) return no("The pin has no link.");
  return OK;
}

/** Undo an approval: only while the pin waits for a round. Once a round has
 *  scheduled it, the worker owns it (Reject still works until it posts). */
export const canUnapprove = (pin: Pick<Pin, "status">): Ok =>
  pin.status === "approved" ? OK : no("Only an approved pin that is not yet scheduled can go back to review.");

export function canReject(pin: Pick<Pin, "status">, reason: string): Ok {
  if (!["in_review", "approved", "failed"].includes(pin.status)) return no("Only a pin in review, approved (not yet scheduled) or failed can be rejected.");
  if (!reason.trim()) return no("Say why — the reason teaches the next drafts.");
  if (len(reason) > LIMITS.reject_reason) return no(`Keep the reason under ${LIMITS.reject_reason} characters.`);
  return OK;
}

export const canEdit = (pin: Pick<Pin, "status">): Ok =>
  pin.status === "in_review" || pin.status === "approved" ? OK : no("Only a pin in review or approved (not yet scheduled) can be edited.");

/** A pin already on Pinterest is never redrawn: after a fresh review it would
 *  post a second time. */
export const canRerender = (pin: Pick<Pin, "status" | "pinterest_pin_id">): Ok =>
  pin.pinterest_pin_id
    ? no("This pin is already on Pinterest.")
    : ["in_review", "failed", "rejected"].includes(pin.status)
      ? OK
      : no("Only a pin in review, failed or rejected can be re-rendered.");

/** Retry is for a pin that failed while POSTING — it was approved once. A pin
 *  that failed while drafting was never reviewed, so it is re-rendered and
 *  reviewed instead; retrying it would skip the human choice. */
export const canRetry = (pin: Pick<Pin, "status" | "pinterest_pin_id" | "approved_at">): Ok =>
  pin.status !== "failed"
    ? no("Only a failed pin can be retried.")
    : pin.pinterest_pin_id
      ? no("This pin is already on Pinterest.")
      : !pin.approved_at
        ? no("This pin failed before review — re-render it and review it instead.")
        : OK;

export type EditInput = { title?: unknown; description?: unknown; alt_text?: unknown };

/** The row update an edit makes, or why it is refused. An edit sends the pin
 *  back to review, clears its approval, and clears the worker's prechecks
 *  (`checked_at`) so it cannot be approved until the worker re-checks the
 *  new copy — the console's own length checks are not the whole gate. */
export function editPatch(pin: Pick<Pin, "status" | "title" | "description" | "alt_text">, input: EditInput):
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; why: string } {
  const can = canEdit(pin);
  if (!can.ok) return can;
  const next = {
    title: typeof input.title === "string" ? input.title.trim() : pin.title,
    description: typeof input.description === "string" ? input.description.trim() : pin.description,
    alt_text: typeof input.alt_text === "string" ? input.alt_text.trim() : pin.alt_text,
  };
  const problems = copyProblems(next);
  if (problems.length) return { ok: false, why: problems.join(" ") };
  if (next.title === pin.title && next.description === pin.description && next.alt_text === pin.alt_text) {
    return { ok: false, why: "Nothing changed." };
  }
  return {
    ok: true,
    patch: {
      ...next,
      edited: true,
      status: "in_review",
      approved_by: null,
      approved_at: null,
      precheck: { blocking: [], warnings: [], edited_at: new Date().toISOString() },
    },
  };
}

// ── boards ───────────────────────────────────────────────────────────────────

export const BOARD_LIMITS = { name: 180, description: 500 } as const;

export function boardEditPatch(board: Pick<Board, "status">, input: { name?: unknown; description?: unknown }):
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; why: string } {
  if (board.status !== "planned") return { ok: false, why: "Only a planned board can be edited — once approved, the worker creates it on Pinterest." };
  const patch: Record<string, unknown> = {};
  if (typeof input.name === "string") {
    const n = input.name.trim();
    if (!n) return { ok: false, why: "The board needs a name." };
    if (len(n) > BOARD_LIMITS.name) return { ok: false, why: `Keep the name under ${BOARD_LIMITS.name} characters.` };
    patch.name = n;
  }
  if (typeof input.description === "string") {
    const d = input.description.trim();
    if (len(d) > BOARD_LIMITS.description) return { ok: false, why: `Keep the description under ${BOARD_LIMITS.description} characters.` };
    patch.description = d;
  }
  if (!Object.keys(patch).length) return { ok: false, why: "Nothing changed." };
  return { ok: true, patch };
}

export const canApproveBoard = (board: Pick<Board, "status" | "name">): Ok =>
  board.status !== "planned" ? no("This board is already approved.") : filled(board.name) ? OK : no("The board needs a name.");

// ── the agent ────────────────────────────────────────────────────────────────

export const DEFAULT_DAILY_AT = "21:00"; // UTC, inside the 20:00–05:00 off-peak window
export const DEFAULT_TOPIC_GAP_DAYS = 7;

/** `daily_at` ("HH:MM", UTC) as minutes after midnight; nonsense falls back
 *  to the default. The worker reads the same setting. */
export function dailyMinutes(settings: AgentSettings | null | undefined): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((settings?.daily_at ?? "").trim());
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return Number(m[1]) * 60 + Number(m[2]);
  const [h, mm] = DEFAULT_DAILY_AT.split(":").map(Number);
  return h * 60 + mm;
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** When the next daily round starts (epoch ms). If today's has not run yet
 *  and its time has passed, it is "now" (the worker's next tick). */
export function nextDailyRound(settings: AgentSettings | null | undefined, nowMs: number, dailyDoneToday: boolean): number {
  const at = dailyMinutes(settings);
  const midnight = Date.parse(`${utcDay(nowMs)}T00:00:00Z`);
  const today = midnight + at * 60_000;
  if (!dailyDoneToday) return Math.max(today, nowMs);
  return today + 86_400_000;
}

export function runOnceAccepts(openRound: Pick<Round, "status"> | null, approvedWaiting: number, settings: AgentSettings): Ok {
  if (!settings.enabled) return no("The agent is switched off.");
  if (settings.paused) return no("The agent is paused — resume it first.");
  if (settings.breaker?.tripped) return no("The breaker has tripped — clear it first.");
  if (openRound) return no("A round is already in progress — it posts one pin at a time.");
  if (approvedWaiting <= 0) return no("No approved pin is waiting.");
  return OK;
}

const DAY = 86_400_000;

/** Whether a topic may post again in this language: never twice within
 *  `min_topic_gap_days`, so the account does not look repetitive. */
export function topicGapOk(lastPostedAt: string | null | undefined, nowMs: number, gapDays = DEFAULT_TOPIC_GAP_DAYS): boolean {
  if (!lastPostedAt) return true;
  const t = Date.parse(lastPostedAt);
  return Number.isNaN(t) || nowMs - t >= gapDays * DAY;
}

/** What the next round would post: per language in `settings.languages`, the
 *  oldest approved pins (up to per_language_per_day) whose topic passes the
 *  gap — the worker's pick, shown in the panel. */
export function nextRoundPreview(
  approved: Pick<Pin, "id" | "language" | "topic_id" | "approved_at" | "title">[],
  lastPostedByTopicLang: Record<string, string>,
  settings: AgentSettings,
  nowMs: number,
): { language: string; pins: { id: string; title: string | null }[]; waiting: number; heldByGap: number }[] {
  const languages = settings.languages?.length ? settings.languages : ["en"];
  const per = Math.max(1, Math.min(5, Math.floor(settings.per_language_per_day ?? 1)));
  const gap = settings.min_topic_gap_days ?? DEFAULT_TOPIC_GAP_DAYS;
  return languages.map((language) => {
    const mine = approved
      .filter((p) => p.language === language)
      .sort((a, b) => (a.approved_at ?? "").localeCompare(b.approved_at ?? ""));
    const picked: { id: string; title: string | null }[] = [];
    const takenTopics = new Set<string>();
    let heldByGap = 0;
    for (const p of mine) {
      // the gap is per topic; a pin with no topic (a book, later) has none
      const last = p.topic_id ? lastPostedByTopicLang[`${p.topic_id}|${language}`] : null;
      if (!topicGapOk(last, nowMs, gap) || (p.topic_id && takenTopics.has(p.topic_id))) {
        heldByGap += 1;
        continue;
      }
      if (picked.length < per) {
        picked.push({ id: p.id, title: p.title });
        if (p.topic_id) takenTopics.add(p.topic_id);
      }
    }
    return { language, pins: picked, waiting: mine.length, heldByGap };
  });
}

// ── labels ───────────────────────────────────────────────────────────────────

export const STATUS_LABEL: Record<PinStatus, string> = {
  draft: "Drafting",
  in_review: "In review",
  approved: "Approved",
  scheduled: "Scheduled",
  posting: "Posting",
  posted: "Posted",
  rejected: "Rejected",
  failed: "Failed",
  retired: "Retired",
};

export type Tone = "neutral" | "info" | "good" | "warn" | "bad";
export const STATUS_TONE: Record<PinStatus, Tone> = {
  draft: "neutral",
  in_review: "info",
  approved: "good",
  scheduled: "good",
  posting: "info",
  posted: "good",
  rejected: "neutral",
  failed: "bad",
  retired: "neutral",
};

/** A dry-run post leaves `dryrun:<id>` instead of a Pinterest id. */
export const isDryRun = (pinterestPinId: string | null | undefined) => !!pinterestPinId && pinterestPinId.startsWith("dryrun:");

export const pinUrl = (pinterestPinId: string | null | undefined): string | null =>
  pinterestPinId && !isDryRun(pinterestPinId) ? `https://www.pinterest.com/pin/${encodeURIComponent(pinterestPinId)}/` : null;
