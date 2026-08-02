import type { SupabaseClient } from "@supabase/supabase-js";
import { noticesEnabledFor } from "./flags";

// School notices — the READ side, shared by BOTH reader surfaces (the featured
// banner and the "Next 10" card) so the two can never disagree about what is
// live, what it counts down to, or how long is left.
//
// A notice IS a school_events row (0068), but the audience alone does NOT make
// one: a holiday an admin put on the whole-school calendar carries audience
// 'school' and is still just a calendar entry. What marks a notice is the
// EXPLICIT is_notice flag the composer sets — without it, every school-wide and
// staff-wide event already in the table would have appeared on the banner, and
// the staff ones would have started demanding a signature from people who never
// agreed to give one. Audience stays in the filter as the shape of what a notice
// may be ('leadership' and 'class' are never announcements). Scoping is RLS's
// job (se_read), not this file's: every query runs through the CALLER'S session
// client, so a parent sees their children's school and no one sees another
// school's board. What we filter for is liveness (published, not yet behind us)
// and the order the countdown implies.
//
// SERVER-ONLY VALUES: this module reads feature flags (process.env). Client
// components may import its TYPES (`import type { Notice }`) but never its
// functions — the countdown is computed server-side and passed down as props,
// which also keeps a rotating banner from hydrating a different label than the
// HTML it replaced.

// Times and day buckets follow the calendar's doctrine (see
// dashboard/calendar/page.tsx): the SCHOOL's timezone, not the reader's, so a
// notice never shows the wrong day for a parent reading from abroad. Malaysia
// is fixed UTC+8 (no DST) — make this per-school config when a school outside
// MY signs up.
const TZ = "Asia/Kuala_Lumpur";
const TZ_OFFSET_MS = 8 * 3600000;
const DAY = 86400000;

/** The composer's own two words for who a notice went to. */
export const AUDIENCE_LABEL: Record<string, string> = {
  school: "Everyone",
  staff: "Staff only",
};

const DATE_FMT = new Intl.DateTimeFormat("en-MY", {
  timeZone: TZ,
  weekday: "short",
  day: "numeric",
  month: "short",
});
const TIME_FMT = new Intl.DateTimeFormat("en-MY", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const WEEKDAY_FMT = new Intl.DateTimeFormat("en-MY", { timeZone: TZ, weekday: "long" });

/** Civil (UTC+8) day number — the unit every countdown counts in. */
function dayIndex(ms: number): number {
  return Math.floor((ms + TZ_OFFSET_MS) / DAY);
}

/** Day number of the Monday that starts this civil week (day 0 = a Thursday). */
function weekStart(idx: number): number {
  return idx - ((idx + 3) % 7);
}

/** Which clock the countdown is running: the deadline, or the event itself. */
export type NoticeClock = "action" | "start";

export type Countdown = {
  /** The instant being counted to (ISO). */
  targetIso: string;
  clock: NoticeClock;
  /** "today" / "tomorrow" / "this Saturday" / "in 3 days" / "yesterday". */
  label: string;
  /** Whole civil days from today — negative once the target is behind us. */
  days: number;
  past: boolean;
  /** Two days out or less (past included) — the marker/amber threshold. */
  urgent: boolean;
};

/** The two dates a countdown may run on. */
type Dated = { starts_at: string | null; action_by: string | null };

/**
 * The TWO-CLOCK countdown. `action_by` runs first while it is still ahead
 * ("Register by Friday"); the moment it passes, the clock FLIPS to `starts_at`
 * so the same row goes on counting down to the event itself. Either date may
 * stand alone: a pure deadline (no starts_at) keeps counting its own date even
 * once it slips past, so the row can say "yesterday" rather than silently
 * losing its clock. Null only for a dateless row, which 0068's
 * school_events_has_a_date constraint forbids.
 */
export function countdownFor(n: Dated, now: number = Date.now()): Countdown | null {
  const action = n.action_by ? Date.parse(n.action_by) : NaN;
  const start = n.starts_at ? Date.parse(n.starts_at) : NaN;
  const hasAction = Number.isFinite(action);
  const hasStart = Number.isFinite(start);
  if (!hasAction && !hasStart) return null;
  const useAction = hasAction && (action > now || !hasStart);
  const target = useAction ? action : start;

  const todayIdx = dayIndex(now);
  const targetIdx = dayIndex(target);
  const days = targetIdx - todayIdx;
  return {
    targetIso: new Date(target).toISOString(),
    clock: useAction ? "action" : "start",
    label: relativeLabel(days, target, todayIdx, targetIdx),
    days,
    past: days < 0,
    urgent: days <= 2,
  };
}

/** Human relative text for a whole-day distance. */
function relativeLabel(days: number, targetMs: number, todayIdx: number, targetIdx: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days < 0) return `${-days} days ago`;
  // Inside the current (Monday-start) week a weekday name is the most
  // actionable form — "this Saturday" beats "in 3 days". Once the target
  // crosses into next week the count is clearer, because a bare weekday then
  // reads ambiguously ("this Tuesday" — which Tuesday?).
  if (days <= 6 && weekStart(targetIdx) === weekStart(todayIdx)) {
    return `this ${WEEKDAY_FMT.format(new Date(targetMs))}`;
  }
  if (days <= 13) return `in ${days} days`;
  if (days <= 59) return `in ${Math.round(days / 7)} weeks`;
  return `in ${Math.round(days / 30)} months`;
}

