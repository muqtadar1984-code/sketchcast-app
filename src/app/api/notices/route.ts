import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { noticesEnabledFor } from "@/utils/flags";

export const runtime = "nodejs";

// School notices — publish one (0068).
//
//   POST { title, body?, audience: "school" | "staff", kind?, link_url?,
//          link_label?, startsAt?, actionBy?, actionLabel?, importance?,
//          featuredUntil? }
//
// A notice IS a school_events row, never a table of its own: that way it
// inherits the audience RLS, the parent resolution (parents carry no school_id
// — they belong through parent_links) and the ICS feed without a second copy of
// any of it. Only two audiences are publishable here — 'school' (Everyone) and
// 'staff' — because 'leadership' and 'class' remain ordinary calendar business
// with their own editor.
//
// Sharing the table means a notice must be EXPLICIT about being one: this route
// is the only writer that sets is_notice = true, and every reader surface
// filters on it. Audience alone would have been enough to sweep the school's
// existing school/staff calendar rows onto the banner — and to start demanding
// a signature for a staff meeting nobody published as a notice.
//
// The insert runs under the CALLER'S session, so RLS (se_admin_write /
// se_coordinator_write) is the authority on who may publish where; this route
// only shapes and pre-validates so denials come back as friendly 400/403s.

const AUDIENCES = ["school", "staff"] as const;
const KINDS = ["meeting", "exam", "holiday", "activity", "pd", "other"] as const;

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
function schoolDayStart(now: number): number {
  return Math.floor((now + TZ_OFFSET_MS) / DAY) * DAY - TZ_OFFSET_MS;
}

