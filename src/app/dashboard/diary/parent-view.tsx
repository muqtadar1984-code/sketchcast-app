import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { noticesEnabledFor } from "@/utils/flags";
import AppHeader from "../app-header";
import { InkUnderline } from "@/components/ink-mark";
import DiaryNote, { type DiaryNoteItem, type DiaryNoteMessages, type DiaryReplyItem } from "./diary-note";
import ParentCompose from "./parent-compose";
import DateNav, { dayWindowUtc, isDayKey, todayKey } from "./date-nav";
import { displayNames } from "./names";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { htmlLang } from "@/i18n/locales";
import { fmt } from "@/i18n/format";

// The PARENT page of the diary: one stacked section per linked child (the
// children-page shape), each showing the chosen day as a timeline —
//   · auto-entries DERIVED at read (nothing stored): what was assigned that
//     day (generation_shares ⋈ generations), what the child completed
//     (student_progress, with the submission score when there is one), and the
//     school notices posted that day (school_events, 0068 — rows PUBLISHED as
//     notices, SCHOOL audience only, scoped to THAT child's school; a staff
//     notice never reaches a parent, and neither does a plain calendar entry)
//   · the day's notes, including parents_only ones (this is the audience they
//     exist for), each with Acknowledge ("sign the diary"), reply + translate
//   · a compose box scoped to that child (per-student only — parents never
//     write class-wide; the API and RLS both enforce it)
// Every read is RLS-scoped to the parent's own children (0018/0066).

// A notice-flavoured row carries no completion state — it is an announcement,
// not work, so it wears its own chip instead of assigned/completed.
type AutoEntry = { label: string; detail: string; done: boolean; score: string | null; notice?: boolean };

