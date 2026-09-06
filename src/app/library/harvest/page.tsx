import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { InkUnderline } from "@/components/ink-mark";
import { catalogueMissing } from "@/utils/catalogue/status";
import { groupBooks } from "@/utils/catalogue/books";
import { ErrorBanner, MissingTablesBanner, ReadOnlyNote, fmtDate } from "../catalogue-ui";
import HarvestButton from "./harvest-button";

// /library/harvest — every UNIQUE book on the platform (not taken down), with
// the candidates already harvested from it and its latest topic_harvest job,
// and a Harvest button that enqueues one. Names only ever leave a book: the
// harvester stores chapter and section titles, never page text (plan §1, §6).
//
// Unique by default (founder, 2026-09-06): many teachers upload the same
// textbook, and a name harvested from one copy is the same name from every
// copy. Copies are grouped by content_hash (0070), else title + pages; the row
// shown is the copy most useful to harvest (ready, most harvested, oldest) and
// says how many other copies exist. `?copies=1` lists every copy.

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
  content_hash: string | null;
};

type Job = { id: string; book_id: string | null; status: string; progress: number | null; error: string | null; created_at: string };

const JOB_TONE: Record<string, string> = {
  queued: "bg-[#FFF1D6] text-[#9A6400]",
  processing: "bg-[#EDE7FB] text-[#5B3FBF]",
  done: "bg-[#E6F6F2] text-[#0F7A68]",
  error: "bg-[#FFE9E3] text-[#B3401F]",
};

export default async function HarvestPage({ searchParams }: { searchParams: Promise<{ q?: string; copies?: string }> }) {
  const member = await requireLibraryMember();
  const canCurate = libraryAllows(member.role, "curate");
  const { q, copies } = await searchParams;
  const showCopies = copies === "1";
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
      .select("id, title, owner_id, grade, subject, pages, status, language, created_at, content_hash")
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
  // call, never a per-row lookup. Best effort — a failure shows "—". Editors
  // and admins only: a reviewer reads the shelf, not who uploaded to it, so
  // for them the e-mails are never fetched, shown, or searched.
  const emailOf = new Map<string, string>();
  if (canCurate) {
    try {
      const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      for (const u of data?.users ?? []) if (u.email) emailOf.set(u.id, u.email);
    } catch {
      // profile-only
    }
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
  const matches = (b: Book) =>
    !needle ||
    [b.title ?? "", emailOf.get(b.owner_id) ?? "", b.subject ?? "", b.grade ?? ""].some((v) => v.toLowerCase().includes(needle));

  // Unique books: one row per group, the representative copy; a group matches
  // the search when ANY of its copies does (a teacher's e-mail finds the book
  // even when another copy is shown).
  const groups = groupBooks(allBooks, (id) => candCount.get(id)?.total ?? 0).filter((g) => g.copies.some(matches));
  const copiesOf = new Map<string, number>();
  for (const g of groups) copiesOf.set(g.representative.id, g.copies.length);
  const books = showCopies ? groups.flatMap((g) => g.copies) : groups.map((g) => g.representative);
  const hiddenCopies = groups.reduce((n, g) => n + g.copies.length - 1, 0);

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <Heading />
      <p className="text-[#5B6470] mb-5">
        Pick a book and pull its topic names into Candidates. The harvester reads chapter and section titles from the
        book&apos;s existing structure — names only, never its text. One live harvest per book.
      </p>
      {!canCurate && <ReadOnlyNote what="harvesting" />}

      <form method="get" className="mb-5 flex flex-wrap items-center gap-3">
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder={canCurate ? "Search title, owner, subject…" : "Search title, subject…"}
          className="field w-full sm:w-96 h-10 px-3"
        />
        {showCopies && <input type="hidden" name="copies" value="1" />}
        <span className="text-xs text-[#5B6470]">
          {showCopies ? (
            <>
              Showing every copy.{" "}
              <a className="underline" href={`/library/harvest${needle ? `?q=${encodeURIComponent(q ?? "")}` : ""}`}>
                Unique books only
              </a>
            </>
          ) : hiddenCopies > 0 ? (
            <>
              {hiddenCopies} duplicate {hiddenCopies === 1 ? "copy" : "copies"} hidden.{" "}
              <a className="underline" href={`/library/harvest?copies=1${needle ? `&q=${encodeURIComponent(q ?? "")}` : ""}`}>
                Show all copies
              </a>
            </>
          ) : (
            "Unique books (grouped by content fingerprint, else title and pages)."
          )}
        </span>
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
                      {!showCopies && (copiesOf.get(b.id) ?? 1) > 1 && (
                        <span
                          className="chip font-sans bg-[#EEF0EC] text-[#5B6470] ms-2 align-middle"
                          title="Other teachers uploaded the same book; harvesting one copy covers them all"
                        >
                          +{(copiesOf.get(b.id) ?? 1) - 1} {(copiesOf.get(b.id) ?? 1) === 2 ? "copy" : "copies"}
                        </span>
                      )}
                      <span className="block text-xs text-[#98A0A9]">
                        {b.status}
                        {b.language && ` · ${b.language}`}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-[#5B6470] truncate max-w-56">{(canCurate && emailOf.get(b.owner_id)) || "—"}</td>
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
