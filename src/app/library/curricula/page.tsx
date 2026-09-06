import Link from "next/link";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { InkUnderline } from "@/components/ink-mark";
import { catalogueMissing, coverageOf } from "@/utils/catalogue/status";
import type { Curriculum, CurriculumNode } from "@/utils/catalogue/types";
import { CoverageBar, CoverageChip, ErrorBanner, MissingTablesBanner, StatusChip } from "../catalogue-ui";
import CreateFromNode from "./create-from-node";

// /library/curricula — every curriculum with its coverage; ?curriculum=<id>
// opens one: nodes grouped grade → strand → sub-strand, each with the topics
// that cover it, a coverage bar per group, and "Create topic from node" on the
// gaps. Coverage gaps drive what to author next (plan §7.2).

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MappingHit = {
  node_id: string;
  coverage: "full" | "partial";
  topic_id: string;
  topics: { id: string; title: string; status: string } | { id: string; title: string; status: string }[] | null;
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

  // Per-curriculum coverage for the list: node counts, and mapped node ids
  // through an inner embed on the node's curriculum (no id lists in the URL).
  const [nodesAllQ, mappedAllQ] = await Promise.all([
    admin.from("curriculum_nodes").select("id, curriculum_id").limit(20000),
    admin.from("topic_curriculum_map").select("node_id, curriculum_nodes!inner(curriculum_id)").limit(50000),
  ]);
  const nodesByCurriculum = new Map<string, { id: string }[]>();
  for (const n of (nodesAllQ.data ?? []) as { id: string; curriculum_id: string }[]) {
    const list = nodesByCurriculum.get(n.curriculum_id) ?? [];
    list.push({ id: n.id });
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

  const current = curricula.find((c) => c.id === selected) ?? null;

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <Heading />
      <p className="text-[#5B6470] mb-5">
        Which topics cover each node of each syllabus, and which nodes nobody covers yet. Exam boards are curricula too
        (kind <span className="font-mono text-xs">exam_board</span>).
      </p>

      {curricula.length === 0 ? (
        <div className="card px-6 py-12 text-center text-sm text-[#5B6470]">
          No curricula loaded yet. The Cambridge and CBSE seeds land here (founder operation, plan §9).
        </div>
      ) : (
        <div className="card divide-y divide-[#EEF0EC] mb-8">
          {curricula.map((c) => {
            const cov = coverageOf(nodesByCurriculum.get(c.id) ?? [], mappedByCurriculum.get(c.id) ?? []);
            const active = c.id === selected;
            return (
              <div key={c.id} className={`px-5 py-3 flex flex-wrap items-center justify-between gap-3 text-sm ${active ? "bg-[#F4FAF6]" : ""}`}>
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
                </span>
                <CoverageBar {...cov} />
              </div>
            );
          })}
        </div>
      )}

      {current && <CurriculumDetail curriculum={current} canCurate={canCurate} />}
    </main>
  );
}

async function CurriculumDetail({ curriculum, canCurate }: { curriculum: Curriculum; canCurate: boolean }) {
  const admin = createAdminClient();
  const [nodesQ, mapsQ] = await Promise.all([
    admin
      .from("curriculum_nodes")
      .select("id, curriculum_id, code, grade, strand, sub_strand, title, description, parent_id, sort")
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
  if (nodesQ.error) return <ErrorBanner message={`Could not read the nodes: ${nodesQ.error.message}`} />;
  if (mapsQ.error) return <ErrorBanner message={`Could not read the mappings: ${mapsQ.error.message}`} />;

  const nodes = (nodesQ.data ?? []) as CurriculumNode[];
  const byNode = new Map<string, { topic: { id: string; title: string; status: string }; coverage: "full" | "partial" }[]>();
  for (const m of (mapsQ.data ?? []) as unknown as MappingHit[]) {
    const t = Array.isArray(m.topics) ? m.topics[0] : m.topics;
    if (!t) continue;
    const list = byNode.get(m.node_id) ?? [];
    list.push({ topic: t, coverage: m.coverage });
    byNode.set(m.node_id, list);
  }
  const mappings = [...byNode.keys()].map((node_id) => ({ node_id }));

  // grade → strand → sub_strand, in the syllabus order the nodes arrived in.
  type Group = { key: string; label: string; nodes: CurriculumNode[]; children: Map<string, Group> };
  const grades = new Map<string, Group>();
  const groupFor = (map: Map<string, Group>, key: string, label: string): Group => {
    let g = map.get(key);
    if (!g) {
      g = { key, label, nodes: [], children: new Map() };
      map.set(key, g);
    }
    return g;
  };
  for (const n of nodes) {
    const g = groupFor(grades, n.grade ?? "", n.grade ? `Grade ${n.grade}` : "No grade");
    const s = groupFor(g.children, n.strand ?? "", n.strand ?? "No strand");
    const ss = groupFor(s.children, n.sub_strand ?? "", n.sub_strand ?? "");
    g.nodes.push(n);
    s.nodes.push(n);
    ss.nodes.push(n);
  }
  const total = coverageOf(nodes, mappings);

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-2xl font-display">{curriculum.name}</h2>
        <CoverageBar {...total} />
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
      {[...grades.values()].map((g) => (
        <details key={g.key} open className="card mb-4">
          <summary className="px-5 py-3 flex flex-wrap items-center justify-between gap-3 cursor-pointer select-none">
            <span className="font-medium">{g.label}</span>
            <CoverageBar {...coverageOf(g.nodes, mappings)} />
          </summary>
          <div className="divide-y divide-[#EEF0EC] border-t border-[#EEF0EC]">
            {[...g.children.values()].map((s) => (
              <div key={s.key} className="px-5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
                  <h3 className="text-sm font-medium text-[#1F3A31]">{s.label}</h3>
                  <CoverageBar {...coverageOf(s.nodes, mappings)} />
                </div>
                {[...s.children.values()].map((ss) => (
                  <div key={ss.key} className="mb-2">
                    {ss.label && <p className="text-xs uppercase tracking-wide text-[#98A0A9] mb-1">{ss.label}</p>}
                    <ul className="divide-y divide-[#F4F6F3]">
                      {ss.nodes.map((n) => {
                        const covering = byNode.get(n.id) ?? [];
                        return (
                          <li key={n.id} className="py-1.5 flex items-start justify-between gap-3 text-sm">
                            <span className="min-w-0">
                              <span className="font-mono text-xs text-[#1F5B99]">{n.code}</span> {n.title}
                              {n.description && <span className="block text-xs text-[#5B6470]">{n.description}</span>}
                              {covering.length > 0 && (
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
                              )}
                            </span>
                            {covering.length === 0 &&
                              (canCurate ? (
                                <CreateFromNode nodeId={n.id} title={n.title} />
                              ) : (
                                <span className="chip bg-[#FFF1D6] text-[#9A6400] shrink-0">uncovered</span>
                              ))}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </details>
      ))}
    </section>
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
