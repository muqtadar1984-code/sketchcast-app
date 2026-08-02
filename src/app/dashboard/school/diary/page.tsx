import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AppHeader from "../../app-header";
import NoticesSection from "../../notices-section";
import { InkUnderline } from "@/components/ink-mark";
import { diaryEnabled } from "@/utils/flags";
import { enforceHat } from "@/utils/hats-server";
import DiaryNote, { type DiaryNoteItem, type DiaryNoteMessages, type DiaryReplyItem } from "../../diary/diary-note";
import { NOTE_TYPES, noteTypeLabel } from "../../diary/note-types";
import DateNav, { dayWindowUtc, isDayKey, shiftDay, todayKey } from "../../diary/date-nav";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { htmlLang } from "@/i18n/locales";
import { fmt } from "@/i18n/format";

// The LEADERSHIP diary — read-only oversight of the teacher↔home book, scoped
// by RLS (school_admin → whole school; coordinator → their slice, via
// diary_leader_of). No compose, reply or ack UI renders here and none would
// work: migration 0066 gives leadership NO insert path on any diary table by
// design. A small metrics row (this week's notes by type + how many concern
// notes parents have signed) sits above a per-class day timeline. Every visit
// lands in the DPDP access audit, like the analytics pages.

export const dynamic = "force-dynamic";

