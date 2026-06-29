import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import UploadBook from "./upload-book";
import AutoRefresh from "./auto-refresh";
import DeleteLesson from "./delete-lesson";
import BookTable, { type BookRow } from "./book-table";
import BrandingCard from "./branding-card";
import { EmptyBooks, LogoMark } from "./icons";

type Chapter = { num: number; title: string };

type Book = {
  id: string;
  title: string;
  author: string | null;
  storage_path: string | null;
  status: string | null;
  chapters: Chapter[] | null;
  grade: string | null;
  subject: string | null;
  cover_path: string | null;
  created_at: string;
};

const STATUS_STYLE: Record<string, string> = {
  queued: "bg-[#F1ECE0] text-[#6F6A5F]",
  processing: "bg-[#FAEEDA] text-[#854F0B]",
  done: "bg-[#EAF1EC] text-[#2E6B4E]",
  error: "bg-[#FCEBEB] text-[#A32D2D]",
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

  const { data: classesRaw } = await supabase
    .from("classes")
    .select("id, name, grade")
    .order("created_at", { ascending: false });
  const classes = (classesRaw ?? []) as { id: string; name: string; grade: string | null }[];

  const { data: brandingRow } = await supabase
    .from("branding")
    .select("docx_path, pptx_path")
    .eq("owner_id", user.id)
    .maybeSingle();

  const { data: books } = await supabase
    .from("books")
    .select("id, title, author, storage_path, status, chapters, grade, subject, cover_path, created_at")
    .order("created_at", { ascending: false });
  const bookList = (books ?? []) as Book[];

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
      "id, title, status, created_at, kind, chapter_ref, book_id, artifacts(kind, storage_path), jobs(progress, status)",
    )
    .order("created_at", { ascending: false });

  // Build signed download URLs for finished artifacts.
  const lessons = await Promise.all(
    (gensRaw ?? []).map(async (g: any) => {
      const arts = await Promise.all(
        (g.artifacts ?? []).map(async (a: any) => {
          const { data } = await supabase.storage
            .from("artifacts")
            .createSignedUrl(a.storage_path, 3600);
          return { kind: a.kind as string, url: data?.signedUrl ?? null };
        }),
      );
      return {
        id: g.id as string,
        title: (g.title as string) || "Untitled lesson",
        status: g.status as string,
        progress: (g.jobs?.[0]?.progress as number) ?? 0,
        kind: (g.kind as string) || "presentation",
        params: (g.params as Record<string, unknown> | null) ?? null,
        bookId: (g.book_id as string | null) ?? null,
        chapterRef: (g.chapter_ref as string | null) ?? null,
        deck: arts.find((a) => a.kind === "deck_pptx")?.url ?? null,
        video: arts.find((a) => a.kind === "video_mp4")?.url ?? null,
        doc: arts.find((a) => a.kind === "docx")?.url ?? null,
        artifactPaths: (g.artifacts ?? []).map((a: any) => a.storage_path as string),
      };
    }),
  );
  type Lesson = (typeof lessons)[number];

  // Latest generation for a book + chapter + kind (gensRaw is newest-first).
  const lessonFor = (bookId: string, num: number, kind: string): Lesson | undefined =>
    lessons.find(
      (l) => l.bookId === bookId && l.chapterRef === String(num) && l.kind === kind,
    );
  // The chapter's "lesson" = its presentation (deck+video) — used for progress.
  const lessonForChapter = (bookId: string, num: number): Lesson | undefined =>
    lessonFor(bookId, num, "presentation");
  // Lessons for a book that aren't tied to one of its current chapters
  // (legacy whole-book lessons with chapter_ref = null, or stale refs).
  const otherLessonsForBook = (book: Book): Lesson[] => {
    const nums = new Set((book.chapters ?? []).map((c) => String(c.num)));
    return lessons.filter(
      (l) => l.bookId === book.id && (l.chapterRef === null || !nums.has(l.chapterRef)),
    );
  };

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
      coverUrl: coverUrls[b.id] ?? null,
      storagePath: b.storage_path,
      createdAt: b.created_at,
      doneChapters: chs.filter((c) => lessonForChapter(b.id, c.num)?.status === "done").length,
      totalChapters: chs.length,
      presentationIds: chs
        .map((c) => lessonFor(b.id, c.num, "presentation"))
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
      })),
      pendingChapters: chs.filter((c) => !lessonForChapter(b.id, c.num)),
      otherLessons: otherLessonsForBook(b),
    };
  });

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
    <div className="min-h-screen bg-[#FBF6EC] text-[#2C2A26]">
      <AutoRefresh active={hasPending} />
      <header className="border-b border-[#EBE3D3] bg-gradient-to-b from-[#FCFAF4] to-white">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <span className="flex items-center gap-2.5 text-xl font-serif">
            <LogoMark size={30} />
            SketchCast <span className="text-[#2E6B4E]">AI</span>
          </span>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-[#6F6A5F]">
              {profile?.full_name || user.email}
              {profile?.role ? ` · ${profile.role}` : ""}
            </span>
            <form action="/auth/signout" method="post">
              <button className="btn-ghost h-9 px-3 text-sm">Sign out</button>
            </form>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">Your library</h1>
        <div className="h-1 w-14 rounded-full bg-[#C77F2A] mb-3" />
        <p className="text-[#6F6A5F] mb-7">
          Upload a textbook, then generate a narrated lesson from it.
        </p>

        <UploadBook schoolId={schoolId} />

        <BrandingCard hasDocx={!!brandingRow?.docx_path} hasPptx={!!brandingRow?.pptx_path} />

        {bookList.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#D9CFB8] bg-white p-10 text-center text-[#6F6A5F]">
            <EmptyBooks />
            No books yet. Upload your first textbook above.
          </div>
        ) : (
          <div className="space-y-8">
            {groups.map((g) => (
              <section key={`${g.grade}-${g.subject}`}>
                <div className="flex items-center gap-2 mb-2.5 px-1">
                  <h2 className="chip font-sans bg-[#EAF1EC] text-[#2E6B4E]">{g.grade}</h2>
                  <span className="text-sm font-medium text-[#6F6A5F]">{g.subject}</span>
                </div>
                <BookTable books={g.books} schoolId={schoolId} classes={classes} />
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
                      <span className="font-serif font-medium truncate">{l.title}</span>
                      <div className="flex items-center gap-3 shrink-0">
                        {l.status === "done" && l.video && (
                          <a href={l.video} target="_blank" className="text-sm font-medium text-[#2E6B4E] hover:underline">
                            ▶ Watch
                          </a>
                        )}
                        {l.status === "done" && l.deck && (
                          <a href={l.deck} className="text-sm font-medium text-[#2E6B4E] hover:underline">
                            ⬇ Deck
                          </a>
                        )}
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
    </div>
  );
}
