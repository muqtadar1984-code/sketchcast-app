import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { bulkSkipUpdate, candidateMappingNodes, resolveCandidate, splitMappingNodes, type ResolvePlan } from "@/utils/catalogue/status";
import type { TopicCandidate } from "@/utils/catalogue/types";
import { attachAlias, audit, bad, dbError, existingNodeIds, insertTopic, notFound, readJson, rollbackTopic, text, upsertMappings, uuid } from "../../lib";

export const runtime = "nodejs";
// ~7 sequential round trips per created row (the key check, the insert, the
// alias check + insert, the mappings, the candidate update, the audit) × BATCH,
// none of them one transaction: the default function budget is too short for
// a slow region, and a batch cut off half-way is what `remaining` is for.
export const maxDuration = 60;

// POST {curriculumId, subject?} — "Create all unmatched" for one curriculum's
// derived candidates (curate): every OPEN curriculum-source candidate whose
// anchor node belongs to the curriculum and that has NO suggested topic is
// created the way a single "Create topic" is — the same resolveCandidate()
// plan, insertTopic's keyOwner check per row (the ONE pre-check), the same
// alias, the node_ids mappings in one upsert — in one request.
//
// The difference from the single route is what a taken key does: here it is
// not a 409 for the whole batch but a SKIP, reported per row with the topic
// that holds the key (skipped[].existingId) — and the candidate row is given
// that topic as its SUGGESTION (suggested_topic_id), so it leaves the
// unmatched set and is a one-click "Merge into suggested" on the Candidates
// page instead of being re-fetched, and skipped again, on every click. A title
// with no canonical key can never be created or matched by key: that row is
// DISMISSED by the member (audited with the reason), like a single Dismiss. A
// lost race (alias conflict after the check) takes the just-inserted topic
// back out and is a skip like a taken key. The objectives the batch would map
// are looked up ONCE first: node_ids has no foreign key, so one deleted since
// the derive is DROPPED from that row's mappings (dropped_missing_nodes) rather
// than failing the row with a 23503. A database error stops the batch and is
// reported in `failed` with the step and what was done so far — nothing is
// rolled back beyond the row that failed: a mapping failure takes that row's
// topic back out (nothing references it yet), and every created row is a
// complete topic.
// Capped at BATCH per call; `remaining` says how many are left for a second
// click. Audited per created topic (library_candidate_create, bulk: true), per
// skip (library_candidate_suggest / library_candidate_dismiss, bulk: true) and
// once for the batch on the curriculum (library_candidates_bulk_create).

const BATCH = 25;

type Body = { curriculumId?: unknown; subject?: unknown };

type Row = TopicCandidate & { curriculum_nodes: { curriculum_id: string } | { curriculum_id: string }[] | null };

type Skipped = {
  candidateId: string;
  raw_title: string;
  key: string;
  reason: string;
  existingId: string | null;
  existingTitle: string | null;
  /** What became of the row: it now suggests existingId, it was dismissed, or
   *  it is still open (its update failed) and will be back on the next click. */
  outcome: "suggested" | "dismissed" | "open";
};
type Created = { candidateId: string; raw_title: string; topicId: string; mappings: number; dropped_missing_nodes: string[] };
type Failed = { candidateId: string; raw_title: string; step: "topic" | "alias" | "mappings" | "candidate"; error: string };

