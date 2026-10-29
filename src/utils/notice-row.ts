// The school notice row — ONE builder for every writer (0068; SK S5 slice D).
//
// A notice IS a school_events row with is_notice = true. Two writers publish
// one: the composer's POST /api/notices and SK's click-only `notice.school`
// action (/api/sk/act → src/sk/shell/act-notice.ts). Both shape the row here,
// so the rules a notice must meet live in one place: moved out of the route
// verbatim (messages included), never copied.
//
//   validateNotice(input, now) — the shape checks (title, body, audience,
//     link, the two clocks, the pin). Pure; every failure is a 400 with the
//     composer's own wording and a stable `code` for callers that speak their
//     own line (SK).
//   buildNoticeRow(fields, who) — the row to insert AS THE CALLER (session
//     client). RLS (se_admin_write / se_coordinator_write) is the authority
//     on who may publish where; this only shapes.
//
// Pure, no server imports: safe on either side of the server/client boundary.

export const NOTICE_AUDIENCES = ["school", "staff"] as const;
export type NoticeAudience = (typeof NOTICE_AUDIENCES)[number];
export const NOTICE_KINDS = ["meeting", "exam", "holiday", "activity", "pd", "other"] as const;
export const NOTICE_TITLE_MAX = 120;
export const NOTICE_BODY_MAX = 4000;

// https ONLY — stricter than 0068's `^https?://` check on purpose. The banner
// renders this as an <a href>, and a notice link is a thing a whole school is
// asked to tap: sending them somewhere unencrypted is a mistake worth refusing
// at the composer rather than storing. javascript:/data: are refused twice over.
const HTTPS_RE = /^https:\/\/[^\s<>"']+$/i;
const MAX_LINK = 500;

// A banner pin is meant to expire on its own. A year-long pin is the same
// problem as no pin at all (the banner stops being news), so the app caps what
// the composer may ask for; the column itself stays free-form for the seed and
// for any future longer-lived surface.
const MAX_PIN_DAYS = 60;

// The reader surfaces measure liveness in whole SCHOOL days, not to the minute
// (utils/notices.ts — Malaysia is a fixed UTC+8, no DST), so a notice dated
// earlier TODAY is still live and must not be refused as stale here.
const TZ_OFFSET_MS = 8 * 3600000;
const DAY = 86400000;

/** Midnight in the school's timezone, as epoch ms — the staleness boundary. */
export function schoolDayStart(now: number): number {
  return Math.floor((now + TZ_OFFSET_MS) / DAY) * DAY - TZ_OFFSET_MS;
}

/** A school day (YYYY-MM-DD) → the instant it starts in the school's zone. */
export function schoolDayInstant(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00.000+08:00`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** What a writer asks for (the composer's POST body shape). */
export type NoticeInput = {
  title?: string;
  body?: string;
  audience?: string;
  kind?: string;
  link_url?: string | null;
  link_label?: string | null;
  startsAt?: string | null;
  actionBy?: string | null;
  actionLabel?: string | null;
  importance?: string;
  featuredUntil?: string | null;
};

/** The validated notice fields (columns, minus who/where). */
export type NoticeFields = {
  title: string;
  description: string | null;
  kind: string;
  audience: NoticeAudience;
  starts_at: string | null;
  link_url: string | null;
  link_label: string | null;
  action_by: string | null;
  action_label: string | null;
  featured_until: string | null;
  importance: "normal" | "important";
};

export type NoticeErrorCode =
  | "title_required"
  | "title_too_long"
  | "body_too_long"
  | "audience"
  | "link_too_long"
  | "link_not_https"
  | "link_label_too_long"
  | "bad_date"
  | "no_date"
  | "deadline_after_event"
  | "dates_passed"
  | "action_label_too_long"
  | "pin_past"
  | "pin_too_long";

export type NoticeValidation = { ok: true; fields: NoticeFields } | { ok: false; code: NoticeErrorCode; error: string };

/** Optional instant → stored ISO. Three outcomes on purpose: `null` = the field
 * was left empty (legitimate — every date here is optional on its own),
 * `undefined` = something was sent that isn't a date, which the caller turns
 * into a 400 rather than silently dropping a deadline the publisher typed. */
function instant(v: unknown): string | null | undefined {
  if (v == null || v === "") return null;
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

const bad = (code: NoticeErrorCode, error: string): NoticeValidation => ({ ok: false, code, error });

/** Every shape rule a notice must meet. Pure; `now` is epoch ms. */
export function validateNotice(input: NoticeInput, now: number = Date.now()): NoticeValidation {
  const title = (input.title ?? "").trim();
  if (!title) return bad("title_required", "A notice needs a title.");
  if (title.length > NOTICE_TITLE_MAX) return bad("title_too_long", "The title is too long (120 characters max).");
  const text = (input.body ?? "").trim();
  if (text.length > NOTICE_BODY_MAX) return bad("body_too_long", "The notice is too long (4000 characters max).");

  const audience = NOTICE_AUDIENCES.includes(input.audience as NoticeAudience) ? (input.audience as NoticeAudience) : null;
  if (!audience) return bad("audience", "A notice goes to Everyone or to staff.");
  const kind = NOTICE_KINDS.includes(input.kind as (typeof NOTICE_KINDS)[number]) ? (input.kind as string) : "other";
  const importance = input.importance === "important" ? "important" : "normal";

  // ── The link ────────────────────────────────────────────────────────────────
  const rawLink = typeof input.link_url === "string" ? input.link_url.trim() : "";
  let linkUrl: string | null = null;
  if (rawLink) {
    if (rawLink.length > MAX_LINK) return bad("link_too_long", `That link is too long (${MAX_LINK} characters max).`);
    if (!HTTPS_RE.test(rawLink)) return bad("link_not_https", "A notice link must start with https:// — paste the full address.");
    linkUrl = rawLink;
  }
  const rawLabel = typeof input.link_label === "string" ? input.link_label.trim() : "";
  if (rawLabel.length > 60) return bad("link_label_too_long", "The link label is too long (60 characters max).");
  // A label with no link is a half-filled form, not an error worth a red line —
  // it simply has nothing to label, so it never reaches the row.
  const linkLabel = linkUrl && rawLabel ? rawLabel : null;

  // ── The two clocks ──────────────────────────────────────────────────────────
  const startsAt = instant(input.startsAt);
  const actionBy = instant(input.actionBy);
  const featuredUntil = instant(input.featuredUntil);
  if (startsAt === undefined || actionBy === undefined || featuredUntil === undefined) {
    return bad("bad_date", "One of those dates isn't a real date.");
  }
  // Mirrors 0068's school_events_has_a_date: the countdown, the day buckets and
  // the Upcoming list all have nothing to sort on otherwise.
  if (!startsAt && !actionBy) return bad("no_date", "A notice needs a date — when it happens, when to act on it, or both.");
  // A deadline AFTER the event it belongs to is almost always a mis-typed year
  // or a swapped pair of fields. The countdown would run the wrong way round
  // (it targets action_by first), so catch it here rather than ship it.
  if (startsAt && actionBy && Date.parse(actionBy) > Date.parse(startsAt)) {
    return bad("deadline_after_event", "The deadline falls after the event itself — check the two dates.");
  }
  // featuredUntil is refused below when it's already behind us; the two CLOCKS
  // were not, so a notice whose only date had lapsed published with a cheerful
  // "Published" and then appeared on no surface at all — every reader path
  // filters on liveness. Reject only when EVERY date given is behind us: a past
  // starts_at with a live action_by ("the trip was Monday, pay by Friday") is
  // legitimate and still counts down. Safe after the has-a-date check above —
  // an empty list would otherwise pass `every` vacuously.
  const dayStart = schoolDayStart(now);
  const clocks = [startsAt, actionBy].filter((d): d is string => !!d);
  if (clocks.every((d) => Date.parse(d) < dayStart)) {
    return bad("dates_passed", "Those dates have already passed — a notice has to point at something still ahead.");
  }
  const rawAction = typeof input.actionLabel === "string" ? input.actionLabel.trim() : "";
  if (rawAction.length > 40) return bad("action_label_too_long", "The action label is too long (40 characters max).");
  const actionLabel = actionBy && rawAction ? rawAction : null;

  if (featuredUntil) {
    const until = Date.parse(featuredUntil);
    if (until <= now) return bad("pin_past", "A feature pin has to end in the future.");
    if (until > now + MAX_PIN_DAYS * DAY) {
      return bad("pin_too_long", `A feature pin lasts ${MAX_PIN_DAYS} days at most — pin it again if it's still needed.`);
    }
  }

  return {
    ok: true,
    fields: {
      title,
      description: text || null,
      kind,
      audience,
      starts_at: startsAt,
      link_url: linkUrl,
      link_label: linkLabel,
      action_by: actionBy,
      action_label: actionLabel,
      featured_until: featuredUntil,
      importance,
    },
  };
}

