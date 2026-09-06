import Link from "next/link";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { InkUnderline } from "@/components/ink-mark";
import {
  CATALOGUE_LAYER_MIGRATION,
  catalogueColumnMissing,
  catalogueMissing,
  childrenOf,
  coverageOf,
  coveredSet,
  isGroupKind,
  isLiveJobStatus,
  leafDescendants,
  mappableChildren,
  nodeKind,
  nodeTree,
  objectiveCoverage,
  type NodeTree,
} from "@/utils/catalogue/status";
import type { Curriculum, CurriculumNode } from "@/utils/catalogue/types";
import { CoverageBar, CoverageChip, ErrorBanner, JobSummary, KindChip, MissingTablesBanner, ObjectiveCount, StatusChip } from "../catalogue-ui";
import CreateFromNode from "./create-from-node";
import DeriveButton from "./derive-button";

// /library/curricula — every curriculum with its coverage, the latest
// topic_derive job and its open derived candidates; ?curriculum=<id> opens one
// as a TREE: grade → strand (collapsible) → sub-strand / unit → objectives,
// grouped by each node's KIND (the 0113 column, else the code's shape — never
// by depth), each group with "n/m objectives mapped", each node with the
// topics that cover it, and "Create topic from node" on the gaps — which, on a
// group, maps its ticked objectives. Coverage gaps drive what to author next
// (plan §7.2); Derive asks the model to propose the groupings (plan Phase 2a).

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MappingHit = {
  node_id: string;
  coverage: "full" | "partial";
  topic_id: string;
  topics: { id: string; title: string; status: string } | { id: string; title: string; status: string }[] | null;
};

type DeriveJob = {
  id: string;
  status: string;
  progress: number | null;
  stage: unknown;
  error: string | null;
  created_at: string;
  params: { curriculum_id?: string } | null;
};

