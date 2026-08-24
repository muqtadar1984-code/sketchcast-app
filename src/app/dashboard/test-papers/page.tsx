import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AppHeader from "../app-header";
import UploadBook from "../upload-book";
import AutoRefresh from "../auto-refresh";
import { InkUnderline } from "@/components/ink-mark";
import { parentPortalEnabled, teacherBetaEnabled } from "@/utils/flags";
import { enforceHat } from "@/utils/hats-server";
import FairUseMeter from "../fair-use-meter";
import { GeneratePaperButton, AssignChildButton } from "./paper-actions";
import ReportContentIssue from "../report-content-issue";
import BookHealthBadge, { type BookHealth } from "../book-health-badge";
import { type LibraryMessages } from "../content-cell";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { docDownloadName } from "@/utils/download-name";
import { docTypeKey, gateReasons, isGated, isStructureGate } from "@/utils/junk-gate";
import { type JunkGateInfo } from "../junk-gate-dialog";

// The parent's paper-focused view: upload their own book (same pipeline as
// teachers — chapter detection included), generate a test paper per chapter,
// download it, and assign it to a child. Parents are full authors since 0035
// — the Library tab covers every other kind; this view stays paper-first.

export const dynamic = "force-dynamic";

export default async function TestPapersPage() {
  if (!parentPortalEnabled()) redirect("/dashboard");
  // Two Library components are reused verbatim here (the uploader and the book
  // health badge), so this page composes the same `library` message object they
  // expect. The rest of this page's own copy is translated separately.
  const locale = await resolveLocale();
  const dict = await getDictionary(locale);
  const tLib: LibraryMessages = { ...dict.library, common: dict.common, utils: dict.utils };
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
  type LinkRow = { child_id: string; source: string | null; profiles: { full_name: string | null; username: string | null } | null };
  const { data: linksRaw } = await supabase
    .from("parent_links")
    .select("child_id, source, profiles:child_id(full_name, username)");
  const links = (linksRaw ?? []) as unknown as LinkRow[];

  // This paper-first view exists for SCHOOL-provisioned parent portals only
  // (a parent_links row with source='school' — the school created the login,
  // typically reached via the school's own portal URL). Consumer parents —
  // Home Basic and homeschool alike — author from the Library, which now
  // carries per-child assignment too (founder, 2026-08-18). The header hides
  // the tab under the same rule; this covers bookmarks and typed URLs.
  if (!links.some((l) => l.source === "school")) redirect("/dashboard");

  const childrenList = links.map((l) => ({
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

  // Papers AND lessons: since 0059 a paper generates together with its
  // chapter's lesson (documents ride free with the lesson), so the button
  // needs to know whether the lesson already exists.
  const { data: gensRaw } = await supabase
    .from("generations")
    .select("id, kind, book_id, chapter_ref, status, params, artifacts(kind, storage_path), jobs(progress, status)")
    .eq("owner_id", user.id)
    .in("kind", ["exam_paper", "presentation"]);
  type Gen = {
    id: string;
    kind: string;
    book_id: string | null;
    chapter_ref: string | null;
    status: string;
    params: Record<string, unknown> | null;
    artifacts: { kind: string; storage_path: string }[] | null;
    jobs: { progress: number | null; status: string }[] | null;
  };
  const gens = (gensRaw ?? []) as Gen[];
  // Chapter-level rows only (params.part absent) — this view is paper-first.
  const chapterLevel = (g: Gen) => (g.params as { part?: unknown } | null)?.part == null;
  const paperFor = new Map(
    gens.filter((g) => g.kind === "exam_paper" && chapterLevel(g)).map((g) => [`${g.book_id}|${g.chapter_ref}`, g] as const),
  );
  const lessonExists = new Set(
    gens
      .filter((g) => g.kind === "presentation" && g.status !== "error" && chapterLevel(g))
      .map((g) => `${g.book_id}|${g.chapter_ref}`),
  );

  // Owner can sign their own artifact paths directly (storage RLS). This page
  // signs exam-paper documents only — the paper's docx and, once the
  // student/teacher document split (2026-08-18) has run, its separate
  // answer_key_docx — so the download name comes from the artifact kind alone.
  // Without it the browser saves the storage basename (exam_paper.docx).
  const sign = async (path: string | null, artifactKind: "docx" | "answer_key_docx" = "docx") => {
    if (!path) return null;
    const { data } = await supabase.storage
      .from("artifacts")
      .createSignedUrl(path, 3600, { download: docDownloadName("exam_paper", artifactKind) });
    return data?.signedUrl ?? null;
  };

  const anyRunning = gens.some((g) => g.status !== "done" && g.status !== "error") ||
    books.some((b) => b.status === "indexing");

  // Trial gate mirrors the DB (my_trial_pin / my_trial_book_used — parents
  // are pinned exactly like teachers since 0058, and the 0046 ledger keeps a
  // deleted generated-from book's slot consumed). Best-effort: before the
  // migrations run, the RPCs are absent → legacy flag check.
  let betaBlocked = !!profile?.beta_tester && books.length >= 1;
  if (teacherBetaEnabled()) {
    const { data: tp } = await supabase.rpc("my_trial_pin");
    const scope = (Array.isArray(tp) ? tp[0] : tp) as { in_scope?: boolean } | null;
    if (scope) {
      const { data: used } = await supabase.rpc("my_trial_book_used");
      betaBlocked = !!scope.in_scope && ((typeof used === "number" ? used : 0) >= 1 || books.length >= 1);
    }
  }

  // Junk-upload gate: trial accounts get the dialog's stronger "your only
  // trial kit" line. Detected by plan_tier via my_fair_use (0047) — NOT
  // beta_tester, which goes stale on upgrade. Best-effort: a pre-0047 DB just
  // means no extra line. (Same derivation as the Library page.)
  let trialTier = false;
  {
    const { data: fu } = await supabase.rpc("my_fair_use");
    trialTier = (fu as { tier?: string } | null)?.tier === "trial";
  }

  const rows: {
    bookId: string;
    bookTitle: string;
    bookStatus: string;
    health: BookHealth | null;
    chapters: { num: number; title: string; gen: Gen | undefined; doc: string | null; answerKey: string | null; hasLesson: boolean }[];
  }[] = [];
  for (const b of books) {
    const chapters = [];
    for (const c of b.chapters ?? []) {
      const gen = paperFor.get(`${b.id}|${c.num}`);
      const docPath = gen?.artifacts?.find((a) => a.kind === "docx")?.storage_path ?? null;
      // The split answer key (2026-08-18): a parent surface is an adult
      // surface, so the key is offered right beside the paper. Legacy papers
      // (answers embedded in the docx) simply have no such artifact.
      const keyPath = gen?.artifacts?.find((a) => a.kind === "answer_key_docx")?.storage_path ?? null;
      chapters.push({
        num: c.num,
        title: c.title,
        gen,
        doc: await sign(docPath),
        answerKey: await sign(keyPath, "answer_key_docx"),
        hasLesson: lessonExists.has(`${b.id}|${c.num}`),
      });
    }
    rows.push({ bookId: b.id, bookTitle: b.title || "Untitled", bookStatus: b.status, health: b.health ?? null, chapters });
  }

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <AutoRefresh active={anyRunning} />
      <main className="max-w-7xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">Test papers</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-6">
          Upload your child&apos;s textbook, generate a test paper for any chapter, then assign it —
          your child takes it as an interactive quiz or on paper.
        </p>

        {/* Fair-use transparency for parents too (0047). */}
        <FairUseMeter />

        <UploadBook schoolId={(profile?.school_id as string | null) ?? null} t={tLib} betaBlocked={betaBlocked} parent />

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
                    {b.bookStatus === "ready" && <BookHealthBadge health={b.health} t={tLib} />}
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
                      {!c.gen && (
                        <GeneratePaperButton
                          bookId={b.bookId}
                          chapterNum={c.num}
                          hasLesson={c.hasLesson}
                          gate={
                            isGated(b.health)
                              ? ({
                                  docType: docTypeKey(b.health),
                                  structure: isStructureGate(b.health),
                                  reasons: gateReasons(b.health),
                                  trial: trialTier,
                                  t: tLib,
                                } satisfies JunkGateInfo)
                              : null
                          }
                        />
                      )}
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
                          {c.answerKey && (
                            <a href={c.answerKey} className="btn-ghost h-8 px-3 text-xs">
                              {tLib.book.answerKey}
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