export type Notice = {
  id: string;
  title: string;
  detail: string | null;
  audience: string;
  /** "Everyone" / "Staff only". */
  audienceLabel: string;
  important: boolean;
  linkUrl: string | null;
  /** Always a word — an unlabelled link still needs a button face. */
  linkLabel: string;
  /** "Register by", "Pay by" — null when the event clock is the one running. */
  actionLabel: string | null;
  featuredUntil: string | null;
  countdown: Countdown;
  /** The exact date behind the countdown: "Register by Fri, 8 Aug". */
  when: string;
  /** THIS viewer is invited to sign — see signerKind(). */
  seeksAck: boolean;
  acked: boolean;
};

/**
 * Who the viewer is when a notice asks for a signature. Acknowledgment has
 * exactly two audiences and they do not overlap:
 *   · staff  — the staff room signs staff notices ("I have read the fire drill")
 *   · parent — parents sign IMPORTANT Everyone notices (the design's whole
 *              point: a permission slip is a parent mechanic)
 * Students are never asked for anything, and a teacher is not asked to
 * acknowledge on a parent's behalf — otherwise the principal's "62%
 * acknowledged" counts a staff room that was never the audience.
 *
 * A parent carries no school_id of their own (they belong through
 * parent_links), which is what tells them apart from a school adult.
 */
function signerKind(role: string | null, schoolId: string | null): "staff" | "parent" | "none" {
  if (!role || role === "student") return "none";
  if (role === "parent") return "parent";
  return schoolId ? "staff" : "parent";
}

export type NoticesData = {
  /** Explicitly pinned and still live — at most 3, soonest-expiring first. */
  featured: Notice[];
  /** The soonest live notices, countdown order. */
  upcoming: Notice[];
};

type NoticeRow = Dated & {
  id: string;
  title: string;
  description: string | null;
  audience: string;
  all_day: boolean;
  link_url: string | null;
  link_label: string | null;
  action_label: string | null;
  featured_until: string | null;
  importance: string | null;
};

const COLUMNS =
  "id, title, description, audience, starts_at, all_day, link_url, link_label, action_by, action_label, featured_until, importance";

/** "Register by Fri, 8 Aug" (deadline clock) or "Sat, 9 Aug · 9:00 am" (event clock). */
function whenText(r: NoticeRow, clock: NoticeClock, target: Date): string {
  if (clock === "action") {
    // action_label already carries its preposition ("Register by"); "By" is the
    // fallback so a label-less deadline still reads as one.
    return `${r.action_label?.trim() || "By"} ${DATE_FMT.format(target)}`;
  }
  return `${DATE_FMT.format(target)}${r.all_day ? "" : ` · ${TIME_FMT.format(target)}`}`;
}

function toNotice(
  r: NoticeRow,
  acked: boolean,
  now: number,
  signer: "staff" | "parent" | "none",
): Notice | null {
  const countdown = countdownFor(r, now);
  if (!countdown) return null;
  const important = r.importance === "important";
  return {
    id: r.id,
    title: r.title,
    detail: r.description,
    audience: r.audience,
    audienceLabel: AUDIENCE_LABEL[r.audience] ?? r.audience,
    important,
    linkUrl: r.link_url,
    linkLabel: r.link_label?.trim() || "Open",
    actionLabel: countdown.clock === "action" ? r.action_label?.trim() || null : null,
    featuredUntil: r.featured_until,
    countdown,
    when: whenText(r, countdown.clock, new Date(countdown.targetIso)),
    // Staff notices ALWAYS seek a signature — from STAFF; an Everyone notice
    // only when it was marked important, and then only from PARENTS. The
    // database never requires an ack — it only invites one, of the one audience
    // it was meant for.
    seeksAck:
      r.audience === "staff"
        ? signer === "staff"
        : r.audience === "school" && important && signer === "parent",
    acked,
  };
}

