import Link from "next/link";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { InkUnderline } from "@/components/ink-mark";
import {
  TOPIC_STATUSES,
  catalogueMissing,
  clampPage,
  descendantsOf,
  groupNodes,
  hasTopicFilters,
  nodeTree,
  pageCount,
  pageRange,
  parseTopicFilters,
  searchOr,
  withTopicFilter,
} from "@/utils/catalogue/status";
import type { Curriculum, NodeKind, Topic } from "@/utils/catalogue/types";
import { ErrorBanner, MaturityChip, MissingTablesBanner, Pager, StatusChip, fmtDate } from "../catalogue-ui";
import NewTopicForm from "./new-topic-form";

// /library/topics — the canonical topics, filterable (subject, curriculum,
// grade, sub-strand / unit, status, free text), paginated in Postgres. Every
// filter is a GET with a querystring so the server re-queries; the browser
// never holds more than one page (the visual-library stance). A ?page= past
// the end lands on the last page (redirect), never on an empty page or
// PostgREST's 416. The sub-strand filter matches a topic mapped to the group
// OR to any node under it (its objectives) — mappings point at either.

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type FilterNode = { id: string; code: string; title: string; grade: string | null; kind: NodeKind | null; parent_id: string | null };

const TOPIC_COLUMNS =
  "id, canonical_key, title, subject, summary, teacher_avatar, depth_node_id, prerequisites, status, bank_maturity, created_by, created_at, updated_at";

/** PostgREST's "Requested range not satisfiable": the offset is past the end. */
const RANGE_PAST_END = "PGRST103";