/** Who publishes, where, and (SK only) the action that did it. */
export type NoticeWho = {
  schoolId: string;
  createdBy: string;
  /** SK: the consumed action token's id (0171's unique index makes a repeat fail). */
  skActionId?: string;
  /** SK: a notice for a whole day (no time shown). The composer always sends a time. */
  allDay?: boolean;
};

/** The school_events row to insert AS THE CALLER. */
export function buildNoticeRow(fields: NoticeFields, who: NoticeWho): Record<string, unknown> {
  return {
    school_id: who.schoolId,
    class_id: null,
    title: fields.title,
    description: fields.description,
    kind: fields.kind,
    audience: fields.audience,
    starts_at: fields.starts_at,
    all_day: who.allDay === true,
    link_url: fields.link_url,
    link_label: fields.link_label,
    action_by: fields.action_by,
    action_label: fields.action_label,
    featured_until: fields.featured_until,
    importance: fields.importance,
    status: "published",
    // THE marker. A notice is not "any school_events row with a school/staff
    // audience" — 0068 ships into a calendar that already holds such rows, and
    // they must go on behaving as ordinary calendar business rather than
    // appearing on the banner or (worse, for a staff row) demanding a
    // signature from everyone. is_notice defaults false for exactly that
    // reason; a notice writer is the only thing that sets it true, and every
    // reader surface filters on it.
    is_notice: true,
    // created_by is not decoration: se_coordinator_write refuses any row that
    // isn't the caller's own, so a coordinator can never edit the principal's.
    created_by: who.createdBy,
    ...(who.skActionId ? { sk_action_id: who.skActionId } : {}),
  };
}