/**
 * Everything the two reader surfaces need, or null when notices are off for
 * this viewer. ONE call per dashboard: the flag (including the parent's
 * school-through-children fallback) and both lists resolve together, so the
 * banner and the card always read the same board.
 */
export async function noticesFor(
  supabase: SupabaseClient,
  viewer: { userId: string; role: string | null; schoolId: string | null },
  limit = 10,
): Promise<NoticesData | null> {
  // Fast path, not a second gate: this runs on EVERY dashboard load, and the
  // parent fallback below costs a parent_links query for every school-less
  // adult. noticesEnabledFor() is still the authority — it just can't tell
  // "feature off" from "this school hasn't got it" once we're inside the loop.
  if (process.env.FEATURE_NOTICES !== "true") return null;

  let ok = await noticesEnabledFor(supabase, viewer.schoolId);
  // Parents carry no school_id — they belong through their children. Mirror the
  // calendar page exactly: the FIRST child school with the feature on decides
  // (a multi-school parent must not get a surface that dead-ends).
  if (!ok && !viewer.schoolId && viewer.role && viewer.role !== "student") {
    const { data: links } = await supabase
      .from("parent_links")
      .select("profiles:child_id(school_id)")
      .order("created_at")
      .limit(10);
    for (const l of (links ?? []) as unknown as { profiles: { school_id: string | null } | null }[]) {
      const sid = l.profiles?.school_id;
      if (sid && (await noticesEnabledFor(supabase, sid))) {
        ok = true;
        break;
      }
    }
  }
  if (!ok) return null;

  const now = Date.now();
  // Liveness is measured in whole SCHOOL days, so a notice dated today stays up
  // all day instead of expiring at its own start time.
  const todayStartIso = new Date(dayIndex(now) * DAY - TZ_OFFSET_MS).toISOString();
  const nowIso = new Date(now).toISOString();

  const { data, error } = await supabase
    .from("school_events")
    .select(COLUMNS)
    // Revoked notices leave every reader surface (RLS keeps showing them to
    // leadership for audit, so the filter has to be here too).
    .eq("status", "published")
    // Published AS a notice — never an ordinary calendar row that happens to
    // share the audience. See the module note.
    .eq("is_notice", true)
    .in("audience", ["school", "staff"])
    // Still ahead on either clock — or still explicitly pinned: the principal's
    // pin decides how long a banner stays, even once its own date has slipped.
    .or(`starts_at.gte.${todayStartIso},action_by.gte.${todayStartIso},featured_until.gt.${nowIso}`)
    .order("starts_at", { ascending: true, nullsFirst: true })
    .limit(200);
  // Best-effort: a pre-0068 database (no status / is_notice / action_by
  // columns) errors here rather than half-rendering. The flag is the real gate;
  // this is the belt.
  if (error || !data) return { featured: [], upcoming: [] };

  const rows = data as unknown as NoticeRow[];
  // The viewer's own receipts (na_read returns nothing else anyway).
  const acked = new Set<string>();
  if (rows.length) {
    const { data: acks } = await supabase
      .from("notice_acks")
      .select("event_id")
      .eq("user_id", viewer.userId)
      .in(
        "event_id",
        rows.map((r) => r.id),
      );
    for (const a of (acks ?? []) as { event_id: string }[]) acked.add(a.event_id);
  }

  const signer = signerKind(viewer.role, viewer.schoolId);
  const all = rows.map((r) => toNotice(r, acked.has(r.id), now, signer)).filter((n): n is Notice => !!n);

  return {
    // 0068's display rule: over-pinning quietly shows the three soonest-expiring
    // pins rather than failing a principal's compose at 7am.
    featured: all
      .filter((n) => !!n.featuredUntil && Date.parse(n.featuredUntil) > now)
      .sort((a, b) => Date.parse(a.featuredUntil!) - Date.parse(b.featuredUntil!))
      .slice(0, 3),
    upcoming: all
      .filter((n) => !n.countdown.past)
      .sort((a, b) => Date.parse(a.countdown.targetIso) - Date.parse(b.countdown.targetIso))
      .slice(0, limit),
  };
}
