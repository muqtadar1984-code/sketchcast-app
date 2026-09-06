import Link from "next/link";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { InkUnderline } from "@/components/ink-mark";
import { CATALOGUE_LAYER_MIGRATION, catalogueColumnMissing, catalogueMissing, nodeKind } from "@/utils/catalogue/status";
import type { NodeKind, TopicHit } from "@/utils/catalogue/types";
import { ErrorBanner, KindChip, MissingTablesBanner, ReadOnlyNote, StatusChip, fmtDate } from "../catalogue-ui";
import CandidateActions from "./candidate-actions";
import BulkCreate from "./bulk-create";

// /library/candidates — the unmapped queue: topic names harvested from books
// (chapter and section titles) and proposed for syllabi (topic_derive: one
// topic per GROUP of objectives, with the model's rationale), waiting to be
// merged into a topic, created as one, or dismissed. Book candidates are
// grouped by book; curriculum candidates by curriculum, then grade, each
// showing its anchor (the sub-strand / unit) and the objective codes it maps.

export const dynamic = "force-dynamic";

const LIMIT = 500;
/** ids per `.in()` — a uuid is 36 chars and the list travels in the URL. */
const IN_CHUNK = 150;

type AnchorNode = {
  id: string;
  code: string;
  title: string;
  grade: string | null;
  strand: string | null;
  sub_strand: string | null;
  kind: NodeKind | null;
  parent_id: string | null;
  curricula: { id: string; name: string } | { id: string; name: string }[] | null;
};

type Row = {
  id: string;
  source_kind: "book" | "curriculum";
  book_id: string | null;
  node_id: string | null;
  node_ids: string[] | null;
  rationale: string | null;
  raw_title: string;
  normalized: string;
  suggested_topic_id: string | null;
  created_at: string;
  suggested: TopicHit | TopicHit[] | null;
  curriculum_nodes: AnchorNode | null;
};

type ObjectiveRef = { id: string; code: string; title: string };