export async function POST(request: Request) {
  const m = await isLibraryMemberRequest("curate");
  if (!m) return notFound();

  const body = await readJson<Body>(request);
  if (!body) return bad("Invalid JSON.");
  const curriculumId = uuid(body.curriculumId);
  if (!curriculumId) return bad("curriculumId is required.");
  const subject = text(body.subject, 60) || null;

  const admin = createAdminClient();
  const { data: curriculum, error: cErr } = await admin.from("curricula").select("id, code, name").eq("id", curriculumId).maybeSingle();
  if (cErr) return dbError(cErr);
  if (!curriculum) return NextResponse.json({ error: "Curriculum not found." }, { status: 404 });

  // The anchor node's curriculum decides membership (an inner embed on
  // topic_candidates.node_id → curriculum_nodes). node_ids is an array, not a
  // key, so it cannot be joined; the anchor is always set for a derived row.
  const { data, error, count } = await admin
    .from("topic_candidates")
    .select(
      "id, source_kind, book_id, node_id, node_ids, rationale, raw_title, normalized, suggested_topic_id, status, curriculum_nodes!inner(curriculum_id)",
      { count: "exact" },
    )
    .eq("status", "open")
    .eq("source_kind", "curriculum")
    .is("suggested_topic_id", null)
    .eq("curriculum_nodes.curriculum_id", curriculumId)
    .order("created_at", { ascending: true })
    .limit(BATCH);
  if (error) return dbError(error); // 0113 missing (node_ids) → 409 with the hint
  const rows = (data ?? []) as unknown as Row[];
  const total = count ?? rows.length;

  // Every objective the batch would map, looked up once (chunked) before any
  // write; the ones curriculum_nodes no longer has are dropped per row below.
  const nodesHeld = await existingNodeIds(admin, [...new Set(rows.flatMap((r) => candidateMappingNodes(r)))]);
  if (!nodesHeld.ok) return dbError(nodesHeld.error);

  const now = new Date().toISOString();
  const created: Created[] = [];
  const skipped: Skipped[] = [];
  let failed: Failed | null = null;
  let droppedTotal = 0;

  // A skipped row is SETTLED so it does not come back: the holder becomes its
  // suggestion, or it is dismissed (bulkSkipUpdate); audited either way. An
  // update that fails leaves the row open, and it counts as remaining.
  const settle = async (s: Omit<Skipped, "outcome">) => {
    const plan = bulkSkipUpdate(s, m.id, now);
    const { error: sErr } = await admin.from("topic_candidates").update(plan.update).eq("id", s.candidateId).eq("status", "open");
    if (sErr) {
      skipped.push({ ...s, outcome: "open" });
      return;
    }
    await audit(admin, m.id, plan.outcome === "suggest" ? "candidate_suggest" : "candidate_dismiss", "candidate", s.candidateId, {
      bulk: true,
      raw_title: s.raw_title,
      key: s.key,
      reason: s.reason,
      ...(plan.outcome === "suggest" ? { suggested_topic_id: s.existingId } : {}),
    });
    skipped.push({ ...s, outcome: plan.outcome === "suggest" ? "suggested" : "dismissed" });
  };

  for (const candidate of rows) {
    let plan: ResolvePlan;
    try {
      plan = resolveCandidate(candidate, { mode: "create", actorId: m.id, subject, now });
    } catch (e) {
      // An open row only throws here for a missing title / canonical key.
      await settle({ candidateId: candidate.id, raw_title: candidate.raw_title, key: candidate.normalized, reason: (e as Error).message, existingId: null, existingTitle: null });
      continue;
    }
    const topic = plan.topic!;

    // insertTopic checks who holds the key — canonical_key or alias — before
    // it inserts; a held key is a skip that names the holder, never a 409.
    const ins = await insertTopic(admin, topic);
    if (!ins.ok) {
      if ("existingId" in ins) {
        await settle({
          candidateId: candidate.id,
          raw_title: candidate.raw_title,
          key: topic.canonical_key,
          reason: ins.owner.via === "alias" ? `key is an alias of "${ins.owner.title}"` : `key belongs to "${ins.owner.title}"${ins.owner.retired ? " (retired)" : ""}`,
          existingId: ins.owner.topicId,
          existingTitle: ins.owner.title,
        });
        continue;
      }
      failed = { candidateId: candidate.id, raw_title: candidate.raw_title, step: "topic", error: ins.error.message };
      break;
    }
    const topicId = ins.id;

    let aliasOk = true;
    for (const a of plan.aliases) {
      const r = await attachAlias(admin, topicId, a.alias, a.normalized, a.source);
      if (r.ok) continue;
      // A race lost since the check: the topic goes back out (nothing is
      // mapped to it yet) and the row is a skip, never a half-made topic.
      await rollbackTopic(admin, topicId);
      aliasOk = false;
      if ("conflictTopicId" in r) {
        await settle({ candidateId: candidate.id, raw_title: candidate.raw_title, key: a.normalized, reason: "alias already belongs to another topic", existingId: r.conflictTopicId, existingTitle: null });
      } else {
        failed = { candidateId: candidate.id, raw_title: candidate.raw_title, step: "alias", error: r.error.message };
      }
      break;
    }
    if (!aliasOk) {
      if (failed) break;
      continue;
    }

    // The mappings in one upsert, less the objectives the lookup did not find.
    // A failure here takes the topic back out: nothing references it yet, and
    // a topic with half its mappings is worse than a row left open.
    const nodes = splitMappingNodes(plan.mappings.map((mp) => mp.node_id), nodesHeld.ids);
    const mapped = await upsertMappings(admin, topicId, nodes.keep, "full");
    if (!mapped.ok) {
      await rollbackTopic(admin, topicId);
      failed = { candidateId: candidate.id, raw_title: candidate.raw_title, step: "mappings", error: mapped.error.message };
      break;
    }
    nodes.dropped.push(...mapped.missing); // deleted between the lookup and the write
    droppedTotal += nodes.dropped.length;

    const { error: uErr } = await admin
      .from("topic_candidates")
      .update({ status: "created", resolved_by: plan.candidate.resolved_by, resolved_at: plan.candidate.resolved_at })
      .eq("id", candidate.id)
      .eq("status", "open");
    if (uErr) {
      failed = { candidateId: candidate.id, raw_title: candidate.raw_title, step: "candidate", error: uErr.message };
      break;
    }

    await audit(admin, m.id, "candidate_create", "candidate", candidate.id, {
      mode: "create",
      bulk: true,
      raw_title: candidate.raw_title,
      source_kind: candidate.source_kind,
      node_id: candidate.node_id,
      node_ids: candidate.node_ids ?? [],
      topic_id: topicId,
      mappings: nodes.keep.length,
      mappings_created: mapped.created,
      dropped_missing_nodes: nodes.dropped,
    });
    created.push({ candidateId: candidate.id, raw_title: candidate.raw_title, topicId, mappings: nodes.keep.length, dropped_missing_nodes: nodes.dropped });
  }

  // What a second click would find: every matching row neither created nor
  // settled — a skip whose update failed is still open and unmatched, and so
  // is the row that failed.
  const settled = skipped.filter((s) => s.outcome !== "open").length;
  const remaining = Math.max(0, total - created.length - settled);
  await audit(admin, m.id, "candidates_bulk_create", "curriculum", curriculumId, {
    code: curriculum.code,
    created: created.length,
    skipped: skipped.length,
    suggested: skipped.filter((s) => s.outcome === "suggested").length,
    dismissed: skipped.filter((s) => s.outcome === "dismissed").length,
    failed: failed ? 1 : 0,
    failed_step: failed?.step ?? null,
    dropped_missing_nodes: droppedTotal,
    remaining,
    skipped_titles: skipped.map((s) => s.raw_title).slice(0, 50),
  });

  if (failed) {
    return NextResponse.json({ ok: false, error: `Stopped at "${failed.raw_title}" (${failed.step}): ${failed.error}`, failed, created, skipped, remaining }, { status: 500 });
  }
  return NextResponse.json({ ok: true, created, skipped, remaining });
}
