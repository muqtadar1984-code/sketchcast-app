import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import UploadBook from "./upload-book";
import AutoRefresh from "./auto-refresh";
import DeleteLesson from "./delete-lesson";
import BookTable, { type BookRow } from "./book-table";
import { type BookHealth } from "./book-health-badge";
import BrandingCard from "./branding-card";
import ClassesCard, { type ClassRoster, type RosterStudent } from "./classes-card";
import AppHeader from "./app-header";
import StudentDashboard, {
  type StudentItemData,
  type StudentClassGroup,
} from "./student-dashboard";
import { EmptyBooks } from "./icons";
import { InkUnderline } from "@/components/ink-mark";
import FeedbackWidget from "./feedback-widget";
import ReportIssueWidget from "./report-issue-widget";
import BetaBanner from "./beta-banner";
import FairUseMeter from "./fair-use-meter";
import { platformConsoleEnabled, teacherBetaEnabled, timetableEnabledFor } from "@/utils/flags";
import { type JobStage } from "@/utils/job-stage";
import { enforceHat } from "@/utils/hats-server";

const KIND_LABEL: Record<string, string> = {
  presentation: "Lesson",
  worksheet: "Worksheet",
  exam_paper: "Exam",
  activity: "Activities",
  case_study: "Case study",
  lesson_plan: "Lesson plan",
};

type Chapter = { num: number; title: string; parts?: { titles?: string[]; words?: number }[] | null };

type Book = {
  id: string;
  title: string;
  author: string | null;
  owner_id: string;
  storage_path: string | null;
  status: string | null;
  chapters: Chapter[] | null;
  grade: string | null;
  subject: string | null;
  cover_path: string | null;
  created_at: string;
  health: BookHealth | null;
};

const STATUS_STYLE: Record<string, string> = {
  queued: "bg-[#EEF0EC] text-[#5B6470]",
  processing: "bg-[#FFF1D6] text-[#9A6400]",
  done: "bg-[#E2F4F1] text-[#0C8175]",
  error: "bg-[#FCEBEA] text-[#B42318]",
};

// Multi-part artifact ordering. NOT a path sort: ICU collation puts "." AFTER
// "_", so lesson.mp4 (Part 1) would sort BEHIND lesson_partN.mp4 — the student
// player would open on Part 2 and "complete" on the real Part 1. Extract the
// part number instead (no suffix = Part 1).
const partNum = (path: string): number => {
  const m = /_part(\d+)\.[a-z0-9]+$/i.exec(path);
  return m ? Number(m[1]) : 1;
};