export default async function CandidatesPage() {
  const member = await requireLibraryMember();
  const canCurate = libraryAllows(member.role, "curate");
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("topic_candidates")
    .select(
      "id, source_kind, book_id, node_id, node_ids, rationale, raw_title, normalized, suggested_topic_id, created_at, " +
        "suggested:topics(id, title, subject, status, canonical_key), " +
        "curriculum_nodes(id, code, title, grade, strand, sub_strand, kind, parent_id, curricula(id, name))",
    )
    .eq("status", "open")
    .order("created_at", { ascending: true })
    .limit(LIMIT);

  if (catalogueColumnMissing(error)) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-10">
        <Heading />
        <MissingTablesBanner table="topic_candidates.node_ids" migration={CATALOGUE_LAYER_MIGRATION} />
      </main>
    );
  }
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

  // The objectives every grouped candidate names (node_ids), fetched once in
  // chunks; a missing one (deleted since the derive) is shown by id.
  const objectiveIds = [...new Set(rows.flatMap((r) => r.node_ids ?? []))];
  const bookIds = [...new Set(rows.map((r) => r.book_id).filter((b): b is string => !!b))];
  const chunks: string[][] = [];
  for (let i = 0; i < objectiveIds.length; i += IN_CHUNK) chunks.push(objectiveIds.slice(i, i + IN_CHUNK));
  const [booksQ, resolvedQ, ...objectiveQs] = await Promise.all([
    bookIds.length
      ? admin.from("books").select("id, title, grade, subject").in("id", bookIds)
      : Promise.resolve({ data: [] as { id: string; title: string | null; grade: string | null; subject: string | null }[] }),
    admin.from("topic_candidates").select("id", { count: "exact", head: true }).neq("status", "open"),
    ...chunks.map((ids) => admin.from("curriculum_nodes").select("id, code, title").in("id", ids)),
  ]);
  const books = new Map(((booksQ.data ?? []) as { id: string; title: string | null; grade: string | null; subject: string | null }[]).map((b) => [b.id, b]));
  const resolved = resolvedQ.count ?? 0;
  const objectives = new Map<string, ObjectiveRef>();
  for (const q of objectiveQs) for (const o of (q.data ?? []) as ObjectiveRef[]) objectives.set(o.id, o);

  // Buckets: one per book; one per curriculum, sub-grouped by grade.
  type Group = { key: string; label: string; rows: Row[] };
  type Bucket = { key: string; id: string | null; kind: "book" | "curriculum"; label: string; sub: string; groups: Map<string, Group>; unmatched: number };
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    let key: string;
    let id: string | null;
    let label: string;
    let sub: string;
    let groupKey = "";
    let groupLabel = "";
    if (r.source_kind === "book") {
      const b = r.book_id ? books.get(r.book_id) : undefined;
      key = `book:${r.book_id ?? "?"}`;
      id = r.book_id;
      label = b?.title || "Untitled book";
      sub = [b?.subject, b?.grade && `Grade ${b.grade}`, "book"].filter(Boolean).join(" · ");
    } else {
      const cn = r.curriculum_nodes;
      const cur = cn?.curricula ? (Array.isArray(cn.curricula) ? cn.curricula[0] : cn.curricula) : null;
      key = `curriculum:${cur?.id ?? "?"}`;
      id = cur?.id ?? null;
      label = cur?.name ?? "Curriculum";
      sub = "derived from the syllabus";
      groupKey = cn?.grade ?? "";
      groupLabel = cn?.grade ? `Grade ${cn.grade}` : "No grade";
    }
    const bucket = buckets.get(key) ?? { key, id, kind: r.source_kind, label, sub, groups: new Map<string, Group>(), unmatched: 0 };
    const group = bucket.groups.get(groupKey) ?? { key: groupKey, label: groupLabel, rows: [] };
    group.rows.push(r);
    bucket.groups.set(groupKey, group);
    if (!r.suggested_topic_id) bucket.unmatched++;
    buckets.set(key, bucket);
  }
  const sortedBuckets = [...buckets.values()].sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === "curriculum" ? -1 : 1));
  const gradeOrder = (a: Group, b: Group) => a.key.localeCompare(b.key, undefined, { numeric: true });

  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <Heading />
        <p className="text-sm text-[#5B6470] mt-2">
          {rows.length.toLocaleString()} open{rows.length === LIMIT ? "+" : ""} · {resolved.toLocaleString()} resolved
        </p>
      </div>
      <p className="text-[#5B6470] mb-5">
        Names the harvester pulled from books, and topics the model proposed for a syllabus&apos; objectives. Merge each
        into the topic it means, create a topic when none exists, or dismiss the noise. A{" "}
        <span className="font-medium">suggested</span> topic is an alias match by key. Creating or merging a syllabus
        candidate maps <span className="font-medium">every objective it lists</span> to the topic.
      </p>
      {!canCurate && <ReadOnlyNote what="resolving candidates" />}

      {rows.length === 0 ? (
        <div className="card px-6 py-12 text-center text-sm text-[#5B6470]">
          <p className="mb-2">The queue is empty.</p>
          <p>
            <Link href="/library/harvest" className="underline">
              Harvest a book
            </Link>{" "}
            to fill it, or{" "}
            <Link href="/library/curricula" className="underline">
              derive topics
            </Link>{" "}
            for a curriculum.
          </p>
        </div>
      ) : (
        sortedBuckets.map((b) => (
          <section key={b.key} id={b.kind === "curriculum" && b.id ? `curriculum-${b.id}` : undefined} className="card mb-5 scroll-mt-20">
            <header className="px-5 py-3 border-b border-[#EEF0EC] flex flex-wrap items-center justify-between gap-3">
              <span>
                <span className="font-medium">{b.label}</span>
                <span className="text-xs text-[#5B6470]"> · {b.sub}</span>
              </span>
              <span className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-[#5B6470] tabular">
                  {[...b.groups.values()].reduce((n, g) => n + g.rows.length, 0)} open
                  {b.kind === "curriculum" && <> · {b.unmatched} unmatched</>}
                </span>
                {canCurate && b.kind === "curriculum" && b.id && <BulkCreate curriculumId={b.id} count={b.unmatched} name={b.label} />}
              </span>
            </header>
            {[...b.groups.values()].sort(gradeOrder).map((g) => (
              <div key={g.key || "none"}>
                {g.label && (
                  <p className="px-5 pt-3 pb-1 text-xs uppercase tracking-wide text-[#98A0A9]">
                    {g.label} <span className="normal-case tracking-normal">· {g.rows.length}</span>
                  </p>
                )}
                <ul className="divide-y divide-[#EEF0EC]">
                  {g.rows.map((r) => (
                    <CandidateRow key={r.id} row={r} objectives={objectives} canCurate={canCurate} />
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))
      )}
    </main>
  );
}

function CandidateRow({ row: r, objectives, canCurate }: { row: Row; objectives: ReadonlyMap<string, ObjectiveRef>; canCurate: boolean }) {
  const suggested = Array.isArray(r.suggested) ? r.suggested[0] ?? null : r.suggested;
  const cn = r.curriculum_nodes;
  const kind = cn ? nodeKind(cn) : null;
  const ids = r.node_ids ?? [];
  const grouped = ids.length > 0;
  return (
    <li className="px-5 py-3 flex flex-wrap items-start justify-between gap-3 text-sm">
      <span className="min-w-0 flex-1">
        <span className="font-medium">{r.raw_title}</span>
        <span className="block text-xs text-[#98A0A9] font-mono">{r.normalized}</span>
        {r.rationale && <span className="block text-xs text-[#5B6470] italic mt-0.5">{r.rationale}</span>}
        {cn && (
          <span className="block text-xs text-[#5B6470] mt-1">
            {grouped ? "anchor" : "node"}{" "}
            {cn.grade && <>Grade {cn.grade} · </>}
            <span className="font-mono text-[#1F5B99]">{cn.code}</span> {cn.title} <KindChip kind={kind} inferred={!cn.kind && kind !== null} />
          </span>
        )}
        {grouped && (
          <span className="flex flex-wrap items-center gap-1 mt-1" title="The objectives this candidate maps when created or merged">
            <span className="text-xs text-[#5B6470]">maps {ids.length}:</span>
            {ids.map((id) => {
              const o = objectives.get(id);
              return (
                <span key={id} className="chip bg-[#E6F1FB] text-[#1F5B99] font-mono" title={o ? o.title : "objective no longer exists"}>
                  {o ? o.code : `${id.slice(0, 8)}…`}
                </span>
              );
            })}
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
}

function Heading() {
  return (
    <div>
      <h1 className="text-3xl font-display mb-1">Candidates</h1>
      <InkUnderline className="block h-3 w-32 mb-3" color="#7FD8A8" />
    </div>
  );
}
