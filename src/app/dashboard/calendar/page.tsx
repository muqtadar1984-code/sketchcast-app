import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AppHeader from "../app-header";
import { InkUnderline } from "@/components/ink-mark";
import { calendarEnabledFor, noticesEnabledFor } from "@/utils/flags";
import EventEditor, { type EditorClass, type EditableEvent } from "./event-editor";
import NoticeComposer from "./notice-composer";
import SubscribeButton from "./subscribe-button";

export const dynamic = "force-dynamic";

// The school calendar: month grid + upcoming list, audience-scoped by RLS (an
// admin sees everything, a teacher sees staff/school + their class events, a
// student school + class, a parent school + their children's classes). The
// assignment due dates every role already sees ride along as a read-only
// overlay. Subscribe-by-URL (ICS) links it into Google/Outlook/Apple.
//
// It is ALSO the notices desk (0068): a notice is a school_events row, so the
// place you write one is the place its date lands. The composer is leadership's
// alone; the withdrawn-notice block below it is the other half of that power.
//
// Times render in the school's timezone. Malaysia is fixed UTC+8 (no DST), so
// day-bucketing uses a constant offset; make this per-school config when a
// school outside MY signs up.
const TZ = "Asia/Kuala_Lumpur";
const TZ_OFFSET_MS = 8 * 3600000;
const DAY = 86400000;

const KIND_STYLE: Record<string, string> = {
  meeting: "bg-[#E2F4F1] text-[#0C8175]",
  exam: "bg-[#FCEBEA] text-[#B42318]",
  holiday: "bg-[#EFE9FB] text-[#6941C6]",
  activity: "bg-[#FFF1D6] text-[#9A6400]",
  pd: "bg-[#E8F1FB] text-[#175CD3]",
  other: "bg-[#EEF0EC] text-[#5B6470]",
};

type EventRow = {
  id: string;
  class_id: string | null;
  title: string;
  description: string | null;
  location: string | null;
  kind: string;
  audience: string;
  /** Null on a PURE-DEADLINE notice (0068 dropped the NOT NULL) — "fees due
   * Friday" is a date to act by with no event attached. */
  starts_at: string | null;
  ends_at: string | null;
  all_day: boolean;
  source: string;
  created_by: string | null;
  // ── 0068 columns ──────────────────────────────────────────────────────────
  // Only selected when notices are live for this school: a pre-0068 database
  // has none of them, and asking would break a calendar that works today.
  status?: string;
  is_notice?: boolean;
  action_by?: string | null;
  action_label?: string | null;
};

const EVENT_COLUMNS =
  "id, class_id, title, description, location, kind, audience, starts_at, ends_at, all_day, source, created_by";
const NOTICE_COLUMNS = ", status, is_notice, action_by, action_label";

/**
 * The date a row LIVES on: its event date, or — for a pure-deadline notice —
 * the deadline itself. This is coalesce(starts_at, action_by), the same key the
 * ICS resolver (calendar_events_for) and the bell already sort on, so a notice
 * the bell links here can't land on a page that doesn't show it. 0068's
 * school_events_has_a_date guarantees one of the two exists; the null return is
 * for the row that somehow has neither, which is dropped rather than crashed on.
 */
function whenOf(e: EventRow): string | null {
  return e.starts_at ?? e.action_by ?? null;
}

/** Withdrawn (0068). RLS keeps these readable for leadership audit, so every
 * surface decides for itself what to do with them — this one marks them. */
function isRevoked(e: EventRow): boolean {
  return e.status === "revoked";
}

