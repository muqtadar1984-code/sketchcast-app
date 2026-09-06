import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { InkUnderline } from "@/components/ink-mark";
import { catalogueMissing } from "@/utils/catalogue/status";
import { ErrorBanner, MissingTablesBanner, ReadOnlyNote, fmtDate } from "../catalogue-ui";
import HarvestButton from "./harvest-button";

// /library/harvest — every book on the platform (not taken down), with the
// candidates already harvested from it and its latest topic_harvest job, and a
// Harvest button that enqueues one. Names only ever leave a book: the harvester
// stores chapter and section titles, never page text (plan §1, §6).

export const dynamic = "force-dynamic";

const BOOK_LIMIT = 300;

type Book = {
  id: string;
  title: string | null;
  owner_id: string;
  grade: string | null;
  subject: string | null;
  pages: number | null;
  status: string;
  language: string | null;
  created_at: string;
};

type Job = { id: string; book_id: string | null; status: string; progress: number | null; error: string | null; created_at: string };

const JOB_TONE: Record<string, string> = {
  queued: "bg-[#FFF1D6] text-[#9A6400]",
  processing: "bg-[#EDE7FB] text-[#5B3FBF]",
  done: "bg-[#E6F6F2] text-[#0F7A68]",
  error: "bg-[#FFE9E3] text-[#B3401F]",
};

