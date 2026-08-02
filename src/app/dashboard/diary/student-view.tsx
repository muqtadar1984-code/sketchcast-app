import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { noticesEnabledFor } from "@/utils/flags";
import AppHeader from "../app-header";
import NoticesSection from "../notices-section";
import { InkUnderline } from "@/components/ink-mark";
import DiaryNote, { type DiaryNoteItem, type DiaryNoteMessages, type DiaryReplyItem } from "./diary-note";
import DateNav, { dayWindowUtc, isDayKey, todayKey } from "./date-nav";
import { displayNames } from "./names";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { htmlLang } from "@/i18n/locales";
import { fmt } from "@/i18n/format";

// The STUDENT page of the diary: a read-only day timeline of their classes'
// notes + their own per-student notes, each with a reply box (students REPLY,
// never author notes — and dn_read already strips parents_only rows, so this
// page can't leak them even by mistake). Auto-entries are the same derived
// rows as everywhere else: what landed on them that day (generation_shares),
// what they finished (student_progress + their submission score), and the
// school notices posted that day (school_events, 0068 — rows PUBLISHED as
// notices, SCHOOL audience, their own school; a staff-room notice never reaches
// a diary page, and neither does a plain calendar entry). No compose, no
// signature UI — signing is a parent affair.

const KIND_ICON: Record<string, string> = {
  presentation: "🎬",
  activity: "🧩",
  worksheet: "📝",
  exam_paper: "🧪",
  exam: "🧪",
  case_study: "🔍",
};

type AutoEntry = { key: string; at: string; icon: string; text: string };

