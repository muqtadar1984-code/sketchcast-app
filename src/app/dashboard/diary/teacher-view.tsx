import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { noticesEnabledFor } from "@/utils/flags";
import AppHeader from "../app-header";
import NoticesSection from "../notices-section";
import { InkUnderline } from "@/components/ink-mark";
import DiaryNote, { type DiaryNoteItem, type DiaryNoteMessages, type DiaryReplyItem } from "./diary-note";
import DiaryCompose from "../diary-compose";
import DiaryDay from "../diary-day";
import { dayWindowUtc, isDayKey, todayKey } from "./date-nav";
import { displayNames } from "./names";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { htmlLang } from "@/i18n/locales";
import { fmt } from "@/i18n/format";

// The TEACHER page of the diary: pick one of your classes, pick a day, then
// the day reads like a page of the communication book —
//   · a compose card (class-wide or per-student, type chips, parents-only)
//   · auto-entries DERIVED at read (nothing stored): what was assigned to the
//     class that day (generation_shares ⋈ generations), which students
//     completed what (student_progress, with the submission score when graded)
//     and the school notices posted that day (school_events, 0068 — rows
//     PUBLISHED as notices, SCHOOL audience, this school; a staff-room notice
//     never reaches a diary page, and neither does a plain calendar entry)
//   · the day's notes — class-wide + per-student, parent-authored ones
//     included (RLS's diary_teacher_of delivers them) — each with the
//     "Signed N/M" parent-receipt count, the reply thread and translate
// RLS scopes every read; the only service-role touch is the signature
// DENOMINATOR (which students have a linked parent — teachers have no
// parent_links read path) and unresolved bylines (names.ts).

const KIND_ICON: Record<string, string> = {
  presentation: "🎬",
  activity: "🧩",
  worksheet: "📝",
  exam_paper: "🧪",
  exam: "🧪",
  case_study: "🔍",
};

type AutoEntry = { key: string; at: string; icon: string; text: string };

