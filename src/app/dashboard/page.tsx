import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import UploadBook from "./upload-book";
import GenerateButton from "./generate-button";
import GenerateAllButton from "./generate-all-button";
import AutoRefresh from "./auto-refresh";
import DeleteBook from "./delete-book";
import DeleteLesson from "./delete-lesson";

type Chapter = { num: number; title: string };

type Book = {
  id: string;
  title: string;
  author: string | null;
  storage_path: string | null;
  status: string | null;
  chapters: Chapter[] | null;
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

  const { data: books } = await supabase
    .from("books")
    .select("id, title, author, storage_path, status, chapters, created_at")
    .order("created_at", { ascending: false });
  const bookList = (books ?? []) as Book[];

  const { data: gensRaw } = await supabase
    .from("generations")
    .select(
      "id, title, status, created_at, chapter_ref, book_id, artifacts(kind, storage_path), jobs(progress, status)",
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
        bookId: (g.book_id as string | null) ?? null,
        chapterRef: (g.chapter_ref as string | null) ?? null,
        deck: arts.find((a) => a.kind === "deck_pptx")?.url ?? null,
        video: arts.find((a) => a.kind === "video_mp4")?.url ?? null,
        artifactPaths: (g.artifacts ?? []).map((a: any) => a.storage_path as string),
      };
    }),
  );
  type Lesson = (typeof lessons)[number];

  // Latest lesson for a given book + chapter number (gensRaw is newest-first).
  const lessonForChapter = (bookId: string, num: number): Lesson | undefined =>
    lessons.find((l) => l.bookId === bookId && l.chapterRef === String(num));
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

  return (
    <div className="min-h-screen bg-[#FBF6EC] text-[#2C2A26]">
      <AutoRefresh active={hasPending} />
      <header className="border-b border-[#EBE3D3] bg-white">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <span className="text-xl font-medium" style={{ fontFamily: "Georgia, serif" }}>
            SketchCast <span className="text-[#2E6B4E]">AI</span>
          </span>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-[#6F6A5F]">
              {profile?.full_name || user.email}
              {profile?.role ? ` · ${profile.role}` : ""}
            </span>
            <form action="/auth/signout" method="post">
              <button className="h-9 px-3 rounded-lg border border-[#EBE3D3] text-[#2C2A26] hover:bg-[#FBF8F1]">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10">
        <h1 className="text-3xl font-medium mb-1" style={{ fontFamily: "Georgia, serif" }}>
          Your library
        </h1>
        <p className="text-[#6F6A5F] mb-6">
          Upload a textbook, then generate a narrated lesson from it.
        </p>

        <UploadBook schoolId={schoolId} />

        {bookList.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#D9CFB8] bg-white p-10 text-center text-[#6F6A5F]">
            No books yet. Upload your first textbook above.
          </div>
        ) : (
          <div className="space-y-5">
            {bookList.map((b) => {
              const chapters = b.chapters ?? [];
              const pendingChapters = chapters.filter((c) => !lessonForChapter(b.id, c.num));
              const others = otherLessonsForBook(b);
              return (
                <div key={b.id} className="bg-white rounded-xl border border-[#EBE3D3] p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-[#2E6B4E] bg-[#EAF1EC] px-2 py-0.5 rounded-full shrink-0">
                          PDF
                        </span>
                        <h3 className="font-medium truncate" style={{ fontFamily: "Georgia, serif" }}>
                          {b.title}
                        </h3>
                      </div>
                      <p className="text-sm text-[#6F6A5F] mt-0.5">{b.author || "Unknown author"}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {b.status === "ready" && chapters.length > 0 && (
                        <GenerateAllButton bookId={b.id} schoolId={schoolId} chapters={pendingChapters} />
                      )}
                      <span className="text-xs text-[#6F6A5F]">
                        {new Date(b.created_at).toLocaleDateString()}
                      </span>
                      <DeleteBook bookId={b.id} storagePath={b.storage_path} />
                    </div>
                  </div>

                  {b.status === "indexing" ? (
                    <p className="mt-4 inline-block text-sm text-[#854F0B] bg-[#FAEEDA] rounded-lg px-3 py-1.5">
                      Finding chapters…
                    </p>
                  ) : b.status === "error" ? (
                    <div className="mt-4 flex items-center gap-3">
                      <span className="text-sm text-[#A32D2D]">Couldn&apos;t detect chapters.</span>
                      <GenerateButton bookId={b.id} schoolId={schoolId} label="Generate full book" />
                    </div>
                  ) : chapters.length > 0 ? (
                    <ul className="mt-3 border-t border-[#F1ECE0] divide-y divide-[#F1ECE0]">
                      {chapters.map((c) => {
                        const l = lessonForChapter(b.id, c.num);
                        return (
                          <li key={c.num} className="flex items-center justify-between gap-4 py-2.5">
                            <span className="text-sm text-[#2C2A26] flex-1 min-w-0 truncate">
                              <span className="text-[#9A958A]">{c.num + 1}.</span> {c.title}
                            </span>
                            <div className="flex items-center gap-2 shrink-0">
                              {!l && (
                                <GenerateButton bookId={b.id} schoolId={schoolId} chapterRef={c.num} label="Generate" />
                              )}
                              {l && l.status === "done" && (
                                <>
                                  {l.video && (
                                    <a href={l.video} target="_blank" className="text-xs font-medium text-[#2E6B4E] hover:underline">
                                      ▶ Watch
                                    </a>
                                  )}
                                  {l.deck && (
                                    <a href={l.deck} className="text-xs font-medium text-[#2E6B4E] hover:underline">
                                      ⬇ Deck
                                    </a>
                                  )}
                                  <DeleteLesson genId={l.id} artifactPaths={l.artifactPaths} />
                                </>
                              )}
                              {l && (l.status === "queued" || l.status === "processing") && (
                                <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[l.status] ?? ""}`}>
                                  {l.status}
                                  {l.status === "processing" ? ` · ${l.progress}%` : ""}
                                </span>
                              )}
                              {l && l.status === "error" && (
                                <>
                                  <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE.error}`}>error</span>
                                  <GenerateButton bookId={b.id} schoolId={schoolId} chapterRef={c.num} label="Retry" />
                                </>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <div className="mt-4">
                      <GenerateButton bookId={b.id} schoolId={schoolId} label="Generate lesson" />
                    </div>
                  )}

                  {others.length > 0 && (
                    <div className="mt-4 pt-3 border-t border-[#F1ECE0]">
                      <p className="text-xs text-[#6F6A5F] mb-2">Other lessons</p>
                      <ul className="space-y-2">
                        {others.map((l) => (
                          <li key={l.id} className="flex items-center justify-between gap-4">
                            <span className="text-sm text-[#2C2A26] flex-1 min-w-0 truncate">{l.title}</span>
                            <div className="flex items-center gap-2 shrink-0">
                              {l.status === "done" ? (
                                <>
                                  {l.video && (
                                    <a href={l.video} target="_blank" className="text-xs font-medium text-[#2E6B4E] hover:underline">
                                      ▶ Watch
                                    </a>
                                  )}
                                  {l.deck && (
                                    <a href={l.deck} className="text-xs font-medium text-[#2E6B4E] hover:underline">
                                      ⬇ Deck
                                    </a>
                                  )}
                                </>
                              ) : (
                                <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[l.status] ?? ""}`}>
                                  {l.status}
                                  {l.status === "processing" ? ` · ${l.progress}%` : ""}
                                </span>
                              )}
                              <DeleteLesson genId={l.id} artifactPaths={l.artifactPaths} />
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {lessons.filter((l) => l.bookId === null).length > 0 && (
          <>
            <h2 className="text-2xl font-medium mt-12 mb-4" style={{ fontFamily: "Georgia, serif" }}>
              Other lessons
            </h2>
            <div className="space-y-3">
              {lessons
                .filter((l) => l.bookId === null)
                .map((l) => (
                  <div key={l.id} className="bg-white rounded-xl border border-[#EBE3D3] p-5">
                    <div className="flex items-center justify-between gap-4">
                      <span className="font-medium truncate" style={{ fontFamily: "Georgia, serif" }}>
                        {l.title}
                      </span>
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