export default async function StudentDiary({ date }: { date?: string }) {
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
  const { startUtc, endUtc } = dayWindowUtc(day);
  // Times render in the school's timezone (calendar doctrine — fixed UTC+8),
  // written in the reader's own language.
  const timeFmt = new Intl.DateTimeFormat(lang, { timeZone: "Asia/Kuala_Lumpur", hour: "numeric", minute: "2-digit" });
  // A notice's deadline is a DATE, not a time of day.
  const dateFmt = new Intl.DateTimeFormat(lang, { timeZone: "Asia/Kuala_Lumpur", day: "numeric", month: "short" });

  // Is the announcement layer live for this student's school? Gated so a
  // pre-0068 database is never asked for status/action_by.
  const { data: myProfile } = await supabase.from("profiles").select("school_id").eq("id", user.id).maybeSingle();
  const mySchoolId = (myProfile?.school_id as string | null) ?? null;
  const noticesOn = await noticesEnabledFor(supabase, mySchoolId);

  // ── The student's slice, all RLS-scoped ─────────────────────────────────────
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
  type NoticeRow = { id: string; title: string; action_by: string | null; action_label: string | null; created_at: string };
  const [notesQ, classesQ, sharesQ, progQ, noticesQ] = await Promise.all([
    supabase
      .from("diary_notes")
      .select("id, author_id, class_id, student_id, note_type, body, parents_only, created_at")
      .eq("entry_date", day)
      .order("created_at"),
    supabase.from("classes").select("id, name"),
    supabase
      .from("generation_shares")
      .select("generation_id, class_id, created_at")
      .gte("created_at", startUtc)
      .lt("created_at", endUtc),
    supabase
      .from("student_progress")
      .select("generation_id, completed_at")
      .gte("completed_at", startUtc)
      .lt("completed_at", endUtc),
    // The day's school notices: rows published AS notices (an ordinary
    // school-wide calendar entry is not an announcement), the SCHOOL audience
    // only — a 'staff' notice is staff-room business and never reaches a diary
    // page — published only, since RLS keeps revoked rows readable for
    // leadership audit, and their own school's.
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
  const notes = (notesQ.data ?? []) as NoteRow[];
  const className = new Map(((classesQ.data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  const shares = (sharesQ.data ?? []) as { generation_id: string; class_id: string | null; created_at: string }[];
  const prog = (progQ.data ?? []) as { generation_id: string; completed_at: string }[];
  const notices = (noticesQ.data ?? []) as NoticeRow[];

  const noteIds = notes.map((n) => n.id);
  type ReplyRow = { id: string; note_id: string; author_id: string; body: string; created_at: string };
  const { data: repliesRaw } = noteIds.length
    ? await supabase
        .from("diary_replies")
        .select("id, note_id, author_id, body, created_at")
        .in("note_id", noteIds)
        .order("created_at")
    : { data: [] };
  const replies = (repliesRaw ?? []) as ReplyRow[];

  // Titles for the derived entries + their own scores for the day's completions.
  const genIds = [...new Set([...shares.map((s) => s.generation_id), ...prog.map((p) => p.generation_id)])];
  type GenRow = { id: string; title: string | null; kind: string | null };
  type SubRow = { generation_id: string; auto_score: number | null; teacher_score: number | null; max_score: number | null };
  const [gensQ, subsQ] = await Promise.all([
    genIds.length
      ? supabase.from("generations").select("id, title, kind").in("id", genIds)
      : Promise.resolve({ data: [] as GenRow[] }),
    prog.length
      ? supabase
          .from("submissions")
          .select("generation_id, auto_score, teacher_score, max_score")
          .in("generation_id", [...new Set(prog.map((p) => p.generation_id))])
      : Promise.resolve({ data: [] as SubRow[] }),
  ]);
  const genOf = new Map(((gensQ.data ?? []) as GenRow[]).map((g) => [g.id, g]));
  const subOf = new Map(((subsQ.data ?? []) as SubRow[]).map((s) => [s.generation_id, s]));

  const auto: AutoEntry[] = [];
  for (const s of shares) {
    const g = genOf.get(s.generation_id);
    if (g?.kind === "lesson_plan") continue; // the teacher's doc, never theirs
    const title = g?.title || kindLabel(g?.kind) || t.entry.anAssignmentStart;
    auto.push({
      key: `s-${s.generation_id}-${s.created_at}`,
      at: s.created_at,
      icon: KIND_ICON[g?.kind ?? ""] ?? "📌",
      text: s.class_id
        ? fmt(t.entry.assignedToYouIn, { title, class: className.get(s.class_id) ?? t.entry.classFallback })
        : fmt(t.entry.assignedToYou, { title }),
    });
  }
  for (const p of prog) {
    const g = genOf.get(p.generation_id);
    const sub = subOf.get(p.generation_id);
    const score = sub && sub.max_score ? `${(sub.teacher_score ?? sub.auto_score) ?? "—"}/${sub.max_score}` : null;
    // The score rides on its own message rather than being glued on here, so a
    // language that punctuates the aside differently still reads as one line.
    const line = fmt(t.entry.youCompleted, {
      title: g?.title || kindLabel(g?.kind) || t.entry.anAssignment,
    });
    auto.push({
      key: `p-${p.generation_id}`,
      at: p.completed_at,
      icon: "✅",
      text: score ? fmt(t.entry.withScore, { text: line, score }) : line,
    });
  }
  // A notice sits on the day it was POSTED — like every other row here, the day
  // is when the thing HAPPENED. Its deadline rides along in the text so the
  // page still answers "by when?".
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

  // Bylines: RLS resolves classmates at best; teachers and parents come from
  // the service-role fill in names.ts.
  const names = await displayNames(
    supabase,
    [...notes.map((n) => n.author_id), ...replies.map((r) => r.author_id)].filter((id) => id !== user.id),
  );
  const nameOf = (id: string) => (id === user.id ? t.people.you : names.get(id) || t.people.teacher);

  const noteItems: { item: DiaryNoteItem; thread: DiaryReplyItem[] }[] = notes.map((n) => ({
    item: {
      id: n.id,
      type: n.note_type,
      body: n.body,
      author: nameOf(n.author_id),
      audience: n.student_id ? t.people.yourself : (n.class_id && className.get(n.class_id)) || t.people.yourClass,
      parentsOnly: n.parents_only, // always false here — dn_read strips the rest
      createdAt: n.created_at,
      mine: n.author_id === user.id, // always false — students never author notes
    },
    thread: replies
      .filter((r) => r.note_id === n.id)
      .map((r) => ({
        id: r.id,
        author: nameOf(r.author_id),
        body: r.body,
        createdAt: r.created_at,
        // Their own reply is theirs to take back (dr_author_delete).
        mine: r.author_id === user.id,
      })),
  }));

  // Built once, shared by every card below: one message object in the RSC
  // payload rather than one per note.
  const noteT: DiaryNoteMessages = { ...t.note, noteTypes: t.noteTypes, cancel: dict.common.cancel };

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <main className="max-w-7xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">{t.title}</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-6">{t.studentIntro}</p>

        {/* The school's board — what's been announced and what's coming up.
            The Diary is where notices live; the lessons page keeps only the
            urgent banner. */}
        <NoticesSection />

        <DateNav day={day} href={(d) => `/dashboard/diary?d=${d}`} t={t.nav} lang={lang} />

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
              <DiaryNote key={n.item.id} note={n.item} replies={n.thread} canReply t={noteT} lang={lang} />
            ))
          ) : (
            <p className="px-5 py-2.5 text-sm text-[#98A0A9]">{t.noNotes}</p>
          )}
        </div>
      </main>
    </div>
  );
}