export default async function TeacherDiary({
  date,
  classParam,
  parentHref = null,
}: {
  date?: string;
  classParam?: string;
  /** Union mode only: this adult also has children — the door to their parent
   * diary, since no hat switcher renders (see page.tsx). */
  parentHref?: string | null;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // The page's words, and the tag its clocks are written in. resolveLocale is
  // React-cached, so asking here and in the header costs one lookup.
  const locale = await resolveLocale();
  const dict = await getDictionary(locale);
  const t = dict.comms.diary;
  const lang = htmlLang(locale);
  const kindLabel = (kind: string | null | undefined): string =>
    (t.kinds as Record<string, string>)[kind ?? ""] ?? "";

  const day = isDayKey(date) ? date : todayKey();
  const today = todayKey();
  const { startUtc, endUtc } = dayWindowUtc(day);
  // Times on derived rows render in the school's timezone (calendar doctrine —
  // fixed UTC+8; per-school config when a school outside MY signs up), written
  // in the reader's own language.
  const timeFmt = new Intl.DateTimeFormat(lang, { timeZone: "Asia/Kuala_Lumpur", hour: "numeric", minute: "2-digit" });
  // A notice's deadline is a DATE, not a time of day.
  const dateFmt = new Intl.DateTimeFormat(lang, { timeZone: "Asia/Kuala_Lumpur", day: "numeric", month: "short" });
  const dayLabel = new Date(`${day}T00:00:00Z`).toLocaleDateString(lang, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC", // the key IS the civil day — don't re-shift it
  });

  // Is the announcement layer live for this teacher's school? Notices fan into
  // the day the same way everything else here does — derived at read, gated so
  // a pre-0068 database is never asked for status/action_by.
  const { data: myProfile } = await supabase.from("profiles").select("school_id").eq("id", user.id).maybeSingle();
  const mySchoolId = (myProfile?.school_id as string | null) ?? null;
  const noticesOn = await noticesEnabledFor(supabase, mySchoolId);

  // Their OWN classes — admins/coordinators can read school-wide rows under
  // RLS, but this page is their teacher hat (the school-wide diary is
  // /dashboard/school/diary), so filter by ownership explicitly.
  const { data: classesRaw } = await supabase
    .from("classes")
    .select("id, name")
    .eq("teacher_id", user.id)
    .order("name");
  const classes = (classesRaw ?? []) as { id: string; name: string }[];
  const classId = classes.some((cl) => cl.id === classParam) ? classParam! : classes[0]?.id ?? null;
  const className = classes.find((cl) => cl.id === classId)?.name ?? "";

  let noteItems: {
    item: DiaryNoteItem;
    thread: DiaryReplyItem[];
    signed: { signed: number; total: number } | null;
  }[] = [];
  const auto: AutoEntry[] = [];
  let roster: { id: string; name: string }[] = [];

  if (classId) {
    // Roster: the compose target list, completion bylines and the "Signed N/M"
    // denominator all come from who is enrolled (0005's embed path).
    type RosterRaw = {
      enrollments: { profiles: { id: string; full_name: string | null; username: string | null } | null }[];
    };
    const { data: rosterRaw } = await supabase
      .from("classes")
      .select("id, enrollments(profiles(id, full_name, username))")
      .eq("id", classId)
      .maybeSingle();
    roster = ((rosterRaw as unknown as RosterRaw | null)?.enrollments ?? [])
      .map((e) => e.profiles)
      .filter((p): p is { id: string; full_name: string | null; username: string | null } => !!p)
      .map((p) => ({ id: p.id, name: p.full_name || p.username || t.people.student }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const rosterIds = roster.map((s) => s.id);
    const rosterName = new Map(roster.map((s) => [s.id, s.name]));

    // The day's notes: class-wide + per-student for this class's students (two
    // queries — an .or() over a long student-id list gets unwieldy).
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
    const noteCols = "id, author_id, class_id, student_id, note_type, body, parents_only, created_at";
    const [classNotesQ, studentNotesQ] = await Promise.all([
      supabase.from("diary_notes").select(noteCols).eq("class_id", classId).eq("entry_date", day),
      rosterIds.length
        ? supabase.from("diary_notes").select(noteCols).in("student_id", rosterIds).eq("entry_date", day)
        : Promise.resolve({ data: [] as NoteRow[] }),
    ]);
    const notes = ([...((classNotesQ.data ?? []) as NoteRow[]), ...((studentNotesQ.data ?? []) as NoteRow[])]).sort(
      (a, b) => a.created_at.localeCompare(b.created_at),
    );
    const noteIds = notes.map((n) => n.id);

    // Threads + receipts + the day's derived entries, in one round.
    type ReplyRow = { id: string; note_id: string; author_id: string; body: string; created_at: string };
    type AckRow = { note_id: string; student_id: string };
    type ShareRow = { generation_id: string; created_at: string };
    type ProgRow = { generation_id: string; student_id: string; completed_at: string };
    type NoticeRow = { id: string; title: string; action_by: string | null; action_label: string | null; created_at: string };
    const [repliesQ, acksQ, sharesQ, progQ, noticesQ] = await Promise.all([
      noteIds.length
        ? supabase.from("diary_replies").select("id, note_id, author_id, body, created_at").in("note_id", noteIds).order("created_at")
        : Promise.resolve({ data: [] as ReplyRow[] }),
      noteIds.length
        ? supabase.from("diary_acks").select("note_id, student_id").in("note_id", noteIds)
        : Promise.resolve({ data: [] as AckRow[] }),
      supabase
        .from("generation_shares")
        .select("generation_id, created_at")
        .eq("class_id", classId)
        .gte("created_at", startUtc)
        .lt("created_at", endUtc),
      supabase
        .from("student_progress")
        .select("generation_id, student_id, completed_at")
        .eq("class_id", classId)
        .gte("completed_at", startUtc)
        .lt("completed_at", endUtc),
      // The day's school notices. Four filters carry the whole rule: is_notice
      // (an ordinary school-wide calendar entry is not an announcement and has
      // no business on a diary page), the SCHOOL audience (a 'staff' notice is
      // staff-room business and must never land on a page parents and students
      // read), status — RLS keeps revoked rows readable for leadership audit,
      // so every reader surface, this one included, filters them out itself —
      // and the SCHOOL, because an adult who teaches in one school and parents
      // in another can read both boards, and only one of them is this class's.
      noticesOn && mySchoolId
        ? supabase
            .from("school_events")
            .select("id, title, action_by, action_label, created_at")
            .eq("school_id", mySchoolId)
            .eq("is_notice", true)
            .eq("audience", "school")
            .eq("status", "published")
            .gte("created_at", startUtc)
            .lt("created_at", endUtc)
        : Promise.resolve({ data: [] as NoticeRow[] }),
    ]);
    const replies = (repliesQ.data ?? []) as ReplyRow[];
    const acks = (acksQ.data ?? []) as AckRow[];
    const shares = (sharesQ.data ?? []) as ShareRow[];
    const prog = (progQ.data ?? []) as ProgRow[];
    const notices = (noticesQ.data ?? []) as NoticeRow[];

    // Titles for the derived entries + scores for the day's completions.
    const genIds = [...new Set([...shares.map((s) => s.generation_id), ...prog.map((p) => p.generation_id)])];
    type GenRow = { id: string; title: string | null; kind: string | null };
    type SubRow = { generation_id: string; student_id: string; auto_score: number | null; teacher_score: number | null; max_score: number | null };
    const [gensQ, subsQ] = await Promise.all([
      genIds.length
        ? supabase.from("generations").select("id, title, kind").in("id", genIds)
        : Promise.resolve({ data: [] as GenRow[] }),
      prog.length
        ? supabase
            .from("submissions")
            .select("generation_id, student_id, auto_score, teacher_score, max_score")
            .in("generation_id", [...new Set(prog.map((p) => p.generation_id))])
        : Promise.resolve({ data: [] as SubRow[] }),
    ]);
    const genOf = new Map(((gensQ.data ?? []) as GenRow[]).map((g) => [g.id, g]));
    const subOf = new Map(((subsQ.data ?? []) as SubRow[]).map((s) => [`${s.generation_id}|${s.student_id}`, s]));

    for (const s of shares) {
      const g = genOf.get(s.generation_id);
      if (g?.kind === "lesson_plan") continue; // the teacher's doc, never assigned
      auto.push({
        key: `s-${s.generation_id}-${s.created_at}`,
        at: s.created_at,
        icon: KIND_ICON[g?.kind ?? ""] ?? "📌",
        text: fmt(t.entry.assigned, { title: g?.title || kindLabel(g?.kind) || t.entry.anAssignment }),
      });
    }
    for (const p of prog) {
      const g = genOf.get(p.generation_id);
      const sub = subOf.get(`${p.generation_id}|${p.student_id}`);
      const score = sub && sub.max_score ? `${(sub.teacher_score ?? sub.auto_score) ?? "—"}/${sub.max_score}` : null;
      // Each row is a whole sentence in the file, never words glued together
      // here: the score rides on its own message so a language that punctuates
      // the aside differently still reads as one line.
      const line = fmt(t.entry.completedBy, {
        name: rosterName.get(p.student_id) ?? t.people.aStudent,
        title: g?.title || kindLabel(g?.kind) || t.entry.anAssignment,
      });
      auto.push({
        key: `p-${p.generation_id}-${p.student_id}`,
        at: p.completed_at,
        icon: "✅",
        text: score ? fmt(t.entry.withScore, { text: line, score }) : line,
      });
    }
    // A notice sits on the day it was POSTED — like every other row here, the
    // day is when the thing HAPPENED. Its deadline rides along in the text so
    // the page still answers "by when?" without a second date column.
    for (const n of notices) {
      const line = fmt(t.entry.schoolNotice, { title: n.title });
      auto.push({
        key: `n-${n.id}`,
        at: n.created_at,
        icon: "📣",
        text: n.action_by
          ? fmt(t.entry.withDeadline, {
              text: line,
              label: n.action_label || t.entry.by,
              date: dateFmt.format(new Date(n.action_by)),
            })
          : line,
      });
    }
    auto.sort((a, b) => a.at.localeCompare(b.at));

    // Parent signatures: the acks are readable under RLS; the DENOMINATOR
    // (which students have a linked parent account) needs the service role.
    // No key → hide the count rather than show a wrong denominator.
    const signedByNote = new Map<string, Set<string>>();
    for (const a of acks) {
      if (!signedByNote.has(a.note_id)) signedByNote.set(a.note_id, new Set());
      signedByNote.get(a.note_id)!.add(a.student_id);
    }
    let linked: Set<string> | null = null;
    if (rosterIds.length) {
      try {
        const admin = createAdminClient();
        const { data: pl } = await admin.from("parent_links").select("child_id").in("child_id", rosterIds);
        linked = new Set(((pl ?? []) as { child_id: string }[]).map((r) => r.child_id));
      } catch {
        /* no service key — count hidden */
      }
    }
    const signedFor = (n: NoteRow): { signed: number; total: number } | null => {
      if (!linked) return null;
      // Per-student note: only that child's parents can sign — 0/1 or 1/1.
      const total = n.student_id ? (linked.has(n.student_id) ? 1 : 0) : linked.size;
      // Count only signatures from students still on TODAY'S roster with a
      // linked parent (`linked` is the roster ∩ parent_links set) — a receipt
      // from a since-unenrolled child stands in the audit but isn't part of
      // this class's count, so N can never exceed M.
      const signers = signedByNote.get(n.id);
      let signed = 0;
      if (signers) for (const sid of signers) if (linked.has(sid)) signed++;
      return { signed, total };
    };

    const names = await displayNames(
      supabase,
      [...notes.map((n) => n.author_id), ...replies.map((r) => r.author_id)].filter((id) => id !== user.id),
    );
    const nameOf = (id: string) =>
      id === user.id ? t.people.you : names.get(id) || rosterName.get(id) || t.people.aParent;

    noteItems = notes.map((n) => ({
      item: {
        id: n.id,
        type: n.note_type,
        body: n.body,
        author: nameOf(n.author_id),
        audience: n.student_id ? rosterName.get(n.student_id) ?? t.people.oneStudent : className,
        parentsOnly: n.parents_only,
        createdAt: n.created_at,
        // Authors can take their own line back (dn_author_delete) — the same
        // comparison that renders the "You" byline above.
        mine: n.author_id === user.id,
      },
      thread: replies
        .filter((r) => r.note_id === n.id)
        .map((r) => ({
          id: r.id,
          author: nameOf(r.author_id),
          body: r.body,
          createdAt: r.created_at,
          mine: r.author_id === user.id,
        })),
      signed: signedFor(n),
    }));
  }

  // Built once, shared by every card below: one message object in the RSC
  // payload rather than one per note.
  const noteT: DiaryNoteMessages = { ...t.note, noteTypes: t.noteTypes, cancel: dict.common.cancel };

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <main className="max-w-7xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">{t.title}</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className={`text-[#5B6470] ${parentHref ? "mb-2" : "mb-6"}`}>{t.teacherIntro}</p>
        {parentHref && (
          <p className="text-sm text-[#5B6470] mb-6">
            {t.viewingAsTeacher} ·{" "}
            <Link href={parentHref} className="font-medium text-[#0C8175] hover:underline">
              {t.seeChildrensDiary}
            </Link>
          </p>
        )}

        {/* The school's board — what's been announced and what's coming up.
            The Diary is where notices live; the Library keeps only the urgent
            banner. */}
        <NoticesSection />

        {!classId ? (
          <div className="card px-5 py-8 text-sm text-[#5B6470]">{t.noClasses}</div>
        ) : (
          <>
            <DiaryDay classes={classes} classId={classId} date={day} today={today} t={t.nav} />

            <DiaryCompose
              classId={classId}
              className={className}
              students={roster}
              date={day}
              t={{
                ...t.compose,
                noteTypes: t.noteTypes,
                addToDiary: t.addToDiary,
                saveFailed: t.saveNoteFailed,
                saving: dict.common.saving,
              }}
            />

            <h2 className="font-display text-lg mb-3">{dayLabel}</h2>
            <div className="card divide-y divide-[#EEF0EC]">
              <p className="px-5 py-1.5 text-xs font-medium text-[#5B6470] bg-[#FAFBF9]">
                {fmt(t.fromClassroom, { count: auto.length })}
              </p>
              {auto.length ? (
                auto.map((a) => (
                  <div key={a.key} className="px-5 py-2.5 flex items-center gap-3 text-sm text-[#5B6470]">
                    <span aria-hidden>{a.icon}</span>
                    <span className="min-w-0 truncate">{a.text}</span>
                    <span className="ms-auto shrink-0 text-xs text-[#98A0A9]">{timeFmt.format(new Date(a.at))}</span>
                  </div>
                ))
              ) : (
                <p className="px-5 py-2.5 text-sm text-[#98A0A9]">{t.nothingRecorded}</p>
              )}

              <p className="px-5 py-1.5 text-xs font-medium text-[#5B6470] bg-[#FAFBF9]">
                {fmt(t.notesHeading, { count: noteItems.length })}
              </p>
              {noteItems.length ? (
                noteItems.map((n) => (
                  <DiaryNote
                    key={n.item.id}
                    note={n.item}
                    replies={n.thread}
                    canReply
                    signed={n.signed}
                    t={noteT}
                    lang={lang}
                  />
                ))
              ) : (
                <p className="px-5 py-2.5 text-sm text-[#98A0A9]">{t.noNotesWriteFirst}</p>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