type Body = {
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

export async function POST(request: Request) {
  // Flag gate FIRST (the diary idiom). The env half of noticesEnabledFor is the
  // MIGRATION gate and needs no session, so an app deployed before 0068 has run
  // answers 404 to everyone; the per-tenant half needs the caller's school and
  // runs once the profile is loaded, below.
  if (process.env.FEATURE_NOTICES !== "true") {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const title = (body.title ?? "").trim();
  if (!title) return NextResponse.json({ error: "A notice needs a title." }, { status: 400 });
  if (title.length > 120) {
    return NextResponse.json({ error: "The title is too long (120 characters max)." }, { status: 400 });
  }
  const text = (body.body ?? "").trim();
  if (text.length > 4000) {
    return NextResponse.json({ error: "The notice is too long (4000 characters max)." }, { status: 400 });
  }

  const audience = AUDIENCES.includes(body.audience as (typeof AUDIENCES)[number])
    ? (body.audience as string)
    : null;
  if (!audience) {
    return NextResponse.json({ error: "A notice goes to Everyone or to staff." }, { status: 400 });
  }
  const kind = KINDS.includes(body.kind as (typeof KINDS)[number]) ? (body.kind as string) : "other";
  const importance = body.importance === "important" ? "important" : "normal";

  // ── The link ────────────────────────────────────────────────────────────────
  const rawLink = typeof body.link_url === "string" ? body.link_url.trim() : "";
  let linkUrl: string | null = null;
  if (rawLink) {
    if (rawLink.length > MAX_LINK) {
      return NextResponse.json({ error: `That link is too long (${MAX_LINK} characters max).` }, { status: 400 });
    }
    if (!HTTPS_RE.test(rawLink)) {
      return NextResponse.json({ error: "A notice link must start with https:// — paste the full address." }, { status: 400 });
    }
    linkUrl = rawLink;
  }
  const rawLabel = typeof body.link_label === "string" ? body.link_label.trim() : "";
  if (rawLabel.length > 60) {
    return NextResponse.json({ error: "The link label is too long (60 characters max)." }, { status: 400 });
  }
  // A label with no link is a half-filled form, not an error worth a red line —
  // it simply has nothing to label, so it never reaches the row.
  const linkLabel = linkUrl && rawLabel ? rawLabel : null;

  // ── The two clocks ──────────────────────────────────────────────────────────
  const startsAt = instant(body.startsAt);
  const actionBy = instant(body.actionBy);
  const featuredUntil = instant(body.featuredUntil);
  if (startsAt === undefined || actionBy === undefined || featuredUntil === undefined) {
    return NextResponse.json({ error: "One of those dates isn't a real date." }, { status: 400 });
  }
  // Mirrors 0068's school_events_has_a_date: the countdown, the day buckets and
  // the Upcoming list all have nothing to sort on otherwise.
  if (!startsAt && !actionBy) {
    return NextResponse.json(
      { error: "A notice needs a date — when it happens, when to act on it, or both." },
      { status: 400 },
    );
  }
  // A deadline AFTER the event it belongs to is almost always a mis-typed year
  // or a swapped pair of fields. The countdown would run the wrong way round
  // (it targets action_by first), so catch it here rather than ship it.
  if (startsAt && actionBy && Date.parse(actionBy) > Date.parse(startsAt)) {
    return NextResponse.json(
      { error: "The deadline falls after the event itself — check the two dates." },
      { status: 400 },
    );
  }
  // featuredUntil is refused below when it's already behind us; the two CLOCKS
  // were not, so a notice whose only date had lapsed published with a cheerful
  // "Published" and then appeared on no surface at all — every reader path
  // filters on liveness. Reject only when EVERY date given is behind us: a past
  // starts_at with a live action_by ("the trip was Monday, pay by Friday") is
  // legitimate and still counts down. Safe after the has-a-date check above —
  // an empty list would otherwise pass `every` vacuously.
  const dayStart = schoolDayStart(Date.now());
  const clocks = [startsAt, actionBy].filter((d): d is string => !!d);
  if (clocks.every((d) => Date.parse(d) < dayStart)) {
    return NextResponse.json(
      { error: "Those dates have already passed — a notice has to point at something still ahead." },
      { status: 400 },
    );
  }
  const rawAction = typeof body.actionLabel === "string" ? body.actionLabel.trim() : "";
  if (rawAction.length > 40) {
    return NextResponse.json({ error: "The action label is too long (40 characters max)." }, { status: 400 });
  }
  const actionLabel = actionBy && rawAction ? rawAction : null;

  if (featuredUntil) {
    const until = Date.parse(featuredUntil);
    if (until <= Date.now()) {
      return NextResponse.json({ error: "A feature pin has to end in the future." }, { status: 400 });
    }
    if (until > Date.now() + MAX_PIN_DAYS * 86400000) {
      return NextResponse.json(
        { error: `A feature pin lasts ${MAX_PIN_DAYS} days at most — pin it again if it's still needed.` },
        { status: 400 },
      );
    }
  }

  // ── Standing ────────────────────────────────────────────────────────────────
  const { data: me } = await supabase
    .from("profiles")
    .select("role, school_id")
    .eq("id", user.id)
    .maybeSingle();
  const role = (me?.role as string | null) ?? null;
  const schoolId = (me?.school_id as string | null) ?? null;
  if (!schoolId) {
    return NextResponse.json({ error: "Notices belong to a school — your account isn't attached to one." }, { status: 403 });
  }
  // The tenant half of the gate (calendar on for this school, per flags.ts).
  if (!(await noticesEnabledFor(supabase, schoolId))) {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }
  // Standing shaping BEFORE the insert so a denial reads as intent, not RLS
  // noise. Coordinators publish school-wide here (0068 gave them their first
  // write path); teachers keep their class events, students write nothing.
  //
  // COORDINATOR IS A GRANT, NOT A ROLE. /api/coordinators deliberately leaves
  // profiles.role at 'teacher' ("a capability, not an identity") and normalises
  // legacy role='coordinator' rows back to teacher, so gating on the enum would
  // 403 every real coordinator out of the write path 0068 opened for them.
  // Detect them the way every other leadership surface does (dashboard/school,
  // timetable/absence, school-assistant): scope rows in THIS school — RLS
  // returns only the caller's own, and the explicit school filter rejects a
  // stale grant from a school they have left.
  if (!role || role === "student") {
    return NextResponse.json({ error: "Only the principal and coordinators publish notices." }, { status: 403 });
  }
  if (role !== "school_admin") {
    const { data: scopes } = await supabase
      .from("coordinator_scope")
      .select("grade")
      .eq("school_id", schoolId)
      .limit(1);
    if (!scopes?.length) {
      return NextResponse.json({ error: "Only the principal and coordinators publish notices." }, { status: 403 });
    }
  }

  // created_by is not decoration: se_coordinator_write refuses any row that
  // isn't the caller's own, so a coordinator can never edit the principal's.
  const { data: row, error: iErr } = await supabase
    .from("school_events")
    .insert({
      school_id: schoolId,
      class_id: null,
      title,
      description: text || null,
      kind,
      audience,
      starts_at: startsAt,
      all_day: false,
      link_url: linkUrl,
      link_label: linkLabel,
      action_by: actionBy,
      action_label: actionLabel,
      featured_until: featuredUntil,
      importance,
      status: "published",
      // THE marker. A notice is not "any school_events row with a school/staff
      // audience" — 0068 ships into a calendar that already holds such rows, and
      // they must go on behaving as ordinary calendar business rather than
      // appearing on the banner or (worse, for a staff row) demanding a
      // signature from everyone. is_notice defaults false for exactly that
      // reason; the composer is the only thing that sets it true, and every
      // reader surface filters on it.
      is_notice: true,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (iErr || !row) {
    // RLS denial → no standing to publish in this school.
    if (iErr?.code === "42501") {
      return NextResponse.json({ error: "You can't publish notices for this school." }, { status: 403 });
    }
    // A CHECK the app didn't already catch (23514) is a shape problem, not a
    // server fault — say so without quoting the constraint at the publisher.
    if (iErr?.code === "23514") {
      return NextResponse.json({ error: "That notice doesn't fit — check the link and the dates." }, { status: 400 });
    }
    // Log the detail; never hand PostgREST internals to the client.
    console.error("notices publish:", iErr?.message);
    return NextResponse.json({ error: "Could not publish the notice." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: row.id });
}