export default async function SchoolDiaryPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; d?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // The page's words. resolveLocale is React-cached, so asking here and in the
  // header costs one lookup. `diary` carries everything shared with the
  // teacher/parent/student books; `schoolDiary` is this page's own.
  const locale = await resolveLocale();
  const dict = await getDictionary(locale);
  const t = dict.comms.schoolDiary;
  const td = dict.comms.diary;
  const lang = htmlLang(locale);

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, school_id")
    .eq("id", user.id)
    .single();
  if (!diaryEnabled()) redirect("/dashboard");
  const role = (profile?.role as string | null) ?? null;
  if (!role || role === "student") redirect("/dashboard");
  // One-hat mode: the School pages belong to the leadership hats.
  const hatAway = await enforceHat(supabase, role, (profile?.school_id as string | null) ?? null, "leadership");
  if (hatAway) redirect(hatAway);
  const isAdmin = role === "school_admin";

  // Coordinator access is a GRANT (coordinator_scope rows), not an identity.
  // School-scoped: a stale grant from a former school must not open this page.
  const schoolId = (profile?.school_id as string | null) ?? null;
  if (!schoolId) redirect("/dashboard");
  let coordGrades: string[] = [];
  if (!isAdmin) {
    const { data: scopes } = await supabase.from("coordinator_scope").select("grade").eq("school_id", schoolId);
    coordGrades = [...new Set(((scopes ?? []) as { grade: string }[]).map((s) => s.grade))];
    if (!coordGrades.length) redirect("/dashboard");
  }

  const { c, d } = await searchParams;
  const day = isDayKey(d) ? d : todayKey();
  const { startUtc, endUtc } = dayWindowUtc(day);

  // ── Class picker (RLS: admin sees the school, coordinator their slice) ──────
  // RLS also hands a coordinator the classes they personally TEACH, which are
  // not part of their coordinator slice — showing them here would file an
  // out-of-scope row in the leadership audit below. Filter to the granted
  // grades (coordinates_class, 0052) so the picker and the audit agree; the
  // teacher's own classes stay one tab away on /dashboard/diary.
  const { data: classesRaw } = await supabase.from("classes").select("id, name, grade");
  const classes = ((classesRaw ?? []) as { id: string; name: string; grade: string | null }[])
    .filter((cl) => isAdmin || coordGrades.includes(cl.grade ?? ""))
    .sort((a, b) => `${a.grade ?? ""} ${a.name}`.localeCompare(`${b.grade ?? ""} ${b.name}`));
  const selected = classes.find((cl) => cl.id === c) ?? classes[0] ?? null;

  // ── This week's pulse (7 civil days ending on the viewed day) ───────────────
  const weekStart = shiftDay(day, -6);
  const { data: weekRaw } = await supabase
    .from("diary_notes")
    .select("id, note_type")
    .gte("entry_date", weekStart)
    .lte("entry_date", day);
  const week = (weekRaw ?? []) as { id: string; note_type: string }[];
  const byType = new Map<string, number>();
  for (const n of week) byType.set(n.note_type, (byType.get(n.note_type) ?? 0) + 1);
  const concernIds = week.filter((n) => n.note_type === "concern").map((n) => n.id);
  let concernAckedPct: number | null = null;
  if (concernIds.length) {
    const { data: ackRaw } = await supabase.from("diary_acks").select("note_id").in("note_id", concernIds);
    const signed = new Set(((ackRaw ?? []) as { note_id: string }[]).map((a) => a.note_id));
    concernAckedPct = Math.round((signed.size / concernIds.length) * 100);
  }

  // ── The selected class's day: roster, notes, threads, derived entries ───────
  type EnrRow = { student_id: string; profiles: { full_name: string | null; username: string | null } | null };
  let students: EnrRow[] = [];
  type NoteRow = {
    id: string;
    author_id: string;
    class_id: string | null;
    student_id: string | null;
    note_type: string;
    body: string;
    parents_only: boolean;
    created_at: string;
  };
  let notes: NoteRow[] = [];
  type ReplyRow = { id: string; note_id: string; author_id: string; body: string; created_at: string };
  let replies: ReplyRow[] = [];
  type AutoEntry = { label: string; detail: string };
  const autoEntries: AutoEntry[] = [];
  const authorName = new Map<string, string>();
  const studentName = new Map<string, string>();

  if (selected) {
    const { data: enrRaw } = await supabase
      .from("enrollments")
      .select("student_id, profiles(full_name, username)")
      .eq("class_id", selected.id);
    students = (enrRaw ?? []) as unknown as EnrRow[];
    for (const s of students)
      studentName.set(s.student_id, s.profiles?.full_name || s.profiles?.username || td.people.student);
    const studentIds = students.map((s) => s.student_id);

    // Class-wide notes plus per-student notes about this class's students
    // (filters before order — the builder types insist).
    const notesBase = supabase
      .from("diary_notes")
      .select("id, author_id, class_id, student_id, note_type, body, parents_only, created_at")
      .eq("entry_date", day);
    const { data: notesRaw } = await (studentIds.length
      ? notesBase.or(`class_id.eq.${selected.id},student_id.in.(${studentIds.join(",")})`)
      : notesBase.eq("class_id", selected.id)
    ).order("created_at");
    notes = (notesRaw ?? []) as NoteRow[];

    const noteIds = notes.map((n) => n.id);
    if (noteIds.length) {
      const { data: repRaw } = await supabase
        .from("diary_replies")
        .select("id, note_id, author_id, body, created_at")
        .in("note_id", noteIds)
        .order("created_at");
      replies = (repRaw ?? []) as ReplyRow[];
    }

    // Names: staff and students in scope resolve; a parent author's profile is
    // (correctly) out of leadership's read scope, so unresolved = "Parent".
    const authorIds = [...new Set([...notes.map((n) => n.author_id), ...replies.map((r) => r.author_id)])];
    if (authorIds.length) {
      const { data: authRaw } = await supabase.from("profiles").select("id, full_name, username").in("id", authorIds);
      for (const p of (authRaw ?? []) as { id: string; full_name: string | null; username: string | null }[])
        authorName.set(p.id, p.full_name || p.username || td.people.parent);
    }

    // Derived entries (nothing stored): what was assigned to this class that
    // day, and how many of its students completed something.
    const [sharesQ, progQ] = await Promise.all([
      supabase
        .from("generation_shares")
        .select("generation_id, created_at")
        .eq("class_id", selected.id)
        .gte("created_at", startUtc)
        .lt("created_at", endUtc),
      studentIds.length
        ? supabase
            .from("student_progress")
            .select("generation_id, student_id")
            .in("student_id", studentIds)
            .gte("completed_at", startUtc)
            .lt("completed_at", endUtc)
        : Promise.resolve({ data: [] as { generation_id: string; student_id: string }[] }),
    ]);
    const shares = (sharesQ.data ?? []) as { generation_id: string; created_at: string }[];
    const prog = (progQ.data ?? []) as { generation_id: string; student_id: string }[];
    const genIds = [...new Set([...shares.map((s) => s.generation_id), ...prog.map((p) => p.generation_id)])];
    const genTitle = new Map<string, string>();
    if (genIds.length) {
      const { data: gensRaw } = await supabase.from("generations").select("id, title, kind").in("id", genIds);
      for (const g of (gensRaw ?? []) as { id: string; title: string | null; kind: string | null }[])
        genTitle.set(
          g.id,
          g.title || (td.kinds as Record<string, string>)[g.kind ?? ""] || td.entry.assignment,
        );
    }
    for (const s of shares)
      autoEntries.push({ label: genTitle.get(s.generation_id) ?? td.entry.assignment, detail: td.entry.assignedChip });
    const completedBy = new Map<string, number>();
    for (const p of prog) completedBy.set(p.generation_id, (completedBy.get(p.generation_id) ?? 0) + 1);
    for (const [gid, n] of completedBy)
      autoEntries.push({
        label: genTitle.get(gid) ?? td.entry.assignment,
        // One and many are separate messages: the plural rule is the
        // translator's, not a trailing "s" this file can guess at.
        detail: n === 1 ? td.entry.completedByOne : fmt(td.entry.completedByMany, { n }),
      });
  }

  // ── DPDP audit trail: record this leadership view ───────────────────────────
  try {
    await supabase.from("analytics_access_log").insert({
      actor_id: user.id,
      actor_role: role,
      school_id: schoolId,
      scope: "diary",
      target_kind: "class",
      target_id: selected?.id ?? null,
      detail: { class_id: selected?.id ?? null, date: day },
    });
  } catch {
    // Logging must never break the page; a missing audit row is recoverable.
  }

  const metrics: { key: string; label: string; value: string | number; tone?: "warn" }[] = [
    { key: "total", label: t.notesSevenDays, value: week.length },
    ...NOTE_TYPES.map((nt) => ({
      key: nt,
      label: noteTypeLabel(td.noteTypes, nt),
      value: byType.get(nt) ?? 0,
      ...(nt === "concern" ? { tone: "warn" as const } : {}),
    })),
    { key: "concernSigned", label: t.concernSigned, value: concernAckedPct == null ? "—" : `${concernAckedPct}%` },
  ];

  const href = (dd: string) => `/dashboard/school/diary?${selected ? `c=${selected.id}&` : ""}d=${dd}`;

  // Built once, shared by every card below: one message object in the RSC
  // payload rather than one per note.
  const noteT: DiaryNoteMessages = { ...td.note, noteTypes: td.noteTypes, cancel: dict.common.cancel };

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <main className="max-w-7xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">{t.title}</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-7">{t.intro}</p>

        {/* Leadership's diary IS this page — they hold no personal Diary tab —
            so the school's board belongs here too. The banner comes with it:
            a principal wearing the principal hat has no Library, and would
            otherwise be the one person who never sees an urgent notice. */}
        <NoticesSection />

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 mb-10">
          {metrics.map((m) => (
            <div key={m.key} className="rounded-xl bg-white border border-[#E6E8E4] px-4 py-3">
              <div className="text-xs text-[#5B6470]">{m.label}</div>
              <div className={`text-2xl tabular mt-0.5 ${m.tone === "warn" && Number(m.value) > 0 ? "text-[#9A6400]" : ""}`}>
                {m.value}
              </div>
            </div>
          ))}
        </div>

        {classes.length === 0 ? (
          <div className="card px-5 py-6 text-sm text-[#5B6470]">{t.noClassesInScope}</div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5 mb-4">
              {classes.map((cl) => (
                <Link
                  key={cl.id}
                  href={`/dashboard/school/diary?c=${cl.id}&d=${day}`}
                  className={`chip font-sans normal-case tracking-normal ${
                    selected?.id === cl.id
                      ? "bg-[#E2F4F1] text-[#0C8175]"
                      : "bg-white border border-[#E6E8E4] text-[#5B6470]"
                  }`}
                >
                  {cl.name}
                </Link>
              ))}
            </div>

            <DateNav day={day} href={href} t={td.nav} lang={lang} />

            <div className="card divide-y divide-[#EEF0EC]">
              <p className="px-5 py-1.5 text-xs font-medium text-[#5B6470] bg-[#FAFBF9]">
                {fmt(td.fromClassroom, { count: autoEntries.length })}
              </p>
              {autoEntries.length ? (
                autoEntries.map((e, i) => (
                  <div key={i} className="px-5 py-2.5 text-sm flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate">{e.label}</span>
                    <span className="chip font-sans normal-case tracking-normal bg-[#EEF0EC] text-[#5B6470] shrink-0">
                      {e.detail}
                    </span>
                  </div>
                ))
              ) : (
                <p className="px-5 py-2.5 text-sm text-[#98A0A9]">{td.nothingRecorded}</p>
              )}

              <p className="px-5 py-1.5 text-xs font-medium text-[#5B6470] bg-[#FAFBF9]">
                {fmt(td.notesHeading, { count: notes.length })}
              </p>
              {notes.length ? (
                notes.map((n) => {
                  const item: DiaryNoteItem = {
                    id: n.id,
                    type: n.note_type,
                    body: n.body,
                    author: n.author_id === user.id ? td.people.you : authorName.get(n.author_id) ?? td.people.parent,
                    audience: n.student_id
                      ? studentName.get(n.student_id) ?? td.people.student
                      : selected?.name ?? td.people.theClass,
                    parentsOnly: n.parents_only,
                    createdAt: n.created_at,
                  };
                  const thread: DiaryReplyItem[] = replies
                    .filter((r) => r.note_id === n.id)
                    .map((r) => ({
                      id: r.id,
                      author: authorName.get(r.author_id) ?? td.people.parent,
                      body: r.body,
                      createdAt: r.created_at,
                    }));
                  // Read-only: no reply box, no ack — RLS blocks both anyway —
                  // and no delete either (`mine` left unset): this is the
                  // oversight page; an author retracts from their own diary.
                  return <DiaryNote key={n.id} note={item} replies={thread} t={noteT} lang={lang} />;
                })
              ) : (
                <p className="px-5 py-2.5 text-sm text-[#98A0A9]">{td.noNotes}</p>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