export default async function ParentDiary({
  date,
  teacherHref = null,
}: {
  date?: string;
  /** Union mode only: back to this adult's own class diary (see page.tsx). */
  teacherHref?: string | null;
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
  // A notice's deadline is a DATE, not a time of day (school timezone — the
  // calendar doctrine's fixed UTC+8, same zone the day key is bucketed in),
  // written in the reader's own language.
  const dateFmt = new Intl.DateTimeFormat(lang, { timeZone: "Asia/Kuala_Lumpur", day: "numeric", month: "short" });

  const day = isDayKey(date) ? date : todayKey();
  const { startUtc, endUtc } = dayWindowUtc(day);

  // ── The parent's slice, all RLS-scoped ──────────────────────────────────────
  type LinkRow = {
    child_id: string;
    profiles: { full_name: string | null; username: string | null; school_id: string | null } | null;
  };
  const { data: linksRaw } = await supabase
    .from("parent_links")
    .select("child_id, profiles:child_id(full_name, username, school_id)")
    .order("created_at");
  const links = (linksRaw ?? []) as unknown as LinkRow[];

  // A parent carries no school of their own — they belong through each child.
  // A family can straddle two schools, so the announcement layer is resolved
  // PER CHILD SCHOOL: only the schools where notices are live fan anything in,
  // and the query below is scoped to exactly those (a pre-0068 database is
  // never asked for status/action_by).
  const noticeSchools: string[] = [];
  for (const sid of new Set(links.map((l) => l.profiles?.school_id).filter((s): s is string => !!s)))
    if (await noticesEnabledFor(supabase, sid)) noticeSchools.push(sid);

  type NoticeRow = {
    id: string;
    school_id: string;
    title: string;
    action_by: string | null;
    action_label: string | null;
    created_at: string;
  };
  const [enrQ, classesQ, notesQ, noticesQ] = await Promise.all([
    supabase.from("enrollments").select("class_id, student_id"),
    supabase.from("classes").select("id, name"),
    supabase
      .from("diary_notes")
      .select("id, author_id, class_id, student_id, note_type, body, parents_only, created_at")
      .eq("entry_date", day)
      .order("created_at"),
    // The day's school notices: rows published AS notices (an ordinary
    // school-wide calendar entry is not an announcement), the SCHOOL audience
    // only — a 'staff' notice is staff-room business and never reaches a parent
    // — published only, since RLS keeps revoked rows readable for leadership
    // audit, and scoped to the schools these children actually attend.
    noticeSchools.length
      ? supabase
          .from("school_events")
          .select("id, school_id, title, action_by, action_label, created_at")
          .eq("is_notice", true)
          .eq("audience", "school")
          .eq("status", "published")
          .in("school_id", noticeSchools)
          .gte("created_at", startUtc)
          .lt("created_at", endUtc)
          .order("created_at")
      : Promise.resolve({ data: [] as NoticeRow[] }),
  ]);
  const enr = (enrQ.data ?? []) as { class_id: string; student_id: string }[];
  const className = new Map(((classesQ.data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
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
  const notes = (notesQ.data ?? []) as NoteRow[];
  const notices = (noticesQ.data ?? []) as NoticeRow[];

  // Threads + receipts for the day's notes, and the day's derived entries.
  const noteIds = notes.map((n) => n.id);
  type ReplyRow = { id: string; note_id: string; author_id: string; body: string; created_at: string };
  type AckRow = { note_id: string; parent_id: string; student_id: string; acked_at: string };
  const [repliesQ, acksQ, sharesQ, progQ] = await Promise.all([
    noteIds.length
      ? supabase.from("diary_replies").select("id, note_id, author_id, body, created_at").in("note_id", noteIds).order("created_at")
      : Promise.resolve({ data: [] as ReplyRow[] }),
    noteIds.length
      ? supabase.from("diary_acks").select("note_id, parent_id, student_id, acked_at").in("note_id", noteIds)
      : Promise.resolve({ data: [] as AckRow[] }),
    supabase
      .from("generation_shares")
      .select("generation_id, class_id, student_id, created_at")
      .gte("created_at", startUtc)
      .lt("created_at", endUtc),
    supabase
      .from("student_progress")
      .select("generation_id, student_id, completed_at")
      .gte("completed_at", startUtc)
      .lt("completed_at", endUtc),
  ]);
  const replies = (repliesQ.data ?? []) as ReplyRow[];
  const acks = (acksQ.data ?? []) as AckRow[];
  const shares = (sharesQ.data ?? []) as { generation_id: string; class_id: string | null; student_id: string | null; created_at: string }[];
  const prog = (progQ.data ?? []) as { generation_id: string; student_id: string; completed_at: string }[];

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

  // Bylines: RLS resolves self + own children; a teacher's profile is
  // (correctly) unreadable to a parent, so names.ts fills the rest with the
  // service role — a real name, not a generic "Teacher" for everyone (the same
  // helper the teacher and student views use). "Teacher" stays the last resort
  // for a byline nothing could resolve (no service key in local dev).
  const names = await displayNames(
    supabase,
    [...notes.map((n) => n.author_id), ...replies.map((r) => r.author_id)].filter((id) => id !== user.id),
  );
  const nameOf = (id: string) => (id === user.id ? t.people.you : names.get(id) || t.people.teacher);

  const classesOfChild = new Map<string, string[]>();
  for (const e of enr) {
    if (!classesOfChild.has(e.student_id)) classesOfChild.set(e.student_id, []);
    classesOfChild.get(e.student_id)!.push(e.class_id);
  }

  function entriesFor(childId: string, schoolId: string | null): AutoEntry[] {
    const childClasses = new Set(classesOfChild.get(childId) ?? []);
    const out: AutoEntry[] = [];
    // The school's word first — a notice is addressed to the family, not to a
    // piece of work, so it opens the day rather than sitting among the tasks.
    // Scoped to THIS child's school: a two-school family must not read one
    // school's notice on the other child's page.
    for (const n of notices) {
      if (!schoolId || n.school_id !== schoolId) continue;
      out.push({
        label: fmt(t.entry.schoolNotice, { title: n.title }),
        detail: n.action_by
          ? fmt(t.entry.deadline, {
              label: n.action_label || t.entry.by,
              date: dateFmt.format(new Date(n.action_by)),
            })
          : t.entry.fromTheSchool,
        done: false,
        score: null,
        notice: true,
      });
    }
    for (const s of shares) {
      if (s.student_id !== childId && !(s.class_id && childClasses.has(s.class_id))) continue;
      const g = genOf.get(s.generation_id);
      out.push({
        label: g?.title || kindLabel(g?.kind) || t.entry.assignment,
        detail: fmt(t.entry.assignedIn, {
          where: s.class_id ? className.get(s.class_id) ?? t.entry.classFallback : t.entry.direct,
        }),
        done: false,
        score: null,
      });
    }
    for (const p of prog) {
      if (p.student_id !== childId) continue;
      const g = genOf.get(p.generation_id);
      const sub = subOf.get(`${p.generation_id}|${childId}`);
      out.push({
        label: g?.title || kindLabel(g?.kind) || t.entry.assignment,
        detail: t.entry.completedChip,
        done: true,
        score: sub && sub.max_score ? `${(sub.teacher_score ?? sub.auto_score) ?? "—"}/${sub.max_score}` : null,
      });
    }
    return out;
  }

  function notesFor(childId: string): NoteRow[] {
    const childClasses = new Set(classesOfChild.get(childId) ?? []);
    return notes.filter((n) => n.student_id === childId || (n.class_id != null && childClasses.has(n.class_id)));
  }

  // Built once, shared by every card below: one message object in the RSC
  // payload rather than one per note.
  const noteT: DiaryNoteMessages = { ...t.note, noteTypes: t.noteTypes, cancel: dict.common.cancel };
  const composeT = {
    ...t.parentCompose,
    noteTypes: t.noteTypes,
    addToDiary: t.addToDiary,
    saveFailed: t.saveNoteFailed,
    saving: dict.common.saving,
    cancel: dict.common.cancel,
  };

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <main className="max-w-7xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">{t.title}</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className={`text-[#5B6470] ${teacherHref ? "mb-2" : "mb-6"}`}>{t.parentIntro}</p>
        {teacherHref && (
          <p className="text-sm text-[#5B6470] mb-6">
            {t.viewingAsParent} ·{" "}
            <Link href={teacherHref} className="font-medium text-[#0C8175] hover:underline">
              {t.backToClassDiary}
            </Link>
          </p>
        )}

        {/* Day links keep the ?as=parent door open in union mode. */}
        <DateNav
          day={day}
          href={(d) => (teacherHref ? `/dashboard/diary?as=parent&d=${d}` : `/dashboard/diary?d=${d}`)}
          t={t.nav}
          lang={lang}
        />

        <div className="space-y-5">
          {links.length === 0 && (
            <div className="card px-5 py-8 text-sm text-[#5B6470]">{t.noChildrenLinked}</div>
          )}
          {links.map((l) => {
            const childName = l.profiles?.full_name || l.profiles?.username || t.people.child;
            const entries = entriesFor(l.child_id, l.profiles?.school_id ?? null);
            const childNotes = notesFor(l.child_id);
            const classLabels = (classesOfChild.get(l.child_id) ?? [])
              .map((cid) => className.get(cid))
              .filter(Boolean)
              .join(", ");
            return (
              <div key={l.child_id} className="card divide-y divide-[#EEF0EC]">
                <div className="px-5 py-3 flex items-center justify-between gap-3">
                  <span className="font-medium text-lg font-display truncate">{childName}</span>
                  {classLabels && <span className="text-xs text-[#5B6470] shrink-0">{classLabels}</span>}
                </div>

                <p className="px-5 py-1.5 text-xs font-medium text-[#5B6470] bg-[#FAFBF9]">
                  {fmt(t.fromClassroom, { count: entries.length })}
                </p>
                {entries.length ? (
                  entries.map((e, i) => (
                    <div key={i} className="px-5 py-2.5 text-sm flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate">
                        {e.label} <span className="text-xs text-[#5B6470]">· {e.detail}</span>
                      </span>
                      <span className="flex items-center gap-2 shrink-0">
                        {e.score && <span className="tabular text-xs">{e.score}</span>}
                        <span
                          className={`chip font-sans normal-case tracking-normal ${
                            e.notice
                              ? "bg-[#E8F1FB] text-[#175CD3]"
                              : e.done
                                ? "bg-[#E2F4F1] text-[#0C8175]"
                                : "bg-[#EEF0EC] text-[#5B6470]"
                          }`}
                        >
                          {e.notice
                            ? t.entry.schoolNoticeChip
                            : e.done
                              ? t.entry.completedChip
                              : t.entry.assignedChip}
                        </span>
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="px-5 py-2.5 text-sm text-[#98A0A9]">{t.nothingRecorded}</p>
                )}

                <p className="px-5 py-1.5 text-xs font-medium text-[#5B6470] bg-[#FAFBF9]">
                  {fmt(t.notesHeading, { count: childNotes.length })}
                </p>
                {childNotes.length ? (
                  childNotes.map((n) => {
                    const myAck = acks.find(
                      (a) => a.note_id === n.id && a.parent_id === user.id && a.student_id === l.child_id,
                    );
                    const item: DiaryNoteItem = {
                      id: n.id,
                      type: n.note_type,
                      body: n.body,
                      author: nameOf(n.author_id),
                      audience: n.class_id ? className.get(n.class_id) ?? t.people.theClass : childName,
                      parentsOnly: n.parents_only,
                      createdAt: n.created_at,
                      // Their own note home — theirs to take back
                      // (dn_author_delete); a teacher's note never is.
                      mine: n.author_id === user.id,
                    };
                    const thread: DiaryReplyItem[] = replies
                      .filter((r) => r.note_id === n.id)
                      .map((r) => ({
                        id: r.id,
                        author: nameOf(r.author_id),
                        body: r.body,
                        createdAt: r.created_at,
                        mine: r.author_id === user.id,
                      }));
                    return (
                      <DiaryNote
                        key={n.id}
                        note={item}
                        replies={thread}
                        canReply
                        ack={{ studentId: l.child_id, ackedAt: myAck?.acked_at ?? null }}
                        t={noteT}
                        lang={lang}
                      />
                    );
                  })
                ) : (
                  <p className="px-5 py-2.5 text-sm text-[#98A0A9]">{t.noNotes}</p>
                )}

                <ParentCompose studentId={l.child_id} childName={childName} entryDate={day} t={composeT} />
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
