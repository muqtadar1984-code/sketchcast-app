import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { resolveCandidate, type ResolvePlan } from "@/utils/catalogue/status";
import type { TopicCandidate } from "@/utils/catalogue/types";
import { attachAlias, attachMappings, audit, bad, dbError, insertTopic, keyOwner, notFound, readJson, rollbackTopic, text, uuid } from "../../lib";

export const runtime = "nodejs";

// POST {curriculumId, subject?} — "Create all unmatched" for one curriculum's
// derived candidates (curate): every OPEN curriculum-source candidate whose
// anchor node belongs to the curriculum and that has NO suggested topic is
// created the way a single "Create topic" is — the same resolveCandidate()
// plan, the same keyOwner pre-check per row, the same alias + node_ids
// mappings — in one request.
//
// The difference from the single route is what a taken key does: here it is
// not a 409 for the whole batch but a SKIP, reported per row with the topic
// that holds the key (skipped[].existingId) so the curator can merge those by
// hand. A lost race (alias conflict after the check) takes the just-inserted
// topic back out and lands in `skipped` too; a database error stops the batch
// and is reported in `failed` with what was done so far — nothing is rolled
// back beyond the row that failed, since every created row is a complete topic.
// Capped at BATCH per call; `remaining` says how many are left for a second
// click. Audited per created topic (library_candidate_create, bulk: true) and
// once for the batch on the curriculum (library_candidates_bulk_create).

const BATCH = 100;

type Body = { curriculumId?: unknown; subject?: unknown };

type Row = TopicCandidate & { curriculum_nodes: { curriculum_id: string } | { curriculum_id: string }[] | null };

type Skipped = { candidateId: string; raw_title: string; key: string; reason: string; existingId: string | null; existingTitle: string | null };
type Created = { candidateId: string; raw_title: string; topicId: string; mappings: number };

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

  const created: Created[] = [];
  const skipped: Skipped[] = [];
  let failed: { candidateId: string; raw_title: string; error: string } | null = null;

  for (const candidate of rows) {
    let plan: ResolvePlan;
    try {
      plan = resolveCandidate(candidate, { mode: "create", actorId: m.id, subject });
    } catch (e) {
      skipped.push({ candidateId: candidate.id, raw_title: candidate.raw_title, key: candidate.normalized, reason: (e as Error).message, existingId: null, existingTitle: null });
      continue;
    }
    const topic = plan.topic!;

    // The same pre-check a single create runs (insertTopic runs it again as
    // its own guard): a key somebody holds — canonical_key or alias — is a skip.
    const held = await keyOwner(admin, topic.canonical_key);
    if (!held.ok) {
      failed = { candidateId: candidate.id, raw_title: candidate.raw_title, error: held.error.message };
      break;
    }
    if (held.owner) {
      skipped.push({
        candidateId: candidate.id,
        raw_title: candidate.raw_title,
        key: topic.canonical_key,
        reason: held.owner.via === "alias" ? `key is an alias of "${held.owner.title}"` : `key belongs to "${held.owner.title}"${held.owner.retired ? " (retired)" : ""}`,
        existingId: held.owner.topicId,
        existingTitle: held.owner.title,
      });
      continue;
    }

    const ins = await insertTopic(admin, topic);
    if (!ins.ok) {
      if ("existingId" in ins) {
        skipped.push({ candidateId: candidate.id, raw_title: candidate.raw_title, key: topic.canonical_key, reason: `key belongs to "${ins.owner.title}"`, existingId: ins.owner.topicId, existingTitle: ins.owner.title });
        continue;
      }
      failed = { candidateId: candidate.id, raw_title: candidate.raw_title, error: ins.error.message };
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
        skipped.push({ candidateId: candidate.id, raw_title: candidate.raw_title, key: a.normalized, reason: "alias already belongs to another topic", existingId: r.conflictTopicId, existingTitle: null });
      } else {
        failed = { candidateId: candidate.id, raw_title: candidate.raw_title, error: r.error.message };
      }
      break;
    }
    if (!aliasOk) {
      if (failed) break;
      continue;
    }

    let mapped = 0;
    if (plan.mappings.length) {
      const r = await attachMappings(
        admin,
        topicId,
        plan.mappings.map((mp) => mp.node_id),
        "full",
      );
      if (!r.ok) {
        failed = { candidateId: candidate.id, raw_title: candidate.raw_title, error: r.error.message };
        break;
      }
      mapped = r.created;
    }

    const { error: uErr } = await admin
      .from("topic_candidates")
      .update({ status: "created", resolved_by: plan.candidate.resolved_by, resolved_at: plan.candidate.resolved_at })
      .eq("id", candidate.id)
      .eq("status", "open");
    if (uErr) {
      failed = { candidateId: candidate.id, raw_title: candidate.raw_title, error: uErr.message };
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
      mappings: plan.mappings.length,
      mappings_created: mapped,
    });
    created.push({ candidateId: candidate.id, raw_title: candidate.raw_title, topicId, mappings: plan.mappings.length });
  }

  const remaining = Math.max(0, total - created.length - skipped.length - (failed ? 1 : 0));
  await audit(admin, m.id, "candidates_bulk_create", "curriculum", curriculumId, {
    code: curriculum.code,
    created: created.length,
    skipped: skipped.length,
    failed: failed ? 1 : 0,
    remaining,
    skipped_titles: skipped.map((s) => s.raw_title).slice(0, 50),
  });

  if (failed) {
    return NextResponse.json({ ok: false, error: `Stopped at "${failed.raw_title}": ${failed.error}`, failed, created, skipped, remaining }, { status: 500 });
  }
  return NextResponse.json({ ok: true, created, skipped, remaining });
}
