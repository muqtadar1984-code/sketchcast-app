import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AppHeader from "../app-header";
import { InkUnderline } from "@/components/ink-mark";
import { calendarEnabledFor } from "@/utils/flags";
import EventEditor, { type EditorClass } from "./event-editor";
import SubscribeButton from "./subscribe-button";

export const dynamic = "force-dynamic";

// The school calendar: month grid + upcoming list, audience-scoped by RLS (an
// admin sees everything, a teacher sees staff/school + their class events, a
// student school + class, a parent school + their children's classes). The
// assignment due dates every role already sees ride along as a read-only
// overlay. Subscribe-by-URL (ICS) links it into Google/Outlook/Apple.
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
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  source: string;
  created_by: string | null;
};

/** Civil (UTC+8) day key for bucketing: "2026-07-15". */
function dayKey(iso: string): string {
  return new Date(new Date(iso).getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
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
  const nowCivil = new Date(Date.now() + TZ_OFFSET_MS);
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
  const fetchStartUtc = new Date(Math.min(gridStartCivil - TZ_OFFSET_MS, Date.now() - DAY)).toISOString();
  const fetchEndUtc = new Date(
    Math.max(gridStartCivil + gridDays * DAY - TZ_OFFSET_MS, Date.now() + 31 * DAY),
  ).toISOString();

  // ── RLS-scoped reads ─────────────────────────────────────────────────────────
  const { data: evRaw } = await supabase
    .from("school_events")
    .select("id, class_id, title, description, location, kind, audience, starts_at, ends_at, all_day, source, created_by")
    .gte("starts_at", fetchStartUtc)
    .lt("starts_at", fetchEndUtc)
    .order("starts_at");
  const events = (evRaw ?? []) as EventRow[];

  type DueRow = { due_at: string; generations: { title: string | null; kind: string } | null };
  const { data: dueRaw } = await supabase
    .from("generation_shares")
    .select("due_at, generations(title, kind)")
    .not("due_at", "is", null)
    .gte("due_at", gridStartUtc)
    .lt("due_at", gridEndUtc);
  const dues = (dueRaw ?? []) as unknown as DueRow[];

  // ── Buckets ─────────────────────────────────────────────────────────────────
  const eventsByDay = new Map<string, EventRow[]>();
  for (const e of events) {
    const k = dayKey(e.starts_at);
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
  const isAdmin = role === "school_admin";
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

  const timeFmt = new Intl.DateTimeFormat("en-MY", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  const dayFmt = new Intl.DateTimeFormat("en-MY", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
  const monthLabel = new Intl.DateTimeFormat("en-MY", { timeZone: TZ, month: "long", year: "numeric" }).format(
    new Date(monthStartCivil - TZ_OFFSET_MS + 12 * 3600000),
  );
  const mkParam = (y: number, mo: number) => `${y}-${String(mo + 1).padStart(2, "0")}`;
  const prev = month === 0 ? mkParam(year - 1, 11) : mkParam(year, month - 1);
  const next = month === 11 ? mkParam(year + 1, 0) : mkParam(year, month + 1);
  const todayKey = nowCivil.toISOString().slice(0, 10);

  // Upcoming list: the next 30 days from today (already-fetched grid rows).
  const upcoming = events
    .filter((e) => {
      const t = new Date(e.starts_at).getTime();
      return t >= Date.now() - DAY && t < Date.now() + 30 * DAY;
    })
    .slice(0, 12);

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <main className="max-w-5xl mx-auto px-6 py-10">
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
                        title={`${e.title}${e.all_day ? "" : ` · ${timeFmt.format(new Date(e.starts_at))}`}${e.location ? ` · ${e.location}` : ""}`}
                        className={`truncate rounded px-1.5 py-0.5 text-[11px] leading-4 ${KIND_STYLE[e.kind] ?? KIND_STYLE.other}`}
                      >
                        {e.all_day ? "" : `${timeFmt.format(new Date(e.starts_at))} `}
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
          const manageable = events.filter((e) => dayKey(e.starts_at).startsWith(monthPrefix) && canManage(e));
          if (!manageable.length) return null;
          return (
            <>
              <h2 className="text-xl mt-10 mb-1">Manage this month&apos;s events</h2>
              <p className="text-sm text-[#5B6470] mb-3">Events you created or can edit in {monthLabel}.</p>
              <div className="card divide-y divide-[#EEF0EC]">
                {manageable.map((e) => (
                  <div key={`m-${e.id}`} className="px-5 py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm text-[#14181F] truncate">{e.title}</div>
                      <div className="text-xs text-[#5B6470]">
                        {dayFmt.format(new Date(e.starts_at))}
                        {e.all_day ? " · all day" : ` · ${timeFmt.format(new Date(e.starts_at))}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`chip font-sans ${KIND_STYLE[e.kind] ?? KIND_STYLE.other}`}>{e.kind}</span>
                      <EventEditor schoolId={schoolId!} isAdmin={isAdmin} classes={editorClasses} userId={user.id} existing={e} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          );
        })()}

        <h2 className="text-xl mt-10 mb-1">Upcoming</h2>
        <p className="text-sm text-[#5B6470] mb-3">The next 30 days in your slice.</p>
        {upcoming.length === 0 ? (
          <div className="card px-5 py-6 text-sm text-[#5B6470]">Nothing scheduled yet.</div>
        ) : (
          <div className="card divide-y divide-[#EEF0EC]">
            {upcoming.map((e) => (
              <div key={e.id} className="px-5 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-[#14181F] truncate">{e.title}</div>
                  <div className="text-xs text-[#5B6470]">
                    {dayFmt.format(new Date(e.starts_at))}
                    {e.all_day ? " · all day" : ` · ${timeFmt.format(new Date(e.starts_at))}`}
                    {e.location ? ` · ${e.location}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`chip font-sans ${KIND_STYLE[e.kind] ?? KIND_STYLE.other}`}>{e.kind}</span>
                  {canManage(e) && <EventEditor schoolId={schoolId!} isAdmin={isAdmin} classes={editorClasses} userId={user.id} existing={e} />}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