export default async function TopicsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const member = await requireLibraryMember();
  const canCurate = libraryAllows(member.role, "curate");
  const f = parseTopicFilters(await searchParams);
  const admin = createAdminClient();
  const href = (page: number) => `/library/topics${withTopicFilter(f, { page })}`;

  // The chosen curriculum's nodes feed two things: the grade and sub-strand /
  // unit selects, and — when a sub-strand is chosen — the ids under it that
  // the mapping filter must accept (a topic may be mapped to the group or to
  // any of its objectives). One query, only when a curriculum is chosen.
  const curriculumNodes: FilterNode[] = f.curriculum
    ? (((await admin.from("curriculum_nodes").select("id, code, title, grade, kind, parent_id").eq("curriculum_id", f.curriculum).order("sort", { ascending: true, nullsFirst: false }).order("code", { ascending: true }).limit(5000)).data ??
        []) as FilterNode[])
    : [];
  const tree = nodeTree(curriculumNodes);
  const nodeById = new Map(curriculumNodes.map((n) => [n.id, n]));
  const pickedNode = f.node && UUID.test(f.node) ? nodeById.get(f.node) ?? null : null;
  const nodeIds = pickedNode ? [pickedNode.id, ...descendantsOf(tree, pickedNode.id)] : [];

  // A curriculum/grade/node filter needs the mappings: an INNER embed restricts
  // the parent rows to topics with at least one mapping onto a matching node,
  // and PostgREST resolves it in one query — the only id list in the URL is a
  // sub-strand's own objectives. The same filters build the count-only query
  // used to find the last page.
  const embed = f.curriculum || f.grade ? ", topic_curriculum_map!inner(node_id, curriculum_nodes!inner(curriculum_id, grade))" : "";
  const search = searchOr(f.q, ["title", "canonical_key", "summary"]);
  const filtered = (head: boolean) => {
    let query = head
      ? admin.from("topics").select("id" + embed, { count: "exact", head: true })
      : admin.from("topics").select(TOPIC_COLUMNS + embed, { count: "exact" }).order("updated_at", { ascending: false });
    if (f.subject) query = query.eq("subject", f.subject);
    if (f.status) query = query.eq("status", f.status);
    if (f.curriculum) query = query.eq("topic_curriculum_map.curriculum_nodes.curriculum_id", f.curriculum);
    if (f.grade) query = query.eq("topic_curriculum_map.curriculum_nodes.grade", f.grade);
    if (nodeIds.length) query = query.in("topic_curriculum_map.node_id", nodeIds);
    if (search) query = query.or(search);
    return query;
  };
  const [from, to] = pageRange(f.page, f.pageSize);
  const { data, error, count } = await filtered(false).range(from, to);

  if (catalogueMissing(error)) {
    return (
      <main className="max-w-7xl mx-auto px-6 py-10">
        <Heading />
        <MissingTablesBanner table="topics" />
      </main>
    );
  }
  if (error?.code === RANGE_PAST_END) {
    // Past the end: count the same filter and land on its last page.
    const { count: total } = await filtered(true);
    const last = clampPage(f.page, pageCount(total ?? 0, f.pageSize));
    if (last !== f.page) redirect(href(last));
  }
  if (error) {
    return (
      <main className="max-w-7xl mx-auto px-6 py-10">
        <Heading />
        <ErrorBanner message={`Could not read the topics: ${error.message}`} />
      </main>
    );
  }

  const rows = (data ?? []) as unknown as Topic[];
  const total = count ?? rows.length;
  const pages = pageCount(total, f.pageSize);
  // PostgREST may also answer an out-of-range offset with 200 and no rows; the
  // count says where the last page is either way.
  if (f.page > pages) redirect(href(pages));

  // Mapping counts for THIS page only (≤ pageSize ids), plus the filter facets.
  const ids = rows.map((r) => r.id);
  const [mapQ, subjQ, currQ] = await Promise.all([
    ids.length
      ? admin.from("topic_curriculum_map").select("topic_id").in("topic_id", ids)
      : Promise.resolve({ data: [] as { topic_id: string }[] }),
    admin.from("topics").select("subject").not("subject", "is", null).limit(2000),
    admin.from("curricula").select("id, code, name, kind, country, edition, source_url").order("name"),
  ]);
  const mappingCount = new Map<string, number>();
  for (const r of (mapQ.data ?? []) as { topic_id: string }[]) {
    mappingCount.set(r.topic_id, (mappingCount.get(r.topic_id) ?? 0) + 1);
  }
  const subjects = [...new Set(((subjQ.data ?? []) as { subject: string | null }[]).map((r) => (r.subject ?? "").trim()).filter(Boolean))].sort();
  const curricula = (currQ.data ?? []) as Curriculum[];
  const grades = [...new Set(curriculumNodes.map((n) => (n.grade ?? "").trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  // Sub-strands / units of the curriculum (kind, else code shape, else "a
  // node whose children are leaves"), narrowed to the grade when one is chosen.
  const groups = groupNodes(curriculumNodes, tree).filter((n) => !f.grade || n.grade === f.grade);
  const isFiltered = hasTopicFilters(f);

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <Heading />
        {canCurate && <NewTopicForm />}
      </div>
      <p className="text-[#5B6470] mb-5">
        One canonical topic per idea, at the deepest depth any mapped curriculum asks for. Aliases carry every name a
        book or syllabus uses for it.
      </p>

      <form method="get" className="card p-4 mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-7 text-sm">
        <input name="q" defaultValue={f.q} placeholder="Search title, key, summary…" className="field h-9 px-3 lg:col-span-2" />
        <select name="subject" defaultValue={f.subject} className="field h-9 px-2">
          <option value="">Any subject</option>
          {subjects.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select name="curriculum" defaultValue={f.curriculum} className="field h-9 px-2">
          <option value="">Any curriculum</option>
          {curricula.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select name="grade" defaultValue={f.grade} className="field h-9 px-2" disabled={!f.curriculum} title={f.curriculum ? "" : "Pick a curriculum first"}>
          <option value="">Any grade</option>
          {grades.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <select
          name="node"
          defaultValue={pickedNode?.id ?? ""}
          className="field h-9 px-2"
          disabled={!f.curriculum || groups.length === 0}
          title={f.curriculum ? "Topics mapped to this sub-strand / unit or to any of its objectives" : "Pick a curriculum first"}
          aria-label="Sub-strand or unit"
        >
          <option value="">Any sub-strand / unit</option>
          {groups.map((n) => (
            <option key={n.id} value={n.id}>
              {n.code} · {n.title}
              {!f.grade && n.grade ? ` (Grade ${n.grade})` : ""}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={f.status} className="field h-9 px-2">
          <option value="">Any status</option>
          {TOPIC_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        {f.pageSize !== 50 && <input type="hidden" name="pageSize" value={f.pageSize} />}
        <div className="flex items-center gap-2 lg:col-span-7">
          <button type="submit" className="btn-primary h-9 px-4">
            Filter
          </button>
          {isFiltered && (
            <Link href="/library/topics" className="btn-ghost h-9 px-3 inline-flex items-center">
              Clear
            </Link>
          )}
          <span className="text-[#5B6470] ml-auto">
            {total.toLocaleString()} topic{total === 1 ? "" : "s"}
            {total > 0 && (
              <>
                {" "}
                · showing {from + 1}–{Math.min(from + rows.length, total)}
              </>
            )}
          </span>
        </div>
      </form>

      {rows.length === 0 ? (
        <div className="card px-6 py-12 text-center text-sm text-[#5B6470]">
          {isFiltered ? (
            <p>No topics match these filters.</p>
          ) : (
            <>
              <p className="mb-2">The catalogue has no topics yet.</p>
              <p>
                Topics arrive three ways: <span className="font-medium">Harvest</span> a book (its chapter and section
                names land in <span className="font-medium">Candidates</span>, where you merge or create),{" "}
                <span className="font-medium">Create topic from node</span> on a curriculum&apos;s uncovered nodes, or{" "}
                <span className="font-medium">New topic</span> here.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-[#5B6470] border-b border-[#EEF0EC]">
              <tr>
                <th className="px-4 py-2.5 font-medium">Title</th>
                <th className="px-4 py-2.5 font-medium">Subject</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Bank</th>
                <th className="px-4 py-2.5 font-medium text-right">Mappings</th>
                <th className="px-4 py-2.5 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EEF0EC]">
              {rows.map((t) => (
                <tr key={t.id} className="hover:bg-[#F8FAF7]">
                  <td className="px-4 py-2.5">
                    <Link href={`/library/topics/${t.id}`} className="font-medium hover:underline">
                      {t.title}
                    </Link>
                    <span className="block text-xs text-[#98A0A9] font-mono">{t.canonical_key}</span>
                  </td>
                  <td className="px-4 py-2.5 text-[#5B6470]">{t.subject ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <StatusChip status={t.status} />
                  </td>
                  <td className="px-4 py-2.5">
                    <MaturityChip maturity={t.bank_maturity} />
                  </td>
                  <td className="px-4 py-2.5 text-right tabular">{mappingCount.get(t.id) ?? 0}</td>
                  <td className="px-4 py-2.5 text-[#5B6470] whitespace-nowrap">{fmtDate(t.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager page={f.page} pages={pages} href={href} />
    </main>
  );
}

function Heading() {
  return (
    <div>
      <h1 className="text-3xl font-display mb-1">Topics</h1>
      <InkUnderline className="block h-3 w-24 mb-3" color="#7FD8A8" />
    </div>
  );
}