export default async function CurriculaPage({
  searchParams,
}: {
  searchParams: Promise<{ curriculum?: string }>;
}) {
  const member = await requireLibraryMember();
  const canCurate = libraryAllows(member.role, "curate");
  const sp = await searchParams;
  const selected = sp.curriculum && UUID.test(sp.curriculum) ? sp.curriculum : "";
  const admin = createAdminClient();

  const { data: currRows, error: cErr } = await admin
    .from("curricula")
    .select("id, code, name, kind, country, edition, source_url")
    .order("name");
  if (catalogueMissing(cErr)) {
    return (
      <main className="max-w-7xl mx-auto px-6 py-10">
        <Heading />
        <MissingTablesBanner table="curricula" />
      </main>
    );
  }
  if (cErr) {
    return (
      <main className="max-w-7xl mx-auto px-6 py-10">
        <Heading />
        <ErrorBanner message={`Could not read the curricula: ${cErr.message}`} />
      </main>
    );
  }
  const curricula = (currRows ?? []) as Curriculum[];

  // Per-curriculum coverage for the list (leaf nodes — the objectives — over
  // the curriculum's tree), the latest derive job per curriculum (jobs.params
  // carries the id — 0113), and the open derived candidates per curriculum
  // (through the anchor node's curriculum). No id lists in any URL.
  const [nodesAllQ, mappedAllQ, jobsQ, candQ] = await Promise.all([
    admin.from("curriculum_nodes").select("id, curriculum_id, parent_id").limit(20000),
    admin.from("topic_curriculum_map").select("node_id, curriculum_nodes!inner(curriculum_id)").limit(50000),
    admin
      .from("jobs")
      .select("id, status, progress, stage, error, created_at, params")
      .eq("type", "topic_derive")
      .order("created_at", { ascending: false })
      .limit(500),
    admin
      .from("topic_candidates")
      .select("node_id, curriculum_nodes!inner(curriculum_id)")
      .eq("status", "open")
      .eq("source_kind", "curriculum")
      .limit(20000),
  ]);
  // jobs.params is a 0113 column: without it the derive column of the list is
  // explained, not crashed, and the Derive buttons stay off.
  const layerMissing = catalogueColumnMissing(jobsQ.error);

  const nodesByCurriculum = new Map<string, { id: string; parent_id: string | null }[]>();
  for (const n of (nodesAllQ.data ?? []) as { id: string; curriculum_id: string; parent_id: string | null }[]) {
    const list = nodesByCurriculum.get(n.curriculum_id) ?? [];
    list.push({ id: n.id, parent_id: n.parent_id });
    nodesByCurriculum.set(n.curriculum_id, list);
  }
  const mappedByCurriculum = new Map<string, { node_id: string }[]>();
  for (const m of (mappedAllQ.data ?? []) as unknown as { node_id: string; curriculum_nodes: { curriculum_id: string } | { curriculum_id: string }[] | null }[]) {
    const cn = Array.isArray(m.curriculum_nodes) ? m.curriculum_nodes[0] : m.curriculum_nodes;
    if (!cn) continue;
    const list = mappedByCurriculum.get(cn.curriculum_id) ?? [];
    list.push({ node_id: m.node_id });
    mappedByCurriculum.set(cn.curriculum_id, list);
  }
  const latestDerive = new Map<string, DeriveJob>();
  for (const j of (jobsQ.data ?? []) as unknown as DeriveJob[]) {
    const cid = j.params?.curriculum_id;
    if (cid && !latestDerive.has(cid)) latestDerive.set(cid, j); // newest first
  }
  const openDerived = new Map<string, number>();
  for (const c of (candQ.data ?? []) as unknown as { curriculum_nodes: { curriculum_id: string } | { curriculum_id: string }[] | null }[]) {
    const cn = Array.isArray(c.curriculum_nodes) ? c.curriculum_nodes[0] : c.curriculum_nodes;
    if (!cn) continue;
    openDerived.set(cn.curriculum_id, (openDerived.get(cn.curriculum_id) ?? 0) + 1);
  }

  /** The curriculum's coverage: its leaf nodes (objectives), covered by the
   *  tree rules. A flat seed (no parents) counts every node. */
  const curriculumCoverage = (id: string) => {
    const nodes = nodesByCurriculum.get(id) ?? [];
    const tree = nodeTree(nodes);
    const leaves = nodes.filter((n) => childrenOf(tree, n.id).length === 0);
    return coverageOf(leaves, mappedByCurriculum.get(id) ?? [], tree);
  };

  const current = curricula.find((c) => c.id === selected) ?? null;

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <Heading />
      <p className="text-[#5B6470] mb-5">
        Which topics cover each objective of each syllabus, and which objectives nobody covers yet. Exam boards are
        curricula too (kind <span className="font-mono text-xs">exam_board</span>). <span className="font-medium">Derive topics</span>{" "}
        asks the model to propose one topic per group of objectives; the proposals land in Candidates for approval.
      </p>
      {layerMissing && <div className="mb-5"><MissingTablesBanner table="jobs.params" migration={CATALOGUE_LAYER_MIGRATION} /></div>}
      {!layerMissing && jobsQ.error && <div className="mb-5"><ErrorBanner message={`Could not read the derive jobs: ${jobsQ.error.message}`} /></div>}

      {curricula.length === 0 ? (
        <div className="card px-6 py-12 text-center text-sm text-[#5B6470]">
          No curricula loaded yet. The Cambridge and CBSE seeds land here (founder operation, plan §9).
        </div>
      ) : (
        <div className="card divide-y divide-[#EEF0EC] mb-8">
          {curricula.map((c) => {
            const cov = curriculumCoverage(c.id);
            const active = c.id === selected;
            const job = latestDerive.get(c.id) ?? null;
            const live = isLiveJobStatus(job?.status);
            const open = openDerived.get(c.id) ?? 0;
            return (
              <div key={c.id} className={`px-5 py-3 grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-center text-sm ${active ? "bg-[#F4FAF6]" : ""}`}>
                <span className="min-w-0">
                  <Link href={`/library/curricula?curriculum=${c.id}`} className="font-medium hover:underline">
                    {c.name}
                  </Link>
                  <span className="text-[#5B6470]">
                    {" "}
                    · <span className="font-mono text-xs">{c.code}</span>
                    {c.country && ` · ${c.country}`}
                    {c.edition && ` · ${c.edition}`}
                    {c.kind && c.kind !== "syllabus" && (
                      <>
                        {" "}
                        <span className="chip bg-[#EDE7FB] text-[#5B3FBF]">{c.kind}</span>
                      </>
                    )}
                  </span>
                  <span className="block mt-1">
                    <CoverageBar {...cov} unit="objectives" />
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-3 text-xs text-[#5B6470]">
                  <span className="inline-flex flex-col">
                    <span className="text-[#98A0A9]">Last derive</span>
                    <JobSummary job={job} />
                  </span>
                  <span className="inline-flex flex-col">
                    <span className="text-[#98A0A9]">Derived candidates</span>
                    {open > 0 ? (
                      <Link href={`/library/candidates#curriculum-${c.id}`} className="font-medium text-[#14181F] hover:underline tabular">
                        {open} open
                      </Link>
                    ) : (
                      <span className="text-[#98A0A9]">none open</span>
                    )}
                  </span>
                </span>
                <span className="md:justify-self-end">
                  {canCurate && <DeriveButton curriculumId={c.id} live={live} disabled={layerMissing} />}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {current && <CurriculumDetail curriculum={current} canCurate={canCurate} />}
    </main>
  );
}

type Covering = { topic: { id: string; title: string; status: string }; coverage: "full" | "partial" };

type Ctx = {
  byId: ReadonlyMap<string, CurriculumNode>;
  tree: NodeTree;
  covering: ReadonlyMap<string, Covering[]>;
  covered: ReadonlySet<string>;
  mappings: readonly { node_id: string }[];
  canCurate: boolean;
};

async function CurriculumDetail({ curriculum, canCurate }: { curriculum: Curriculum; canCurate: boolean }) {
  const admin = createAdminClient();
  const [nodesQ, mapsQ] = await Promise.all([
    admin
      .from("curriculum_nodes")
      .select("id, curriculum_id, code, grade, strand, sub_strand, title, description, parent_id, sort, kind")
      .eq("curriculum_id", curriculum.id)
      .order("sort", { ascending: true, nullsFirst: false })
      .order("code", { ascending: true })
      .limit(5000),
    admin
      .from("topic_curriculum_map")
      .select("node_id, coverage, topic_id, topics(id, title, status), curriculum_nodes!inner(curriculum_id)")
      .eq("curriculum_nodes.curriculum_id", curriculum.id)
      .limit(20000),
  ]);
  if (catalogueColumnMissing(nodesQ.error)) return <MissingTablesBanner table="curriculum_nodes.kind" migration={CATALOGUE_LAYER_MIGRATION} />;
  if (nodesQ.error) return <ErrorBanner message={`Could not read the nodes: ${nodesQ.error.message}`} />;
  if (mapsQ.error) return <ErrorBanner message={`Could not read the mappings: ${mapsQ.error.message}`} />;

  const nodes = (nodesQ.data ?? []) as CurriculumNode[];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const tree = nodeTree(nodes);
  const covering = new Map<string, Covering[]>();
  for (const m of (mapsQ.data ?? []) as unknown as MappingHit[]) {
    const t = Array.isArray(m.topics) ? m.topics[0] : m.topics;
    if (!t) continue;
    const list = covering.get(m.node_id) ?? [];
    list.push({ topic: t, coverage: m.coverage });
    covering.set(m.node_id, list);
  }
  const mappings = [...covering.keys()].map((node_id) => ({ node_id }));
  const covered = coveredSet(mappings, tree);
  const ctx: Ctx = { byId, tree, covering, covered, mappings, canCurate };

  // Roots (no parent in the set), grouped by grade in the syllabus order.
  const roots = nodes.filter((n) => !tree.parent.get(n.id));
  const grades = new Map<string, { label: string; roots: CurriculumNode[] }>();
  for (const r of roots) {
    const key = r.grade ?? "";
    const g = grades.get(key) ?? { label: r.grade ? `Grade ${r.grade}` : "No grade", roots: [] };
    g.roots.push(r);
    grades.set(key, g);
  }
  const leavesUnder = (ids: string[]) => {
    const out: { id: string }[] = [];
    for (const id of ids) {
      const leaves = leafDescendants(tree, id);
      if (leaves.length) for (const l of leaves) out.push({ id: l });
      else out.push({ id });
    }
    return out;
  };
  const total = coverageOf(
    nodes.filter((n) => childrenOf(tree, n.id).length === 0),
    mappings,
    tree,
  );
  const split = (list: CurriculumNode[]) => ({
    groups: list.filter((n) => isBranchGroup(n, tree)),
    leaves: list.filter((n) => !isBranchGroup(n, tree)),
  });

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-2xl font-display">{curriculum.name}</h2>
        <CoverageBar {...total} unit="objectives" />
      </div>
      {curriculum.source_url && (
        <p className="text-xs text-[#5B6470] mb-4">
          Source:{" "}
          <a href={curriculum.source_url} target="_blank" rel="noreferrer" className="underline break-all">
            {curriculum.source_url}
          </a>
        </p>
      )}
      {nodes.length === 0 && <p className="card px-6 py-8 text-center text-sm text-[#5B6470]">This curriculum has no nodes yet.</p>}
      {[...grades.entries()].map(([key, g]) => (
        <details key={key || "none"} open className="card mb-4">
          <summary className="px-5 py-3 flex flex-wrap items-center justify-between gap-3 cursor-pointer select-none">
            <span className="font-medium">{g.label}</span>
            <CoverageBar
              {...coverageOf(
                leavesUnder(g.roots.map((r) => r.id)),
                mappings,
                tree,
              )}
              unit="objectives"
            />
          </summary>
          <div className="divide-y divide-[#EEF0EC] border-t border-[#EEF0EC]">
            {split(g.roots).groups.map((r) => (
              <Branch key={r.id} node={r} ctx={ctx} depth={0} />
            ))}
            {split(g.roots).leaves.length > 0 && (
              // Root leaves (a flat seed; CBSE's chapters): a plain list.
              <ul className="px-5 py-2 divide-y divide-[#F4F6F3]">
                {split(g.roots).leaves.map((n) => (
                  <LeafRow key={n.id} node={n} kind={nodeKind(n)} inferred={!n.kind && nodeKind(n) !== null} ctx={ctx} />
                ))}
              </ul>
            )}
          </div>
        </details>
      ))}
    </section>
  );
}

/** A node renders as a group when it has children, or its kind says so. */
function isBranchGroup(n: CurriculumNode, tree: NodeTree): boolean {
  return childrenOf(tree, n.id).length > 0 || isGroupKind(nodeKind(n));
}

/** One node and, for a group, everything under it. The level decides the
 *  shape: a strand collapses; a sub-strand / unit is a titled block with its
 *  "n/m objectives mapped" and its own Create (mapping the ticked children);
 *  a leaf is a row with its covering topics or a Create of its own. A node
 *  whose kind is unresolvable is a group when it has children, else a leaf. */
function Branch({ node, ctx, depth }: { node: CurriculumNode; ctx: Ctx; depth: number }) {
  const kind = nodeKind(node);
  const inferred = !node.kind && kind !== null;
  const kids = childrenOf(ctx.tree, node.id)
    .map((id) => ctx.byId.get(id))
    .filter((n): n is CurriculumNode => !!n);
  const isGroup = isBranchGroup(node, ctx.tree);
  const direct = ctx.covering.get(node.id) ?? [];
  const isCovered = ctx.covered.has(node.id);

  if (!isGroup) return <LeafRow node={node} kind={kind} inferred={inferred} ctx={ctx} />;

  // Sub-groups render as branches; leaves share one list, so an <li> is
  // always inside a <ul> whichever level it sits at.
  const groupKids = kids.filter((k) => isBranchGroup(k, ctx.tree));
  const leafKids = kids.filter((k) => !isBranchGroup(k, ctx.tree));
  const body = (
    <>
      {groupKids.map((k) => (
        <Branch key={k.id} node={k} ctx={ctx} depth={depth + 1} />
      ))}
      {leafKids.length > 0 && (
        <ul className="divide-y divide-[#F4F6F3]">
          {leafKids.map((k) => (
            <LeafRow key={k.id} node={k} kind={nodeKind(k)} inferred={!k.kind && nodeKind(k) !== null} ctx={ctx} />
          ))}
        </ul>
      )}
    </>
  );

  const objectives = objectiveCoverage(ctx.tree, node.id, ctx.mappings);
  const children = mappableChildren(ctx.tree, node.id, ctx.byId).map((c) => ({ id: c.id, code: c.code, title: c.title }));
  const header = (
    <>
      <span className="min-w-0">
        <span className="font-mono text-xs text-[#1F5B99]">{node.code}</span>{" "}
        <span className={depth === 0 ? "font-medium" : "text-sm font-medium text-[#1F3A31]"}>{node.title}</span> <KindChip kind={kind} inferred={inferred} />
        {node.description && <span className="block text-xs text-[#5B6470]">{node.description}</span>}
        {direct.length > 0 && <CoveringList covering={direct} />}
      </span>
      <span className="flex flex-wrap items-center gap-3 shrink-0">
        {objectives && (depth === 0 ? <CoverageBar {...objectives} unit="objectives" /> : <ObjectiveCount covered={objectives.covered} total={objectives.total} />)}
        {!isCovered && ctx.canCurate && children.length > 0 && <CreateFromNode nodeId={node.id} title={node.title} kind={kind} objectives={children} />}
        {!isCovered && ctx.canCurate && children.length === 0 && kids.length === 0 && <CreateFromNode nodeId={node.id} title={node.title} kind={kind} objectives={[]} />}
      </span>
    </>
  );

  // Strands (and any root group) collapse per strand.
  if (kind === "strand" || depth === 0) {
    return (
      <details open className="group/strand">
        <summary className="px-5 py-3 flex flex-wrap items-start justify-between gap-3 cursor-pointer select-none">{header}</summary>
        <div className="px-5 pb-3 space-y-3">{body}</div>
      </details>
    );
  }

  return (
    <div className="rounded-lg border border-[#EEF0EC] px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-2">{header}</div>
      <div className="space-y-3">{body}</div>
    </div>
  );
}

function LeafRow({ node, kind, inferred, ctx }: { node: CurriculumNode; kind: ReturnType<typeof nodeKind>; inferred: boolean; ctx: Ctx }) {
  const direct = ctx.covering.get(node.id) ?? [];
  const viaGroup = direct.length === 0 && ctx.covered.has(node.id);
  return (
    <li className="py-1.5 flex items-start justify-between gap-3 text-sm">
      <span className="min-w-0">
        <span className="font-mono text-xs text-[#1F5B99]">{node.code}</span> {node.title} <KindChip kind={kind} inferred={inferred} />
        {node.description && <span className="block text-xs text-[#5B6470]">{node.description}</span>}
        {direct.length > 0 && <CoveringList covering={direct} />}
        {viaGroup && (
          <span className="block mt-1">
            <span className="chip bg-[#E6F6F2] text-[#0F7A68]" title="A topic mapped to the group above covers this objective">
              covered by its group
            </span>
          </span>
        )}
      </span>
      {direct.length === 0 &&
        !viaGroup &&
        (ctx.canCurate ? (
          <CreateFromNode nodeId={node.id} title={node.title} kind={kind} objectives={[]} />
        ) : (
          <span className="chip bg-[#FFF1D6] text-[#9A6400] shrink-0">uncovered</span>
        ))}
    </li>
  );
}

function CoveringList({ covering }: { covering: Covering[] }) {
  return (
    <span className="flex flex-wrap items-center gap-2 mt-1">
      {covering.map((c) => (
        <span key={c.topic.id} className="inline-flex items-center gap-1">
          <Link href={`/library/topics/${c.topic.id}`} className="text-xs font-medium hover:underline">
            {c.topic.title}
          </Link>
          <CoverageChip coverage={c.coverage} />
          <StatusChip status={c.topic.status} />
        </span>
      ))}
    </span>
  );
}

function Heading() {
  return (
    <>
      <h1 className="text-3xl font-display mb-1">Curricula</h1>
      <InkUnderline className="block h-3 w-28 mb-3" color="#7FD8A8" />
    </>
  );
}
