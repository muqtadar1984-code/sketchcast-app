import Link from "next/link";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { InkUnderline } from "@/components/ink-mark";
import { catalogueMissing } from "@/utils/catalogue/status";
import type { TopicHit } from "@/utils/catalogue/types";
import { ErrorBanner, MissingTablesBanner, ReadOnlyNote, StatusChip, fmtDate } from "../catalogue-ui";
import CandidateActions from "./candidate-actions";

// /library/candidates — the unmapped queue: topic names harvested from books
// (chapter and section titles) and from syllabi, waiting to be merged into a
// topic, created as one, or dismissed. Grouped by where they came from.

export const dynamic = "force-dynamic";

const LIMIT = 500;

type Row = {
  id: string;
  source_kind: "book" | "curriculum";
  book_id: string | null;
  node_id: string | null;
  raw_title: string;
  normalized: string;
  suggested_topic_id: string | null;
  created_at: string;
  suggested: TopicHit | TopicHit[] | null;
  curriculum_nodes:
    | { id: string; code: string; title: string; grade: string | null; curricula: { id: string; name: string } | { id: string; name: string }[] | null }
    | null;
};

export default async function CandidatesPage() {
  const member = await requireLibraryMember();
  const canCurate = libraryAllows(member.role, "curate");
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("topic_candidates")
    .select(
      "id, source_kind, book_id, node_id, raw_title, normalized, suggested_topic_id, created_at, " +
        "suggested:topics(id, title, subject, status, canonical_key), " +
        "curriculum_nodes(id, code, title, grade, curricula(id, name))",
    )
    .eq("status", "open")
    .order("created_at", { ascending: true })
    .limit(LIMIT);

  if (catalogueMissing(error)) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-10">
        <Heading />
        <MissingTablesBanner table="topic_candidates" />
      </main>
    );
  }
  if (error) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-10">
        <Heading />
        <ErrorBanner message={`Could not read the candidates: ${error.message}`} />
      </main>
    );
  }
  const rows = (data ?? []) as unknown as Row[];

  const bookIds = [...new Set(rows.map((r) => r.book_id).filter((b): b is string => !!b))];
  const [booksQ, resolvedQ] = await Promise.all([
    bookIds.length
      ? admin.from("books").select("id, title, grade, subject").in("id", bookIds)
      : Promise.resolve({ data: [] as { id: string; title: string | null; grade: string | null; subject: string | null }[] }),
    admin.from("topic_candidates").select("id", { count: "exact", head: true }).neq("status", "open"),
  ]);
  const books = new Map(((booksQ.data ?? []) as { id: string; title: string | null; grade: string | null; subject: string | null }[]).map((b) => [b.id, b]));
  const resolved = resolvedQ.count ?? 0;

  // Group: one bucket per book, one per curriculum.
  type Bucket = { key: string; label: string; sub: string; rows: Row[] };
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    let key: string;
    let label: string;
    let sub: string;
    if (r.source_kind === "book") {
      const b = r.book_id ? books.get(r.book_id) : undefined;
      key = `book:${r.book_id ?? "?"}`;
      label = b?.title || "Untitled book";
      sub = [b?.subject, b?.grade && `Grade ${b.grade}`, "book"].filter(Boolean).join(" · ");
    } else {
      const cn = r.curriculum_nodes;
      const cur = cn?.curricula ? (Array.isArray(cn.curricula) ? cn.curricula[0] : cn.curricula) : null;
      key = `curriculum:${cur?.id ?? "?"}`;
      label = cur?.name ?? "Curriculum";
      sub = "syllabus nodes";
    }
    const bucket = buckets.get(key) ?? { key, label, sub, rows: [] };
    bucket.rows.push(r);
    buckets.set(key, bucket);
  }

  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <Heading />
        <p className="text-sm text-[#5B6470] mt-2">
          {rows.length.toLocaleString()} open{rows.length === LIMIT ? "+" : ""} · {resolved.toLocaleString()} resolved
        </p>
      </div>
      <p className="text-[#5B6470] mb-5">
        Names the harvester pulled from books and syllabi. Merge each into the topic it means, create a topic when none
        exists, or dismiss the noise. A <span className="font-medium">suggested</span> topic is an alias match by key.
      </p>
      {!canCurate && <ReadOnlyNote what="resolving candidates" />}

      {rows.length === 0 ? (
        <div className="card px-6 py-12 text-center text-sm text-[#5B6470]">
          <p className="mb-2">The queue is empty.</p>
          <p>
            <Link href="/library/harvest" className="underline">
              Harvest a book
            </Link>{" "}
            to fill it, or seed a curriculum.
          </p>
        </div>
      ) : (
        [...buckets.values()].map((b) => (
          <section key={b.key} className="card mb-5">
            <header className="px-5 py-3 border-b border-[#EEF0EC] flex flex-wrap items-center justify-between gap-3">
              <span>
                <span className="font-medium">{b.label}</span>
                <span className="text-xs text-[#5B6470]"> · {b.sub}</span>
              </span>
              <span className="text-xs text-[#5B6470]">{b.rows.length} open</span>
            </header>
            <ul className="divide-y divide-[#EEF0EC]">
              {b.rows.map((r) => {
                const suggested = Array.isArray(r.suggested) ? r.suggested[0] ?? null : r.suggested;
                const cn = r.curriculum_nodes;
                return (
                  <li key={r.id} className="px-5 py-3 flex flex-wrap items-start justify-between gap-3 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{r.raw_title}</span>
                      <span className="block text-xs text-[#98A0A9] font-mono">{r.normalized}</span>
                      {cn && (
                        <span className="block text-xs text-[#5B6470]">
                          node <span className="font-mono text-[#1F5B99]">{cn.code}</span> {cn.title}
                          {cn.grade && ` · Grade ${cn.grade}`}
                        </span>
                      )}
                      <span className="block text-xs text-[#5B6470] mt-1">
                        {suggested ? (
                          <>
                            Suggested:{" "}
                            <Link href={`/library/topics/${suggested.id}`} className="font-medium hover:underline">
                              {suggested.title}
                            </Link>{" "}
                            <StatusChip status={suggested.status} />
                          </>
                        ) : (
                          <span className="text-[#98A0A9]">No alias match — create, or pick a topic.</span>
                        )}
                        <span className="text-[#98A0A9]"> · {fmtDate(r.created_at)}</span>
                      </span>
                    </span>
                    {canCurate && <CandidateActions candidateId={r.id} suggested={suggested} />}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}

function Heading() {
  return (
    <div>
      <h1 className="text-3xl font-display mb-1">Candidates</h1>
      <InkUnderline className="block h-3 w-32 mb-3" color="#7FD8A8" />
    </div>
  );
}
