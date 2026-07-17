import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import AppHeader from "../app-header";
import { InkUnderline } from "@/components/ink-mark";
import { timetableEnabledFor } from "@/utils/flags";
import { enforceHat } from "@/utils/hats-server";
import { DAY_NAMES, isLesson, shapeFromConfig, type Slot } from "@/utils/timetable";

export const dynamic = "force-dynamic";

// "My timetable" — the read-only schedule every SCHOOL member gets from their
// own login (the editable builder stays a leadership surface):
//   teacher  → the week of lessons they teach, plus upcoming COVER duties
//              (substitutions assigned to them when a colleague is absent)
//   student  → their class's week
// Slots are member-readable under RLS; the class/teacher NAME lookups go
// through the service role because a member's RLS view of profiles/classes is
// deliberately narrower than the school-wide grid they can already see.
export default async function MyTimetablePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role, school_id")
    .eq("id", user.id)
    .single();
  const role = (profile?.role as string | null) ?? null;
  const schoolId = (profile?.school_id as string | null) ?? null;
  if (!role || !schoolId) redirect("/dashboard");
  if (!(await timetableEnabledFor(supabase, schoolId))) redirect("/dashboard");
  const isStudent = role === "student";
  if (!isStudent) {
    // One-hat mode: this is the TEACHER hat's surface (leadership has the builder).
    const hatAway = await enforceHat(supabase, role, schoolId, "teacher");
    if (hatAway) redirect(hatAway);
  }

  const { data: school } = await supabase.from("schools").select("config").eq("id", schoolId).maybeSingle();
  const shape = shapeFromConfig(school?.config ?? null);
  const days = DAY_NAMES.slice(0, shape.days);

  const { data: slotsRaw } = await supabase
    .from("timetable_slots")
    .select("class_id, day, period, subject, teacher_id, room, kind");
  const allSlots = (slotsRaw ?? []) as Slot[];

  // Which slots are MINE?
  let mySlots: Slot[] = [];
  let classIds: string[] = [];
  if (isStudent) {
    const { data: enr } = await supabase.from("enrollments").select("class_id").eq("student_id", user.id);
    classIds = [...new Set(((enr ?? []) as { class_id: string }[]).map((e) => e.class_id))];
    mySlots = allSlots.filter((s) => classIds.includes(s.class_id));
  } else {
    mySlots = allSlots.filter((s) => s.teacher_id === user.id);
  }

  // Names via the service role (fallback: RLS-visible slices — worst case a
  // few cells read "Class"/"Teacher", never an error).
  let classNames = new Map<string, string>();
  let teacherNames = new Map<string, string>();
  try {
    const admin = createAdminClient();
    const [{ data: cls }, { data: staff }] = await Promise.all([
      admin.from("classes").select("id, name").eq("school_id", schoolId),
      admin.from("profiles").select("id, full_name, username").eq("school_id", schoolId).neq("role", "student"),
    ]);
    classNames = new Map(((cls ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
    teacherNames = new Map(
      ((staff ?? []) as { id: string; full_name: string | null; username: string | null }[]).map((t) => [
        t.id,
        t.full_name || t.username || "Teacher",
      ]),
    );
  } catch {
    const { data: cls } = await supabase.from("classes").select("id, name");
    classNames = new Map(((cls ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  }
  const firstName = (id: string | null) => (id ? (teacherNames.get(id) ?? "Teacher").split(" ")[0] : "");

  // Upcoming cover duties for teachers (assigned when a colleague is absent).
  type Cover = { on_date: string; period: number; subject: string; class_id: string; original_teacher_id: string | null };
  let covers: Cover[] = [];
  if (!isStudent) {
    const today = new Date().toISOString().slice(0, 10);
    const { data: cov } = await supabase
      .from("timetable_substitutions")
      .select("on_date, period, subject, class_id, original_teacher_id")
      .eq("substitute_teacher_id", user.id)
      .gte("on_date", today)
      .order("on_date")
      .limit(20);
    covers = (cov ?? []) as Cover[];
  }

  const slotAt = (cid: string | null, day: number, period: number) =>
    mySlots.find((s) => (cid === null || s.class_id === cid) && s.day === day && s.period === period);

  // Break rows keyed by the period they follow (0 = before P1).
  const breaksAfter = new Map<number, NonNullable<typeof shape.breaks>>();
  for (const b of shape.breaks ?? []) {
    const k = Math.min(b.afterPeriod, shape.periods.length);
    if (!breaksAfter.has(k)) breaksAfter.set(k, []);
    breaksAfter.get(k)!.push(b);
  }

  const grids: { title: string | null; classId: string | null }[] = isStudent
    ? classIds.map((id) => ({ title: classNames.get(id) ?? "My class", classId: id }))
    : [{ title: null, classId: null }];

  const renderGrid = (classId: string | null) => (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-[#F5F6F3] text-xs text-[#5B6470]">
            <th className="px-2 py-2 text-left font-normal w-20">Period</th>
            {days.map((d) => (
              <th key={d} className="px-2 py-2 text-left font-normal">
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shape.periods.map((p, pi) => {
            const period = pi + 1;
            const breakRows = breaksAfter.get(period) ?? [];
            return [
              <tr key={`p${pi}`} className="border-t border-[#EEF0EC] align-top">
                <td className="px-2 py-1.5 text-xs text-[#5B6470] whitespace-nowrap">
                  {p.label}
                  {p.time ? <span className="block text-[10px] text-[#98A0A9]">{p.time}</span> : null}
                </td>
                {days.map((_, di) => {
                  const s = slotAt(classId, di + 1, period);
                  return (
                    <td key={di} className="px-1 py-1">
                      {s ? (
                        <div className={`rounded px-1.5 py-1 text-[11px] leading-4 ${isLesson(s) ? "bg-[#F4F6F3]" : "bg-[#EFEDF7]"}`}>
                          <span className="text-[#14181F]">{s.subject}</span>
                          <span className="block text-[#5B6470]">
                            {isStudent ? firstName(s.teacher_id) : (classNames.get(s.class_id) ?? "Class")}
                            {s.room ? ` · ${s.room}` : ""}
                          </span>
                        </div>
                      ) : (
                        <div className="min-h-[36px]" />
                      )}
                    </td>
                  );
                })}
              </tr>,
              ...breakRows.map((b, bi) => (
                <tr key={`p${pi}-b${bi}`} className="border-t border-[#EEF0EC] bg-[#FBF7EE]">
                  <td colSpan={days.length + 1} className="px-2 py-1 text-[11px] text-[#9A6400]">
                    ☕ {b.label}
                    {b.time ? ` · ${b.time}` : ""}
                    {b.minutes ? ` · ${b.minutes} min` : ""}
                  </td>
                </tr>
              )),
            ];
          })}
        </tbody>
      </table>
    </div>
  );

  const hoursLine = [
    shape.start && shape.end ? `School hours ${shape.start} – ${shape.end}` : null,
    ...(shape.breaks ?? []).map((b) => `${b.label} ${b.time ?? ""}${b.minutes ? ` · ${b.minutes} min` : ""}`),
  ]
    .filter(Boolean)
    .join("   ·   ");

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <div className="print:hidden">
        <AppHeader />
      </div>
      <main className="max-w-5xl mx-auto px-6 py-10 print:py-2">
        <h1 className="text-4xl mb-2">My timetable</h1>
        <InkUnderline className="block h-3 w-28 mb-3 print:hidden" />
        <p className="text-[#5B6470] mb-6 print:hidden">
          {isStudent ? "Your class's week." : "The lessons you teach this week."}
        </p>

        {!isStudent && covers.length > 0 && (
          <div className="card p-4 mb-5">
            <p className="text-sm font-medium mb-2">Cover duties</p>
            <ul className="text-sm text-[#5B6470] space-y-1">
              {covers.map((c, i) => (
                <li key={i}>
                  <span className="chip bg-[#FFF1D6] text-[#9A6400] mr-2">{c.on_date}</span>
                  {shape.periods[c.period - 1]?.label ?? `P${c.period}`} · {c.subject} ·{" "}
                  {classNames.get(c.class_id) ?? "Class"}
                  {c.original_teacher_id ? ` — covering for ${firstName(c.original_teacher_id)}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}

        {grids.map((g) => (
          <div key={g.classId ?? "mine"} className="mb-6">
            {g.title && <p className="text-sm font-medium mb-2">{g.title}</p>}
            {renderGrid(g.classId)}
          </div>
        ))}
        {mySlots.length === 0 && (
          <p className="text-sm text-[#5B6470]">
            No lessons on the timetable yet — it appears here as soon as the school publishes it.
          </p>
        )}
        {hoursLine && <p className="text-xs text-[#5B6470] mt-2">{hoursLine}</p>}
      </main>
    </div>
  );
}
