import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { InkUnderline } from "@/components/ink-mark";
import { catalogueMissing } from "@/utils/catalogue/status";
import type { Curriculum, Topic, TopicAlias, TopicHit } from "@/utils/catalogue/types";
import { ErrorBanner, MaturityChip, MissingTablesBanner, StatusChip, fmtDate } from "../../catalogue-ui";
import { AliasPanel, MappingPanel, PrereqPanel, TopicActions, TopicHeaderEditor, type MappingRow } from "./topic-panels";

// /library/topics/[id] — one topic: header (editable), status actions, aliases,
// curriculum mappings with the depth-node selector, prerequisites, and the
// audit trail. Phase 1 (taxonomy) only; the article editor, kit review and
// publish panels arrive with their phases.

export const dynamic = "force-dynamic";

const TOPIC_COLUMNS =
  "id, canonical_key, title, subject, summary, teacher_avatar, depth_node_id, prerequisites, status, bank_maturity, created_by, created_at, updated_at";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RawMapping = {
  id: string;
  node_id: string;
  coverage: "full" | "partial";
  notes: string | null;
  curriculum_nodes:
    | {
        id: string;
        code: string;
        grade: string | null;
        strand: string | null;
        sub_strand: string | null;
        title: string;
        curriculum_id: string;
        curricula: { id: string; code: string; name: string } | { id: string; code: string; name: string }[] | null;
      }
    | null;
};

export default async function TopicDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const member = await requireLibraryMember();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const canCurate = libraryAllows(member.role, "curate");
  const canApprove = libraryAllows(member.role, "approve");
  const admin = createAdminClient();

  const { data: topicRow, error: tErr } = await admin.from("topics").select(TOPIC_COLUMNS).eq("id", id).maybeSingle();
  if (catalogueMissing(tErr)) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-10">
        <MissingTablesBanner table="topics" />
      </main>
    );
  }
  if (tErr) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-10">
        <ErrorBanner message={`Could not read the topic: ${tErr.message}`} />
      </main>
    );
  }
  if (!topicRow) notFound();
  const topic = topicRow as unknown as Topic;
  const prereqIds = Array.isArray(topic.prerequisites) ? topic.prerequisites : [];

  const [aliasQ, mapQ, currQ, prereqQ, depQ, candQ, auditQ] = await Promise.all([
    admin.from("topic_aliases").select("id, topic_id, alias, normalized, source").eq("topic_id", id).order("alias"),
    admin
      .from("topic_curriculum_map")
      .select("id, node_id, coverage, notes, curriculum_nodes(id, code, grade, strand, sub_strand, title, curriculum_id, curricula(id, code, name))")
      .eq("topic_id", id),
    admin.from("curricula").select("id, code, name, kind, country, edition, source_url").order("name"),
    prereqIds.length
      ? admin.from("topics").select("id, title, subject, status, canonical_key").in("id", prereqIds)
      : Promise.resolve({ data: [] as TopicHit[] }),
    admin.from("topics").select("id, title, subject, status, canonical_key").contains("prerequisites", [id]).limit(50),
    admin.from("topic_candidates").select("id", { count: "exact", head: true }).eq("suggested_topic_id", id).eq("status", "open"),
    admin.from("platform_audit_log").select("action, detail, created_at, actor_id").eq("target_id", id).order("created_at", { ascending: false }).limit(15),
  ]);

  const aliases = (aliasQ.data ?? []) as TopicAlias[];
  const mappings: MappingRow[] = ((mapQ.data ?? []) as unknown as RawMapping[])
    .map((m) => {
      const n = m.curriculum_nodes;
      const c = n?.curricula ? (Array.isArray(n.curricula) ? n.curricula[0] ?? null : n.curricula) : null;
      return {
        id: m.id,
        node_id: m.node_id,
        coverage: m.coverage,
        notes: m.notes,
        node: n
          ? { id: n.id, code: n.code, grade: n.grade, strand: n.strand, sub_strand: n.sub_strand, title: n.title, curriculum_id: n.curriculum_id }
          : null,
        curriculum: c,
      };
    })
    .sort((a, b) => (a.node?.code ?? "").localeCompare(b.node?.code ?? "", undefined, { numeric: true }));
  const curricula = (currQ.data ?? []) as Curriculum[];
  const byId = new Map(((prereqQ.data ?? []) as TopicHit[]).map((t) => [t.id, t]));
  const prerequisites = prereqIds.map((p) => byId.get(p)).filter((t): t is TopicHit => !!t);
  const dependants = (depQ.data ?? []) as TopicHit[];
  const openCandidates = candQ.count ?? 0;
  const trail = (auditQ.data ?? []) as { action: string; detail: Record<string, unknown> | null; created_at: string; actor_id: string | null }[];

  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <p className="mb-4 text-sm">
        <Link href="/library/topics" className="text-[#5B6470] hover:underline">
          ← Topics
        </Link>
      </p>
      <div className="flex flex-wrap items-center gap-3 mb-1">
        <h1 className="text-3xl font-display">{topic.title}</h1>
        <StatusChip status={topic.status} />
        <MaturityChip maturity={topic.bank_maturity} />
      </div>
      <InkUnderline className="block h-3 w-40 mb-3" color="#7FD8A8" />
      <p className="text-sm text-[#5B6470] mb-6">
        Created {fmtDate(topic.created_at)} · updated {fmtDate(topic.updated_at)}
        {openCandidates > 0 && (
          <>
            {" "}
            ·{" "}
            <Link href="/library/candidates" className="hover:underline">
              {openCandidates} open candidate{openCandidates === 1 ? "" : "s"} suggest this topic
            </Link>
          </>
        )}
      </p>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-5">
          <TopicHeaderEditor topic={topic} canCurate={canCurate} />
          <MappingPanel topic={topic} mappings={mappings} curricula={curricula} canCurate={canCurate} />
          <AliasPanel topicId={topic.id} aliases={aliases} canCurate={canCurate} />
          <PrereqPanel topicId={topic.id} prerequisites={prerequisites} dependants={dependants} canCurate={canCurate} />
        </div>
        <div className="space-y-5">
          <TopicActions topic={topic} canCurate={canCurate} canApprove={canApprove} />
          <div className="card p-5">
            <h2 className="font-medium mb-2">Pipeline</h2>
            <ol className="text-xs text-[#5B6470] space-y-1">
              {["candidate", "approved", "article_approved", "generating", "in_review", "video_approved", "published"].map((s) => (
                <li key={s} className={s === topic.status ? "text-[#14181F] font-medium" : ""}>
                  {s === topic.status ? "▸ " : "· "}
                  {s.replace(/_/g, " ")}
                </li>
              ))}
              {topic.status === "retired" && <li className="text-[#14181F] font-medium">▸ retired</li>}
            </ol>
            <p className="text-xs text-[#98A0A9] mt-3">
              Article, kit and publish steps arrive with their phases; Phase 1 approves the topic itself.
            </p>
          </div>
          <div className="card p-5">
            <h2 className="font-medium mb-2">Audit trail</h2>
            {trail.length === 0 ? (
              <p className="text-sm text-[#98A0A9]">Nothing yet.</p>
            ) : (
              <ul className="text-xs text-[#5B6470] space-y-1.5">
                {trail.map((a, i) => (
                  <li key={i}>
                    <span className="font-mono">{a.action.replace(/^library_/, "")}</span> · {fmtDate(a.created_at)}
                    {a.detail && Object.keys(a.detail).length > 0 && (
                      <span className="block text-[#98A0A9] truncate" title={JSON.stringify(a.detail)}>
                        {JSON.stringify(a.detail).slice(0, 120)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
