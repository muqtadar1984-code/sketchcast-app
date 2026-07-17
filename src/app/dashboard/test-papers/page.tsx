import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AppHeader from "../app-header";
import UploadBook from "../upload-book";
import AutoRefresh from "../auto-refresh";
import { InkUnderline } from "@/components/ink-mark";
import { parentPortalEnabled } from "@/utils/flags";
import { enforceHat } from "@/utils/hats-server";
import FairUseMeter from "../fair-use-meter";
import { GeneratePaperButton, AssignChildButton } from "./paper-actions";
import ReportContentIssue from "../report-content-issue";
import BookHealthBadge, { type BookHealth } from "../book-health-badge";

// The parent's "library": upload their own book (same pipeline as teachers —
// chapter detection included), generate a TEST PAPER per chapter (the only
// kind the DB allows parents), download it, and assign it to a child. Also
// reachable by teacher-parents, whose full Library covers the same ground.

export const dynamic = "force-dynamic";

export default async function TestPapersPage() {
  if (!parentPortalEnabled()) redirect("/dashboard");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, school_id, beta_tester")
    .eq("id", user.id)
    .maybeSingle();
  const role = (profile?.role as string | null) ?? null;
  if (!role || role === "student") redirect("/dashboard");
  // One-hat mode: Test Papers belongs to the Parent hat.
  const hatAway = await enforceHat(supabase, role, (profile?.school_id as string | null) ?? null, "parent");
  if (hatAway) redirect(hatAway);

  // Children for the assign dropdown (own links only).
  type LinkRow = { child_id: string; profiles: { full_name: string | null; username: string | null } | null };
  const { data: linksRaw } = await supabase
    .from("parent_links")
    .select("child_id, profiles:child_id(full_name, username)");
  const childrenList = ((linksRaw ?? []) as unknown as LinkRow[]).map((l) => ({
    id: l.child_id,
    name: l.profiles?.full_name || l.profiles?.username || "Child",
  }));

  // Own books + own exam papers.
  // `health` (migration 0021) is optional — degrade gracefully if not applied.
  const withHealth = await supabase
    .from("books")
    .select("id, title, status, chapters, health")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: false });
  const booksRes = withHealth.error
    ? await supabase.from("books").select("id, title, status, chapters").eq("owner_id", user.id).order("created_at", { ascending: false })
    : withHealth;
  type Book = { id: string; title: string | null; status: string; chapters: { num: number; title: string }[] | null; health?: BookHealth | null };
  const books = (booksRes.data ?? []) as unknown as Book[];

  const { data: gensRaw } = await supabase
    .from("generations")
    .select("id, book_id, chapter_ref, status, artifacts(kind, storage_path), jobs(progress, status)")
    .eq("owner_id", user.id)
    .eq("kind", "exam_paper");
  type Gen = {
    id: string;
    book_id: string | null;
    chapter_ref: string | null;
    status: string;
    artifacts: { kind: string; storage_path: string }[] | null;
    jobs: { progress: number | null; status: string }[] | null;
  };
  const gens = (gensRaw ?? []) as Gen[];
  const paperFor = new Map(gens.map((g) => [`${g.book_id}|${g.chapter_ref}`, g] as const));

  // Owner can sign their own artifact paths directly (storage RLS).
  const sign = async (path: string | null) => {
    if (!path) return null;
    const { data } = await supabase.storage.from("artifacts").createSignedUrl(path, 3600);
    return data?.signedUrl ?? null;
  };

  const anyRunning = gens.some((g) => g.status !== "done" && g.status !== "error") ||
    books.some((b) => b.status === "indexing");

  // Beta cap message mirrors the teacher library.
  const betaBlocked = !!profile?.beta_tester && books.length >= 1;

  const rows: {
    bookId: string;
    bookTitle: string;
    bookStatus: string;
    health: BookHealth | null;
    chapters: { num: number; title: string; gen: Gen | undefined; doc: string | null }[];
  }[] = [];
  for (const b of books) {
    const chapters = [];
    for (const c of b.chapters ?? []) {
      const gen = paperFor.get(`${b.id}|${c.num}`);
      const docPath = gen?.artifacts?.find((a) => a.kind === "docx")?.storage_path ?? null;
      chapters.push({ num: c.num, title: c.title, gen, doc: await sign(docPath) });
    }
    rows.push({ bookId: b.id, bookTitle: b.title || "Untitled", bookStatus: b.status, health: b.health ?? null, chapters });
  }

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <AutoRefresh active={anyRunning} />
      <main className="max-w-4xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">Test papers</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-6">
          Upload your child&apos;s textbook, generate a test paper for any chapter, then assign it —
          your child takes it as an interactive quiz or on paper.
        </p>

        {/* Fair-use transparency for parents too (0047). */}
        <FairUseMeter />

        <UploadBook schoolId={(profile?.school_id as string | null) ?? null} betaBlocked={betaBlocked} />

        {books.length === 0 ? (
          <div className="card px-5 py-8 text-sm text-[#5B6470]">
            No book yet — upload a PDF above. Chapters are detected automatically, scanned books included.
          </div>
        ) : (
          <div className="space-y-5">
            {rows.map((b) => (
              <div key={b.bookId} className="card divide-y divide-[#EEF0EC]">
                <div className="px-5 py-3 flex items-center justify-between">
                  <span className="font-medium font-display text-lg">{b.bookTitle}</span>
                  <span className="flex items-center gap-2">
                    {b.bookStatus === "ready" && <BookHealthBadge health={b.health} />}
                    {b.bookStatus !== "ready" && (
                      <span className="chip font-sans bg-[#FFF1D6] text-[#9A6400]">{b.bookStatus}…</span>
                    )}
                  </span>
                </div>
                {b.chapters.map((c) => (
                  <div key={c.num} className="px-5 py-2.5 flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate">
                      {c.num + 1}. {c.title}
                    </span>
                    <span className="flex items-center gap-2 shrink-0">
                      {!c.gen && <GeneratePaperButton bookId={b.bookId} chapterNum={c.num} />}
                      {c.gen && c.gen.status === "error" && (
                        <span className="chip font-sans bg-[#FFE9E3] text-[#B3401F]">failed</span>
                      )}
                      {c.gen && c.gen.status !== "done" && c.gen.status !== "error" && (
                        <span className="chip font-sans bg-[#FFF1D6] text-[#9A6400]">
                          generating {(c.gen.jobs?.[0]?.progress ?? 0)}%
                        </span>
                      )}
                      {c.gen && c.gen.status === "done" && (
                        <>
                          {c.doc && (
                            <a href={c.doc} className="btn-ghost h-8 px-3 text-xs">
                              Download
                            </a>
                          )}
                          <AssignChildButton generationId={c.gen.id} childrenList={childrenList} />
                          <ReportContentIssue generationId={c.gen.id} />
                        </>
                      )}
                    </span>
                  </div>
                ))}
                {b.chapters.length === 0 && (
                  <p className="px-5 py-3 text-sm text-[#98A0A9]">Chapters appear here once indexing finishes.</p>
                )}
              </div>
            ))}
          </div>
        )}

        {childrenList.length === 0 && books.length > 0 && (
          <p className="text-sm text-[#9A6400] bg-[#FFF9EE] rounded-lg px-4 py-2.5 mt-5">
            Add your child on the My Children page to be able to assign papers.
          </p>
        )}
      </main>
    </div>
  );
}