/** Civil (UTC+8) day key for bucketing: "2026-07-15". */
function dayKey(iso: string): string {
  return new Date(new Date(iso).getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/** The clock, read HERE rather than in the component body — a render must never
 * ask the time (react-hooks/purity, the same reason school/admin's livePinIds
 * lives outside its page). A server component calls this once per request,
 * which is exactly what "today" means on a calendar. */
function nowMs(): number {
  return Date.now();
}

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, school_id")
    .eq("id", user.id)
    .maybeSingle();
  const role = (profile?.role as string | null) ?? null;
  let schoolId = (profile?.school_id as string | null) ?? null;

  // Parents carry no school_id — they belong through their children. Mirror the
  // header exactly: pick the FIRST child school where the calendar is enabled
  // (a multi-school parent must not see a tab that dead-ends).
  let calendarOk = await calendarEnabledFor(supabase, schoolId);
  if (!calendarOk && !schoolId && role && role !== "student") {
    const { data: links } = await supabase
      .from("parent_links")
      .select("profiles:child_id(school_id)")
      .order("created_at")
      .limit(10);
    for (const l of (links ?? []) as unknown as { profiles: { school_id: string | null } | null }[]) {
      const sid = l.profiles?.school_id;
      if (sid && (await calendarEnabledFor(supabase, sid))) {
        schoolId = sid;
        calendarOk = true;
        break;
      }
    }
  }
  if (!calendarOk || !schoolId) redirect("/dashboard");

  // ── Month window (civil UTC+8) ───────────────────────────────────────────────
  const { m } = await searchParams;
  const now = nowMs();
  const nowCivil = new Date(now + TZ_OFFSET_MS);
  let year = nowCivil.getUTCFullYear();
  let month = nowCivil.getUTCMonth(); // 0-based
  const parsed = /^(\d{4})-(\d{2})$/.exec(m ?? "");
  if (parsed) {
    year = Number(parsed[1]);
    month = Number(parsed[2]) - 1;
  }
  const monthStartCivil = Date.UTC(year, month, 1);
  // Grid starts the Monday on/before the 1st, spans 6 weeks.
  const firstDow = (new Date(monthStartCivil).getUTCDay() + 6) % 7; // Mon=0
  const gridStartCivil = monthStartCivil - firstDow * DAY;
  const gridDays = 42;
  const gridStartUtc = new Date(gridStartCivil - TZ_OFFSET_MS).toISOString();
  const gridEndUtc = new Date(gridStartCivil + gridDays * DAY - TZ_OFFSET_MS).toISOString();
  // Events are fetched over the UNION of the visible grid and the next 31 days,
  // so the "Upcoming" list stays complete even while browsing another month.
  const fetchStartUtc = new Date(Math.min(gridStartCivil - TZ_OFFSET_MS, now - DAY)).toISOString();
  const fetchEndUtc = new Date(
    Math.max(gridStartCivil + gridDays * DAY - TZ_OFFSET_MS, now + 31 * DAY),
  ).toISOString();

  // ── RLS-scoped reads ─────────────────────────────────────────────────────────
  // Is the announcement layer live here? It decides both which columns exist to
  // ask for and whether the window has to reach dateless-but-due rows.
  const noticesOn = await noticesEnabledFor(supabase, schoolId);
  const evQuery = supabase.from("school_events").select(EVENT_COLUMNS + (noticesOn ? NOTICE_COLUMNS : ""));
  // A pure-deadline notice has NO starts_at, so the old `.gte("starts_at", …)`
  // window dropped it silently — and the bell deep-links here, so the reader
  // arrived at a page that didn't contain the thing they tapped. Two arms, one
  // meaning: coalesce(starts_at, action_by) inside the window.
  const { data: evRaw } = await (noticesOn
    ? evQuery.or(
        `and(starts_at.gte.${fetchStartUtc},starts_at.lt.${fetchEndUtc}),` +
          `and(starts_at.is.null,action_by.gte.${fetchStartUtc},action_by.lt.${fetchEndUtc})`,
      )
    : evQuery.gte("starts_at", fetchStartUtc).lt("starts_at", fetchEndUtc));
  const allRows = ((evRaw ?? []) as unknown as EventRow[])
    .filter((e) => !!whenOf(e))
    // The effective date is what the page sorts on now that a row may have only
    // a deadline — PostgREST can't order by the coalesce for us.
    .sort((a, b) => whenOf(a)!.localeCompare(whenOf(b)!));

  type DueRow = { due_at: string; generations: { title: string | null; kind: string } | null };
  const { data: dueRaw } = await supabase
    .from("generation_shares")
    .select("due_at, generations(title, kind)")
    .not("due_at", "is", null)
    .gte("due_at", gridStartUtc)
    .lt("due_at", gridEndUtc);
  const dues = (dueRaw ?? []) as unknown as DueRow[];

  // ── Who you are on this page ────────────────────────────────────────────────
  const isAdmin = role === "school_admin";
  // Coordinator standing is a GRANT, not an identity: a coordinator's
  // profiles.role reads "teacher", and what makes them one is holding
  // coordinator_scope rows in THIS school (the /dashboard/school test, kept
  // identical here). Testing role === "coordinator" would miss every real one.
  // Asked only of someone with a school of their OWN — a parent's schoolId came
  // from a child above, and they hold no scope in it.
  const ownSchoolId = (profile?.school_id as string | null) ?? null;
  let isCoordinator = false;
  if (!isAdmin && ownSchoolId && role && role !== "student") {
    const { data: scopes } = await supabase
      .from("coordinator_scope")
      .select("id")
      .eq("school_id", ownSchoolId)
      .limit(1);
    isCoordinator = (scopes?.length ?? 0) > 0;
  }
  const isLeadership = isAdmin || isCoordinator;

  // Withdrawn notices are readable ONLY by leadership (se_read keeps them for
  // audit) — but "readable" must not mean "looks live". They leave the grid and
  // the Upcoming list entirely and reappear, marked and uneditable, in the
  // manage block below. The filter is a belt: RLS already withholds them from
  // everyone else.
  const events = allRows.filter((e) => !isRevoked(e));
  const withdrawn = isLeadership ? allRows.filter(isRevoked) : [];

  // ── Buckets ─────────────────────────────────────────────────────────────────
  const eventsByDay = new Map<string, EventRow[]>();
  for (const e of events) {
    const k = dayKey(whenOf(e)!);
    if (!eventsByDay.has(k)) eventsByDay.set(k, []);
    eventsByDay.get(k)!.push(e);
  }
  const duesByDay = new Map<string, DueRow[]>();
  for (const d of dues) {
    const k = dayKey(d.due_at);
    if (!duesByDay.has(k)) duesByDay.set(k, []);
    duesByDay.get(k)!.push(d);
  }

  // ── Editor setup (who can create what) ───────────────────────────────────────
  let editorClasses: EditorClass[] = [];
  if (role && role !== "student" && schoolId) {
    const { data: clsRaw } = isAdmin
      ? await supabase.from("classes").select("id, name").eq("school_id", schoolId).order("name")
      : await supabase.from("classes").select("id, name").eq("teacher_id", user.id).order("name");
    editorClasses = (clsRaw ?? []) as EditorClass[];
  }
  const canCreate = !!schoolId && (isAdmin || editorClasses.length > 0) && role !== "student";
  const canManage = (e: EventRow) =>
    e.source === "native" && (isAdmin || (!!e.class_id && editorClasses.some((c) => c.id === e.class_id)));
  // The composer's own gate: publishing a notice is a leadership act (0068's
  // se_coordinator_write gave coordinators their first write path). The card is
  // only offered where the feature is live and the person may actually publish.
  const canPublishNotices = noticesOn && !!ownSchoolId && isLeadership;

  /** The event editor handles ordinary DATED calendar rows. A pure-deadline
   * notice has no starts_at for it to edit, so it hands back null and the row
   * renders without an Edit button rather than with a broken one. */
  const editable = (e: EventRow): EditableEvent | null =>
    e.starts_at === null
      ? null
      : {
          id: e.id,
          class_id: e.class_id,
          title: e.title,
          description: e.description,
          location: e.location,
          kind: e.kind,
          audience: e.audience,
          starts_at: e.starts_at,
          ends_at: e.ends_at,
          all_day: e.all_day,
        };

  const timeFmt = new Intl.DateTimeFormat("en-MY", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  const dayFmt = new Intl.DateTimeFormat("en-MY", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
  const monthLabel = new Intl.DateTimeFormat("en-MY", { timeZone: TZ, month: "long", year: "numeric" }).format(
    new Date(monthStartCivil - TZ_OFFSET_MS + 12 * 3600000),
  );
  const mkParam = (y: number, mo: number) => `${y}-${String(mo + 1).padStart(2, "0")}`;
  const prev = month === 0 ? mkParam(year - 1, 11) : mkParam(year, month - 1);
  const next = month === 11 ? mkParam(year + 1, 0) : mkParam(year, month + 1);
  const todayKey = nowCivil.toISOString().slice(0, 10);

  /** The line under a title: the event's day and time, or the deadline in its
   * own words ("Register by Fri, 8 Aug") when that is all the row has. */
  const subLine = (e: EventRow): string => {
    if (!e.starts_at) {
      return `${e.action_label?.trim() || "By"} ${dayFmt.format(new Date(e.action_by!))}`;
    }
    const d = new Date(e.starts_at);
    return `${dayFmt.format(d)}${e.all_day ? " · all day" : ` · ${timeFmt.format(d)}`}`;
  };

  // Upcoming list: the next 30 days from today (already-fetched grid rows),
  // measured on whichever clock the row actually has.
  const upcoming = events
    .filter((e) => {
      const t = new Date(whenOf(e)!).getTime();
      return t >= now - DAY && t < now + 30 * DAY;
    })
    .slice(0, 12);

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <main className="max-w-7xl mx-auto px-6 py-10">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-4xl mb-2">Calendar</h1>
            <InkUnderline className="block h-3 w-28 mb-3" />
            <p className="text-[#5B6470]">
              Meetings, exams, holidays and assignment due dates — everyone sees their own slice.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <SubscribeButton />
            {canCreate && <EventEditor schoolId={schoolId!} isAdmin={isAdmin} classes={editorClasses} userId={user.id} />}
          </div>
        </div>

        {/* The publishing surface for notices. It sits ABOVE the grid because
            it is a different act from adding an event: "Add event" writes a
            date into the calendar, this writes an announcement onto everyone's
            dashboard. Only leadership sees it. */}
        {canPublishNotices && (
          <div className="mt-8">
            <NoticeComposer />
          </div>
        )}

        <div className="flex items-center justify-between mt-8 mb-3">
          <h2 className="text-xl">{monthLabel}</h2>
          <div className="flex items-center gap-2">
            <Link href={`/dashboard/calendar?m=${prev}`} className="btn-ghost h-9 px-3 text-sm">
              ← Prev
            </Link>
            <Link href="/dashboard/calendar" className="btn-ghost h-9 px-3 text-sm">
              Today
            </Link>
            <Link href={`/dashboard/calendar?m=${next}`} className="btn-ghost h-9 px-3 text-sm">
              Next →
            </Link>
          </div>
        </div>

        <div className="card overflow-hidden">
          <div className="grid grid-cols-7 border-b border-[#EEF0EC] bg-[#F5F6F3] text-xs text-[#5B6470]">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <div key={d} className="px-2 py-1.5 text-center">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {Array.from({ length: gridDays }, (_, i) => {
              const civil = new Date(gridStartCivil + i * DAY);
              const key = civil.toISOString().slice(0, 10);
              const inMonth = civil.getUTCMonth() === month;
              const dayEvents = eventsByDay.get(key) ?? [];
              const dayDues = duesByDay.get(key) ?? [];
              return (
                <div
                  key={key}
                  className={`min-h-[92px] border-b border-r border-[#EEF0EC] p-1.5 align-top ${inMonth ? "" : "bg-[#FAFBF9] text-[#98A0A9]"}`}
                >
                  <div
                    className={`text-xs mb-1 ${key === todayKey ? "inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#0C8175] text-white" : "text-[#5B6470]"}`}
                  >
                    {civil.getUTCDate()}
                  </div>
                  <div className="space-y-1">
                    {dayEvents.slice(0, 3).map((e) => (
                      <div
                        key={e.id}
                        title={`${e.title} · ${subLine(e)}${e.location ? ` · ${e.location}` : ""}`}
                        className={`truncate rounded px-1.5 py-0.5 text-[11px] leading-4 ${KIND_STYLE[e.kind] ?? KIND_STYLE.other}`}
                      >
                        {/* A deadline-only notice has no time of day to lead
                            with — its wording lives in the tooltip and in the
                            Upcoming list. */}
                        {e.starts_at && !e.all_day ? `${timeFmt.format(new Date(e.starts_at))} ` : ""}
                        {e.title}
                      </div>
                    ))}
                    {dayDues.slice(0, 2).map((d, j) => (
                      <div
                        key={`due-${j}`}
                        title={`Due: ${d.generations?.title ?? "assignment"}`}
                        className="truncate rounded border border-dashed border-[#D5D9D2] px-1.5 py-0.5 text-[11px] leading-4 text-[#5B6470]"
                      >
                        ⏰ {d.generations?.title ?? "Assignment"} due
                      </div>
                    ))}
                    {dayEvents.length + dayDues.length > 5 && (
                      <div className="text-[10px] text-[#98A0A9]">+{dayEvents.length + dayDues.length - 5} more</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {(() => {
          // Events YOU manage in the viewed month — the grid is read-only and
          // the Upcoming list only covers 30 days, so this is the edit path for
          // anything planned further out (terms, holidays) or already past.
          const monthPrefix = `${year}-${String(month + 1).padStart(2, "0")}`;
          const inMonth = (e: EventRow) => dayKey(whenOf(e)!).startsWith(monthPrefix);
          const manageable = events.filter((e) => inMonth(e) && canManage(e));
          // Leadership's own withdrawn rows for the month. They are NOT live
          // events and must never read as one — no Edit, muted, and labelled.
          const pulled = withdrawn.filter(inMonth);
          if (!manageable.length && !pulled.length) return null;
          return (
            <>
              <h2 className="text-xl mt-10 mb-1">Manage this month&apos;s events</h2>
              <p className="text-sm text-[#5B6470] mb-3">Events you created or can edit in {monthLabel}.</p>
              {manageable.length > 0 && (
                <div className="card divide-y divide-[#EEF0EC]">
                  {manageable.map((e) => {
                    const ed = editable(e);
                    return (
                      <div key={`m-${e.id}`} className="px-5 py-3 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm text-[#14181F] truncate">{e.title}</div>
                          <div className="text-xs text-[#5B6470]">{subLine(e)}</div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`chip font-sans ${KIND_STYLE[e.kind] ?? KIND_STYLE.other}`}>{e.kind}</span>
                          {ed && (
                            <EventEditor
                              schoolId={schoolId!}
                              isAdmin={isAdmin}
                              classes={editorClasses}
                              userId={user.id}
                              existing={ed}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {pulled.length > 0 && (
                <>
                  <p className="text-xs text-[#98A0A9] mt-3 mb-1.5">
                    Withdrawn in {monthLabel} — kept for your record, and visible to leadership only. Nobody else sees
                    these, on any surface.
                  </p>
                  <div className="card divide-y divide-[#EEF0EC] bg-[#FAFBF9]">
                    {pulled.map((e) => (
                      <div key={`w-${e.id}`} className="px-5 py-3 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm text-[#98A0A9] line-through truncate">{e.title}</div>
                          <div className="text-xs text-[#98A0A9]">{subLine(e)}</div>
                        </div>
                        <span className="chip font-sans bg-[#EEF0EC] text-[#5B6470] shrink-0">Withdrawn</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          );
        })()}

        <h2 className="text-xl mt-10 mb-1">Upcoming</h2>
        <p className="text-sm text-[#5B6470] mb-3">The next 30 days in your slice.</p>
        {upcoming.length === 0 ? (
          <div className="card px-5 py-6 text-sm text-[#5B6470]">Nothing scheduled yet.</div>
        ) : (
          <div className="card divide-y divide-[#EEF0EC]">
            {upcoming.map((e) => {
              const ed = canManage(e) ? editable(e) : null;
              return (
                <div key={e.id} className="px-5 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-[#14181F] truncate">{e.title}</div>
                    <div className="text-xs text-[#5B6470]">
                      {subLine(e)}
                      {e.location ? ` · ${e.location}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`chip font-sans ${KIND_STYLE[e.kind] ?? KIND_STYLE.other}`}>{e.kind}</span>
                    {ed && (
                      <EventEditor
                        schoolId={schoolId!}
                        isAdmin={isAdmin}
                        classes={editorClasses}
                        userId={user.id}
                        existing={ed}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