export default async function DashboardPage() {
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
  const schoolId = (profile?.school_id as string | null) ?? null;
  const role = (profile?.role as string | null) ?? null;

  // Forced password change (set by /api/reset-password hand-outs and on
  // invited-student provisioning): everyone funnels through this page after
  // sign-in, so this is the single enforcement point. Separate best-effort
  // query so a not-yet-applied 0005 migration can't break the dashboard.
  const { data: mrp } = await supabase
    .from("profiles")
    .select("must_reset_password")
    .eq("id", user.id)
    .maybeSingle();

  // Lesson tools (0052): PE/Music/Art-style teachers don't teach from books —
  // SketchCast staff flag them and the upload/generation surfaces disappear
  // (the DB triggers are the real guard). Best-effort: a not-yet-applied 0052
  // must not break the dashboard, so a failed read means tools stay on.
  let lessonTools = true;
  {
    const { data: lt } = await supabase.from("profiles").select("lesson_tools").eq("id", user.id).maybeSingle();
    if (lt && (lt as { lesson_tools?: boolean | null }).lesson_tools === false) lessonTools = false;
  }
  if ((mrp as { must_reset_password?: boolean } | null)?.must_reset_password) {
    redirect("/auth/update-password");
  }

  // One-hat mode: the Library is the TEACHER hat's home — an adult wearing a
  // different hat is sent to that hat's world instead (presentation only;
  // students are unaffected and every page keeps its own auth gates).
  const hatAway = await enforceHat(supabase, role, schoolId, "teacher");
  if (hatAway) redirect(hatAway);

  // Teacher trial locks + signup notification: best-effort queries so a
  // not-yet-applied migration can never break the dashboard.
  // The trial state mirrors the DB scope EXACTLY via my_trial_pin (0057):
  // trial tier, no school, not a parent, no console override. beta_tester
  // alone no longer decides — the flag is never cleared on upgrade, so a
  // paying teacher must unlock the moment their entitlement lands (review
  // finding). Before 0057 runs, the RPC is absent → no locks, matching the
  // unpinned DB.
  let isBeta = false;
  let trialPin: { bookId: string; chapterRef: string | null; part: number | null } | null = null;
  let trialBookUsed = 0;
  if (role && role !== "student") {
    if (teacherBetaEnabled()) {
      const { data: tp } = await supabase.rpc("my_trial_pin");
      const pin = (Array.isArray(tp) ? tp[0] : tp) as
        | {
            in_scope: boolean;
            pinned: boolean;
            book_id: string | null;
            chapter_ref: string | null;
            part: number | null;
            repinnable: boolean;
          }
        | null;
      isBeta = !!pin?.in_scope;
      // repinnable = the DB's failed-first-attempt escape is open (the pinned
      // unit never succeeded and every remaining generation errored) — render
      // as unpinned so the teacher can restart anywhere, exactly as the DB
      // would accept. The pin moves on their next accepted generation.
      if (isBeta && pin?.pinned && pin.book_id && !pin.repinnable) {
        trialPin = {
          bookId: pin.book_id,
          chapterRef: pin.chapter_ref,
          part: pin.part && pin.part >= 1 ? pin.part : null,
        };
      }
      if (isBeta) {
        const { data: used } = await supabase.rpc("my_trial_book_used");
        trialBookUsed = typeof used === "number" ? used : 0;
      }
    }
    // Every signup path (email, Google, invite, school setup) funnels through
    // this page, so the founder's new-registration email fires here, exactly
    // once per account (signup_notified_at is the dedup marker).
    const { data: b } = await supabase
      .from("profiles")
      .select("signup_notified_at")
      .eq("id", user.id)
      .maybeSingle();
    const flags = b as { signup_notified_at?: string | null } | null;
    if (flags && !flags.signup_notified_at) {
      const { notifySignupOnce } = await import("@/utils/notify");
      await notifySignupOnce(user.id, user.email ?? null, (profile?.full_name as string) ?? null, role);
    }
  }

  // Parents are now full authors (migration 0035 dropped the test-papers-only
  // trigger): they fall through to the Library like any other adult, with
  // My Children + Test Papers as extra tabs (see app-header tabsFor). No redirect.

  // ── Student view ──────────────────────────────────────────────────────────
  // Students see only the content assigned to them (RLS → shared_to_me). We sign
  // those artifacts with the service role since the storage policy only lets the
  // owning teacher sign directly.
  if (role === "student") {
    const { data: gensRaw } = await supabase
      .from("generations")
      .select("id, kind, chapter_ref, book_id, params, artifacts(kind, storage_path)")
      .order("created_at", { ascending: false });
    const { data: sharesRaw } = await supabase
      .from("generation_shares")
      .select("generation_id, due_at, class_id, classes(name)");

    type ShareRow = { generation_id: string; due_at: string | null; class_id: string | null; classes: { name: string } | null };
    type ShareInfo = { due: string | null; className: string; classId: string | null };
    const shareByGen = new Map<string, ShareInfo>();
    // (to-one embeds come back as objects at runtime; supabase-js types them as arrays)
    for (const s of (sharesRaw ?? []) as unknown as ShareRow[]) {
      const gid = s.generation_id;
      // class_id null = a direct share (parent portal) — group it under a
      // family heading instead of a class name.
      const className = s.classes?.name || (s.class_id ? "My class" : "From your parent");
      const due = s.due_at ?? null;
      const prev = shareByGen.get(gid);
      if (!prev) shareByGen.set(gid, { due, className, classId: s.class_id });
      else if (due && (!prev.due || new Date(due) < new Date(prev.due)))
        shareByGen.set(gid, { due, className: prev.className, classId: prev.classId });
    }

    // Current progress + submissions for this student (tables from migration 0006;
    // if not applied yet these error → empty maps → everything shows "not started").
    const { data: progRaw } = await supabase
      .from("student_progress")
      .select("generation_id, status, revision_count, progress_pct");
    const progByGen = new Map<string, { status: string; revisionCount: number; progressPct: number }>();
    for (const p of (progRaw ?? []) as { generation_id: string; status: string; revision_count: number; progress_pct: number }[])
      progByGen.set(p.generation_id, {
        status: p.status,
        revisionCount: p.revision_count ?? 0,
        progressPct: p.progress_pct ?? 0,
      });
    const { data: subsRaw } = await supabase.from("submissions").select("generation_id");
    const submittedSet = new Set((subsRaw ?? []).map((s: { generation_id: string }) => s.generation_id));

    let downloadsReady = true;
    let admin: ReturnType<typeof createAdminClient> | null = null;
    try {
      admin = createAdminClient();
    } catch {
      downloadsReady = false;
    }
    const sign = async (path: string | null): Promise<string | null> => {
      if (!path || !admin) return null;
      const { data } = await admin.storage.from("artifacts").createSignedUrl(path, 3600);
      return data?.signedUrl ?? null;
    };

    type GenRow = {
      id: string;
      kind: string;
      chapter_ref: string | null;
      book_id: string | null;
      params: { part?: unknown } | null;
      artifacts: { kind: string; storage_path: string }[];
    };
    type Item = StudentItemData & { className: string; chapterRef: string | null; bookId: string | null };
    // Real chapter titles for headings ("Unit 1: Be a designer" beats "Chapter 1").
    // RLS: students in a school can read its books; failure → graceful fallback.
    const { data: sBooks } = await supabase.from("books").select("id, chapters");
    const chapterTitle = new Map<string, string>();
    for (const b of (sBooks ?? []) as { id: string; chapters: { num: number; title: string }[] | null }[]) {
      for (const c of b.chapters ?? []) {
        if (c.title && !/^\d+$/.test(c.title.trim())) chapterTitle.set(`${b.id}|${c.num}`, c.title);
      }
    }
    const items: Item[] = [];
    // (server component, rendered once per request — Date.now is fine here)
    // eslint-disable-next-line react-hooks/purity
    const now = Date.now();
    for (const g of (gensRaw ?? []) as GenRow[]) {
      const info = shareByGen.get(g.id);
      if (!info || g.kind === "lesson_plan") continue; // only assigned, never the teacher plan
      const arts = g.artifacts ?? [];
      const path = (k: string) => arts.find((a) => a.kind === k)?.storage_path ?? null;
      const prog = progByGen.get(g.id);
      // Multi-part lessons: every video/deck part, in PART order (Part 1 first).
      // NULL SLOTS ARE KEPT for videos: parts.length must always equal the true
      // part count — silently dropping a transiently-unsignable URL would shift
      // part numbering and corrupt the per-part progress math (a student could
      // even "complete" a lesson with a middle part missing).
      const videoPaths = arts
        .filter((a) => a.kind === "video_mp4")
        .map((a) => a.storage_path)
        .sort((a, b) => partNum(a) - partNum(b));
      const videos = await Promise.all(videoPaths.map(sign));
      const deckPaths = arts
        .filter((a) => a.kind === "deck_pptx")
        .map((a) => a.storage_path)
        .sort((a, b) => partNum(a) - partNum(b));
      const decks = (await Promise.all(deckPaths.map(sign))).filter((u): u is string => !!u);
      // Per-part lesson units: label carries the part so three assigned
      // "Lesson"s of one chapter read as Part 1/2/3, not three clones.
      const genPart = g.params?.part;
      const partLabel = typeof genPart === "number" && genPart >= 1 ? ` · Part ${genPart}` : "";
      items.push({
        genId: g.id,
        kind: g.kind,
        label: `${KIND_LABEL[g.kind] ?? g.kind}${partLabel}`,
        dueAt: info.due,
        dueOverdue: !!info.due && new Date(info.due).getTime() < now,
        classId: info.classId,
        className: info.className,
        chapterRef: g.chapter_ref ?? null,
        bookId: g.book_id ?? null,
        video: videos[0] ?? null,
        videos,
        deck: decks[0] ?? null,
        decks,
        doc: await sign(path("docx")),
        quiz: await sign(path("questions_json")),
        status: (prog?.status as StudentItemData["status"]) ?? null,
        revisionCount: prog?.revisionCount ?? 0,
        progressPct: prog?.progressPct ?? 0,
        submitted: submittedSet.has(g.id),
      });
    }

    // Group by class → chapter.
    const byClass = new Map<string, Map<string, Item[]>>();
    for (const it of items) {
      const chKey = it.chapterRef ?? "—";
      if (!byClass.has(it.className)) byClass.set(it.className, new Map());
      const chMap = byClass.get(it.className)!;
      if (!chMap.has(chKey)) chMap.set(chKey, []);
      chMap.get(chKey)!.push(it);
    }
    const groups: StudentClassGroup[] = [...byClass.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([className, chMap]) => ({
        className,
        chapters: [...chMap.entries()]
          .sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0))
          .map(([chKey, its]) => ({
            key: chKey,
            // Prefer the chapter's real title ("Unit 1: Be a designer").
            heading:
              chKey === "—"
                ? "Lessons"
                : chapterTitle.get(`${its[0]?.bookId}|${Number(chKey)}`) ||
                  `Chapter ${Number(chKey) + 1}`,
            items: its,
          })),
      }));

    // School-linked students get their class timetable; the header tab is
    // hidden on phones, so surface an in-page link too.
    const studentTimetableOn = schoolId ? await timetableEnabledFor(supabase, schoolId) : false;
    return (
      <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
        <AppHeader />
        {studentTimetableOn && (
          <div className="max-w-5xl mx-auto px-6 pt-4 sm:hidden">
            <Link href="/dashboard/my-timetable" className="chip bg-[#E2F4F1] text-[#0C8175]">
              📅 My timetable
            </Link>
          </div>
        )}
        <div data-tour="assignments">
          <StudentDashboard groups={groups} studentId={user.id} downloadsReady={downloadsReady} />
        </div>
        {platformConsoleEnabled() && <ReportIssueWidget variant="student" />}
      </div>
    );
  }

  // Teacher surfaces show what the person OWNS. Admins/coordinators can read
  // school-wide rows under RLS, so filter by ownership explicitly — their
  // Library is their teacher hat, not the school view (that's /dashboard/school).
  // Simple list for the assignment dropdown — always works (no 0005 columns).
  const { data: classesRaw } = await supabase
    .from("classes")
    .select("id, name, grade")
    .eq("teacher_id", user.id)
    .order("created_at", { ascending: false });
  const classes = (classesRaw ?? []) as { id: string; name: string; grade: string | null }[];

  // Roster for the Classes card. Reads migration 0005's profile columns + policy;
  // if that migration isn't applied yet the query errors and we degrade to [] so
  // the rest of the dashboard keeps working.
  const { data: rostersRaw } = await supabase
    .from("classes")
    .select("id, name, grade, join_code, enrollments(profiles(id, full_name, username, parent_email))")
    .eq("teacher_id", user.id)
    .order("created_at", { ascending: false });
  type RosterRaw = {
    id: string;
    name: string;
    grade: string | null;
    join_code: string;
    enrollments: { profiles: RosterStudent | null }[];
  };
  const classRosters: ClassRoster[] = ((rostersRaw ?? []) as unknown as RosterRaw[]).map((c) => ({
    id: c.id,
    name: c.name,
    grade: c.grade,
    join_code: c.join_code,
    students: (c.enrollments ?? []).map((e) => e.profiles).filter((p): p is RosterStudent => !!p),
  }));

  const { data: brandingRow } = await supabase
    .from("branding")
    .select("docx_path, pptx_path")
    .eq("owner_id", user.id)
    .maybeSingle();

  // `health` (migration 0021) is optional — degrade to the health-less select
  // so the library never breaks on a not-yet-applied migration.
  const bookCols = "id, title, author, owner_id, storage_path, status, chapters, grade, subject, cover_path, created_at";
  const withHealth = await supabase
    .from("books")
    .select(`${bookCols}, health`)
    .eq("owner_id", user.id)
    .order("created_at", { ascending: false });
  const booksRes = withHealth.error
    ? await supabase.from("books").select(bookCols).eq("owner_id", user.id).order("created_at", { ascending: false })
    : withHealth;
  const bookList = (booksRes.data ?? []) as unknown as Book[];

  // Detected book languages (0056) — separate best-effort query so a
  // not-yet-run migration can never break the Library.
  const bookLangs = new Map<string, string>();
  if (bookList.length) {
    const { data: bl } = await supabase
      .from("books")
      .select("id, language")
      .in("id", bookList.map((b) => b.id));
    for (const b of (bl ?? []) as { id: string; language: string | null }[]) {
      if (b.language) bookLangs.set(b.id, b.language);
    }
  }

  // Signed URLs for cover thumbnails.
  const coverUrls: Record<string, string | null> = {};
  await Promise.all(
    bookList.map(async (b) => {
      if (b.cover_path) {
        const { data } = await supabase.storage.from("artifacts").createSignedUrl(b.cover_path, 3600);
        coverUrls[b.id] = data?.signedUrl ?? null;
      } else {
        coverUrls[b.id] = null;
      }
    }),
  );

  const { data: gensRaw } = await supabase
    .from("generations")
    .select(
      // jobs(*) on purpose: the embedded wildcard tolerates the 0053 `stage`
      // column existing or not, so deploy order can't break the Library.
      "id, title, status, created_at, kind, chapter_ref, book_id, params, artifacts(kind, storage_path), jobs(*)",
    )
    .eq("owner_id", user.id)
    .order("created_at", { ascending: false });

  type LessonRow = {
    id: string;
    title: string | null;
    status: string;
    kind: string | null;
    chapter_ref: string | null;
    book_id: string | null;
    params: Record<string, unknown> | null;
    artifacts: { kind: string; storage_path: string }[] | null;
    jobs: { progress: number | null; status: string; stage?: JobStage | null }[] | null;
  };

  // Build signed download URLs for finished artifacts.
  const lessons = await Promise.all(
    ((gensRaw ?? []) as unknown as LessonRow[]).map(async (g) => {
      const arts = await Promise.all(
        (g.artifacts ?? []).map(async (a) => {
          const { data } = await supabase.storage
            .from("artifacts")
            .createSignedUrl(a.storage_path, 3600);
          return { kind: a.kind as string, path: a.storage_path, url: data?.signedUrl ?? null };
        }),
      );
      // Multi-part lessons: a long chapter renders as several ~15-min videos
      // (lesson.mp4, lesson_part2.mp4, …) with a deck per part — collect ALL of
      // them in PART order. `video`/`deck` stay the first part for old call sites.
      const videos = arts
        .filter((a) => a.kind === "video_mp4" && a.url)
        .sort((a, b) => partNum(a.path) - partNum(b.path))
        .map((a) => a.url!);
      const decks = arts
        .filter((a) => a.kind === "deck_pptx" && a.url)
        .sort((a, b) => partNum(a.path) - partNum(b.path))
        .map((a) => a.url!);
      return {
        id: g.id,
        title: g.title || "Untitled lesson",
        status: g.status,
        progress: g.jobs?.[0]?.progress ?? 0,
        stage: g.jobs?.[0]?.stage ?? null,
        kind: g.kind || "presentation",
        params: g.params ?? null,
        bookId: g.book_id ?? null,
        chapterRef: g.chapter_ref ?? null,
        deck: decks[0] ?? null,
        decks,
        video: videos[0] ?? null,
        videos,
        doc: arts.find((a) => a.kind === "docx")?.url ?? null,
        artifactPaths: (g.artifacts ?? []).map((a) => a.storage_path),
      };
    }),
  );
  type Lesson = (typeof lessons)[number];

  // Latest generation for a book + chapter + kind (gensRaw is newest-first).
  // `part` scopes to per-part lesson units: null = the whole-chapter artifact
  // (a lesson generated with params.part never fills the whole-chapter cell,
  // and vice versa).
  const partOf = (l: Lesson): number | null => {
    const p = (l.params as { part?: unknown } | null)?.part;
    return typeof p === "number" && p >= 1 ? p : null;
  };
  const lessonFor = (bookId: string, num: number, kind: string, part: number | null = null): Lesson | undefined =>
    lessons.find(
      (l) => l.bookId === bookId && l.chapterRef === String(num) && l.kind === kind && partOf(l) === part,
    );
  // The chapter's "lesson" = its presentation (deck+video) — used for progress.
  const lessonForChapter = (bookId: string, num: number): Lesson | undefined =>
    lessonFor(bookId, num, "presentation");
  // Lessons for a book that aren't tied to one of its current chapters
  // (legacy whole-book lessons with chapter_ref = null, or stale refs) — plus
  // ORPHANED part lessons: a re-index can shrink or drop a chapter's part
  // map, and a lesson with params.part beyond it must stay visible (and
  // deletable) here rather than silently vanishing.
  const otherLessonsForBook = (book: Book): Lesson[] => {
    const nums = new Set((book.chapters ?? []).map((c) => String(c.num)));
    const partsLen = new Map((book.chapters ?? []).map((c) => [String(c.num), c.parts?.length ?? 0]));
    return lessons.filter((l) => {
      if (l.bookId !== book.id) return false;
      if (l.chapterRef === null || !nums.has(l.chapterRef)) return true;
      const part = partOf(l);
      if (part !== null) {
        const n = partsLen.get(l.chapterRef) ?? 0;
        return n <= 1 || part > n;
      }
      return false;
    });
  };
  // Lessons queued via the book's "Generate selected" batch — shown together
  // under their own sub-header at the end of the book (marked params.batch).
  const batchLessonsForBook = (book: Book): Lesson[] =>
    lessons.filter((l) => l.bookId === book.id && (l.params as { batch?: unknown } | null)?.batch === true);

  const hasPending =
    lessons.some((l) => l.status === "queued" || l.status === "processing") ||
    bookList.some((b) => b.status === "indexing");

  // Shape the data for the (client) collapsible book/chapter table.
  const bookRows: BookRow[] = bookList.map((b) => {
    const chs = b.chapters ?? [];
    return {
      id: b.id,
      title: b.title,
      author: b.author,
      status: b.status,
      grade: b.grade,
      subject: b.subject,
      language: bookLangs.get(b.id) ?? null,
      coverUrl: coverUrls[b.id] ?? null,
      storagePath: b.storage_path,
      createdAt: b.created_at,
      health: (b.health as BookHealth | null) ?? null,
      doneChapters: chs.filter((c) => lessonForChapter(b.id, c.num)?.status === "done").length,
      totalChapters: chs.length,
      presentationIds: [
        ...chs.map((c) => lessonFor(b.id, c.num, "presentation")),
        // Per-part lessons are as assignable as whole-chapter ones.
        ...chs.flatMap((c) =>
          (c.parts?.length ?? 0) > 1 ? c.parts!.map((_, i) => lessonFor(b.id, c.num, "presentation", i + 1)) : [],
        ),
      ]
        .filter((l): l is Lesson => !!l && l.status === "done")
        .map((l) => l.id),
      chapters: chs.map((c) => ({
        num: c.num,
        title: c.title,
        presentation: lessonFor(b.id, c.num, "presentation") ?? null,
        lessonPlan: lessonFor(b.id, c.num, "lesson_plan") ?? null,
        activity: lessonFor(b.id, c.num, "activity") ?? null,
        worksheet: lessonFor(b.id, c.num, "worksheet") ?? null,
        exam: lessonFor(b.id, c.num, "exam_paper") ?? null,
        caseStudy: lessonFor(b.id, c.num, "case_study") ?? null,
        // Per-part lesson units (index-time part map, 2026-07-18): each part
        // carries its OWN full kit, generated on demand.
        parts:
          (c.parts?.length ?? 0) > 1
            ? c.parts!.map((p, i) => ({
                n: i + 1,
                titles: (p.titles ?? []).slice(0, 3),
                presentation: lessonFor(b.id, c.num, "presentation", i + 1) ?? null,
                lessonPlan: lessonFor(b.id, c.num, "lesson_plan", i + 1) ?? null,
                activity: lessonFor(b.id, c.num, "activity", i + 1) ?? null,
                worksheet: lessonFor(b.id, c.num, "worksheet", i + 1) ?? null,
                exam: lessonFor(b.id, c.num, "exam_paper", i + 1) ?? null,
                caseStudy: lessonFor(b.id, c.num, "case_study", i + 1) ?? null,
              }))
            : [],
      })),
      pendingChapters: chs.filter((c) => !lessonForChapter(b.id, c.num)),
      otherLessons: otherLessonsForBook(b),
      batchLessons: batchLessonsForBook(b),
    };
  });

  // Beta state: the pinned unit (the DB's own answer via my_trial_pin —
  // display-list derivation broke on created_at ties and the 1000-row cap),
  // remaining student slots, and whether feedback was already submitted (the
  // widget is entirely voluntary — it opens only from its button).
  const betaPinned = trialPin;
  let betaSlotsLeft: number | null = null;
  let feedback: { submitted: boolean } | null = null;
  if (isBeta) {
    const distinctStudents = new Set(
      classRosters.flatMap((c) => c.students.map((s) => s.username || s.full_name || "")),
    ).size;
    betaSlotsLeft = Math.max(0, 2 - distinctStudents);
    const { data: fb } = await supabase.from("beta_feedback").select("id").maybeSingle();
    feedback = { submitted: !!fb };
  }

  // Group the library Grade → Subject (auto-detected; "Other / General" when unknown).
  const groupMap = new Map<string, BookRow[]>();
  for (const br of bookRows) {
    const key = `${br.grade || "Other"}|||${br.subject || "General"}`;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(br);
  }
  const groups = [...groupMap.entries()]
    .map(([key, rows]) => {
      const [grade, subject] = key.split("|||");
      return { grade, subject, books: rows };
    })
    .sort((a, b) => `${a.grade} ${a.subject}`.localeCompare(`${b.grade} ${b.subject}`));

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AutoRefresh active={hasPending} />
      <AppHeader />

      <main className="max-w-5xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">Your library</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-7">
          Upload a textbook, then generate a narrated lesson from it.
        </p>

        {isBeta && <BetaBanner />}

        {/* Fair-use transparency: what this month's plan includes, what's used,
            what carried over (0047). The DB triggers are the guard. */}
        {lessonTools && <FairUseMeter />}

        {/* The trial's book slot comes from the 0046 ledger (my_trial_book_used):
            a deleted generated-from book keeps its slot consumed, so live book
            rows must not decide whether to offer a doomed multi-minute upload. */}
        {lessonTools ? (
          <UploadBook
            schoolId={schoolId}
            betaBlocked={isBeta && (trialBookUsed >= 1 || bookList.some((b) => b.owner_id === user.id))}
          />
        ) : (
          <p className="text-sm text-[#5B6470] mb-6">
            Your account is set up for teaching without book tools (PE, music, arts and similar
            subjects) — your timetable and classes are below. If that's wrong, ask your school to
            contact SketchCast support.
          </p>
        )}

        <div data-tour="classes">
          <ClassesCard classes={classRosters} betaSlotsLeft={betaSlotsLeft} />
        </div>

        <div data-tour="branding">
          <BrandingCard hasDocx={!!brandingRow?.docx_path} hasPptx={!!brandingRow?.pptx_path} />
        </div>

        {bookList.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#D2D6D1] bg-white p-10 text-center text-[#5B6470]">
            <EmptyBooks />
            <p className="font-medium text-[#14181F] mb-4">Your library is empty — here&apos;s the whole journey:</p>
            <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
              <span className="inline-flex items-center gap-2 rounded-full bg-[#F5F6F3] px-3 py-1.5">
                <span className="h-5 w-5 rounded-full bg-[#1FB8A6] text-white text-xs font-medium inline-flex items-center justify-center">1</span>
                Upload a textbook PDF above
              </span>
              <span className="text-[#98A0A9]">→</span>
              <span className="inline-flex items-center gap-2 rounded-full bg-[#F5F6F3] px-3 py-1.5">
                <span className="h-5 w-5 rounded-full bg-[#1FB8A6] text-white text-xs font-medium inline-flex items-center justify-center">2</span>
                Generate a narrated lesson for a chapter
              </span>
              <span className="text-[#98A0A9]">→</span>
              <span className="inline-flex items-center gap-2 rounded-full bg-[#F5F6F3] px-3 py-1.5">
                <span className="h-5 w-5 rounded-full bg-[#1FB8A6] text-white text-xs font-medium inline-flex items-center justify-center">3</span>
                Assign it to your class &amp; watch progress
              </span>
            </div>
            <p className="text-xs text-[#98A0A9] mt-4">
              Chapters are detected automatically — scanned books included.
            </p>
          </div>
        ) : (
          <div className="space-y-8" data-tour="book-card">
            {groups.map((g) => (
              <section key={`${g.grade}-${g.subject}`}>
                <div className="flex items-center gap-2 mb-2.5 px-1">
                  <h2 className="chip font-sans bg-[#E2F4F1] text-[#0C8175]">{g.grade}</h2>
                  <span className="text-sm font-medium text-[#5B6470]">{g.subject}</span>
                </div>
                <BookTable
                  books={g.books}
                  schoolId={schoolId}
                  classes={classes}
                  beta={isBeta ? { pinned: betaPinned } : null}
                />
              </section>
            ))}
          </div>
        )}

        {lessons.filter((l) => l.bookId === null).length > 0 && (
          <>
            <h2 className="text-2xl mt-12 mb-4">Other lessons</h2>
            <div className="space-y-3">
              {lessons
                .filter((l) => l.bookId === null)
                .map((l) => (
                  <div key={l.id} className="card card-hover p-5">
                    <div className="flex items-center justify-between gap-4">
                      <span className="font-display font-medium truncate">{l.title}</span>
                      <div className="flex items-center gap-3 shrink-0">
                        {l.status === "done" &&
                          l.videos.map((url, i, all) => (
                            <a key={`v${i}`} href={url} target="_blank" className="text-sm font-medium text-[#0C8175] hover:underline">
                              {all.length > 1 ? (i === 0 ? "▶ Watch Pt 1" : `▶ Pt ${i + 1}`) : "▶ Watch"}
                            </a>
                          ))}
                        {l.status === "done" &&
                          l.decks.map((url, i, all) => (
                            <a key={`d${i}`} href={url} className="text-sm font-medium text-[#0C8175] hover:underline">
                              {all.length > 1 ? `⬇ Deck Pt ${i + 1}` : "⬇ Deck"}
                            </a>
                          ))}
                        {l.status !== "done" && (
                          <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[l.status] ?? ""}`}>
                            {l.status}
                            {l.status === "processing" ? ` · ${l.progress}%` : ""}
                          </span>
                        )}
                        <DeleteLesson genId={l.id} artifactPaths={l.artifactPaths} />
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          </>
        )}
      </main>

      {feedback && <FeedbackWidget submitted={feedback.submitted} />}
      {platformConsoleEnabled() && <ReportIssueWidget />}
    </div>
  );
}