export default async function HarvestPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const member = await requireLibraryMember();
  const canCurate = libraryAllows(member.role, "curate");
  const { q } = await searchParams;
  const admin = createAdminClient();

  // The candidates table is the 0112 canary for this page: without it there is
  // nothing to harvest INTO, so explain rather than list books.
  const candQ = await admin.from("topic_candidates").select("book_id, status").eq("source_kind", "book").limit(20000);
  if (catalogueMissing(candQ.error)) {
    return (
      <main className="max-w-7xl mx-auto px-6 py-10">
        <Heading />
        <MissingTablesBanner table="topic_candidates" />
      </main>
    );
  }
  if (candQ.error) {
    return (
      <main className="max-w-7xl mx-auto px-6 py-10">
        <Heading />
        <ErrorBanner message={`Could not read the candidates: ${candQ.error.message}`} />
      </main>
    );
  }

  const [booksQ, jobsQ] = await Promise.all([
    admin
      .from("books")
      .select("id, title, owner_id, grade, subject, pages, status, language, created_at")
      .is("removed_at", null)
      .order("created_at", { ascending: false })
      .limit(BOOK_LIMIT),
    admin
      .from("jobs")
      .select("id, book_id, status, progress, error, created_at")
      .eq("type", "topic_harvest")
      .order("created_at", { ascending: false })
      .limit(2000),
  ]);
  if (booksQ.error) {
    return (
      <main className="max-w-7xl mx-auto px-6 py-10">
        <Heading />
        <ErrorBanner message={`Could not read the books: ${booksQ.error.message}`} />
      </main>
    );
  }
  const allBooks = (booksQ.data ?? []) as Book[];

  // Owner e-mails the way the console Users page gets them: one listUsers
  // call, never a per-row lookup. Best effort — a failure shows "—".
  const emailOf = new Map<string, string>();
  try {
    const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    for (const u of data?.users ?? []) if (u.email) emailOf.set(u.id, u.email);
  } catch {
    // profile-only
  }

  const candCount = new Map<string, { open: number; total: number }>();
  for (const c of (candQ.data ?? []) as { book_id: string | null; status: string }[]) {
    if (!c.book_id) continue;
    const cur = candCount.get(c.book_id) ?? { open: 0, total: 0 };
    cur.total++;
    if (c.status === "open") cur.open++;
    candCount.set(c.book_id, cur);
  }
  const latestJob = new Map<string, Job>();
  for (const j of (jobsQ.data ?? []) as Job[]) {
    if (j.book_id && !latestJob.has(j.book_id)) latestJob.set(j.book_id, j); // newest first
  }

  const needle = (q ?? "").trim().toLowerCase();
  const books = needle
    ? allBooks.filter((b) =>
        [b.title ?? "", emailOf.get(b.owner_id) ?? "", b.subject ?? "", b.grade ?? ""].some((v) => v.toLowerCase().includes(needle)),
      )
    : allBooks;

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <Heading />
      <p className="text-[#5B6470] mb-5">
        Pick a book and pull its topic names into Candidates. The harvester reads chapter and section titles from the
        book&apos;s existing structure — names only, never its text. One live harvest per book.
      </p>
      {!canCurate && <ReadOnlyNote what="harvesting" />}

      <form method="get" className="mb-5">
        <input name="q" defaultValue={q ?? ""} placeholder="Search title, owner, subject…" className="field w-full sm:w-96 h-10 px-3" />
      </form>

      {books.length === 0 ? (
        <div className="card px-6 py-12 text-center text-sm text-[#5B6470]">No books{needle ? " match" : " on the platform yet"}.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-[#5B6470] border-b border-[#EEF0EC]">
              <tr>
                <th className="px-4 py-2.5 font-medium">Book</th>
                <th className="px-4 py-2.5 font-medium">Owner</th>
                <th className="px-4 py-2.5 font-medium">Grade · subject</th>
                <th className="px-4 py-2.5 font-medium text-right">Pages</th>
                <th className="px-4 py-2.5 font-medium">Uploaded</th>
                <th className="px-4 py-2.5 font-medium text-right">Candidates</th>
                <th className="px-4 py-2.5 font-medium">Last harvest</th>
                {canCurate && <th className="px-4 py-2.5" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EEF0EC]">
              {books.map((b) => {
                const job = latestJob.get(b.id);
                const cc = candCount.get(b.id);
                const live = job?.status === "queued" || job?.status === "processing";
                return (
                  <tr key={b.id} className="hover:bg-[#F8FAF7]">
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{b.title || "Untitled"}</span>
                      <span className="block text-xs text-[#98A0A9]">
                        {b.status}
                        {b.language && ` · ${b.language}`}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-[#5B6470] truncate max-w-56">{emailOf.get(b.owner_id) ?? "—"}</td>
                    <td className="px-4 py-2.5 text-[#5B6470]">{[b.grade && `Grade ${b.grade}`, b.subject].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="px-4 py-2.5 text-right tabular">{b.pages ?? "—"}</td>
                    <td className="px-4 py-2.5 text-[#5B6470] whitespace-nowrap">{fmtDate(b.created_at)}</td>
                    <td className="px-4 py-2.5 text-right tabular">
                      {cc ? (
                        <span title={`${cc.open} open of ${cc.total}`}>
                          {cc.total}
                          {cc.open > 0 && <span className="text-xs text-[#9A6400]"> ({cc.open} open)</span>}
                        </span>
                      ) : (
                        <span className="text-[#98A0A9]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {job ? (
                        <span className="inline-flex flex-col gap-0.5">
                          <span>
                            <span className={`chip ${JOB_TONE[job.status] ?? "bg-[#EEF0EC] text-[#5B6470]"}`}>{job.status}</span>
                            {job.status === "processing" && job.progress != null && (
                              <span className="text-xs text-[#5B6470]"> {Math.round(job.progress)}%</span>
                            )}
                          </span>
                          <span className="text-xs text-[#98A0A9]">{fmtDate(job.created_at)}</span>
                          {job.error && <span className="text-xs text-[#B3401F] max-w-xs truncate" title={job.error}>{job.error}</span>}
                        </span>
                      ) : (
                        <span className="text-xs text-[#98A0A9]">never</span>
                      )}
                    </td>
                    {canCurate && (
                      <td className="px-4 py-2.5 text-right">
                        {b.status === "ready" ? (
                          <HarvestButton bookId={b.id} live={live} />
                        ) : (
                          <span className="text-xs text-[#98A0A9]" title="Only a ready (indexed) book can be harvested">
                            {b.status}
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {allBooks.length === BOOK_LIMIT && (
        <p className="text-xs text-[#98A0A9] mt-3">Showing the newest {BOOK_LIMIT} books; search to find an older one.</p>
      )}
    </main>
  );
}

function Heading() {
  return (
    <>
      <h1 className="text-3xl font-display mb-1">Harvest</h1>
      <InkUnderline className="block h-3 w-28 mb-3" color="#7FD8A8" />
    </>
  );
}
