import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { resolveCandidate, type ResolveMode, type ResolvePlan } from "@/utils/catalogue/status";
import type { TopicCandidate } from "@/utils/catalogue/types";
import { attachAlias, attachMapping, audit, bad, conflict, dbError, insertTopic, notFound, readJson, text, uuid } from "../lib";

export const runtime = "nodejs";

// POST {candidateId, mode: merge|create|dismiss, topicId?, subject?} — resolve
// one row of the unmapped queue (curate). The plan comes from the pure
// resolveCandidate(); this handler only executes it:
//   merge   — alias (+ node mapping for a curriculum candidate) onto topicId,
//             or onto the suggested topic when topicId is omitted
//   create  — a new candidate-status topic keyed canonicalKey(raw_title)
//   dismiss — nothing but the candidate row
// Every outcome is audited as library_candidate_<mode>, target_kind 'candidate'.

type Body = { candidateId?: unknown; mode?: unknown; topicId?: unknown; subject?: unknown };

const MODES: ResolveMode[] = ["merge", "create", "dismiss"];

export async function POST(request: Request) {
  const m = await isLibraryMemberRequest("curate");
  if (!m) return notFound();

  const body = await readJson<Body>(request);
  if (!body) return bad("Invalid JSON.");
  const candidateId = uuid(body.candidateId);
  if (!candidateId) return bad("candidateId is required.");
  const mode = body.mode as ResolveMode;
  if (!MODES.includes(mode)) return bad("mode must be merge, create or dismiss.");
  const topicId = body.topicId === undefined || body.topicId === null || body.topicId === "" ? null : uuid(body.topicId);
  if (body.topicId && !topicId) return bad("topicId must be a topic id.");

  const admin = createAdminClient();
  const { data: cand, error: cErr } = await admin
    .from("topic_candidates")
    .select("id, source_kind, book_id, node_id, raw_title, normalized, suggested_topic_id, status")
    .eq("id", candidateId)
    .maybeSingle();
  if (cErr) return dbError(cErr);
  if (!cand) return NextResponse.json({ error: "Candidate not found." }, { status: 404 });
  const candidate = cand as unknown as TopicCandidate;

  let plan: ResolvePlan;
  try {
    plan = resolveCandidate(candidate, { mode, topicId, actorId: m.id, subject: text(body.subject, 60) || null });
  } catch (e) {
    return bad((e as Error).message);
  }

  let target = plan.topicId;

  if (plan.mode === "merge") {
    const { data: t, error } = await admin.from("topics").select("id, status, title").eq("id", target!).maybeSingle();
    if (error) return dbError(error);
    if (!t) return NextResponse.json({ error: "Target topic not found." }, { status: 404 });
    if (t.status === "retired") return bad("The target topic is retired — reopen it first, or pick another.");
  }

  if (plan.mode === "create" && plan.topic) {
    const created = await insertTopic(admin, plan.topic);
    if (!created.ok) {
      if ("existingId" in created) {
        return conflict(`A topic with the key "${plan.topic.canonical_key}" already exists — merge into it instead.`, {
          existingId: created.existingId,
        });
      }
      return dbError(created.error);
    }
    target = created.id;
  }

  const detail: Record<string, unknown> = {
    mode,
    raw_title: candidate.raw_title,
    source_kind: candidate.source_kind,
    book_id: candidate.book_id,
    node_id: candidate.node_id,
    topic_id: target,
  };

  if (target) {
    for (const a of plan.aliases) {
      const r = await attachAlias(admin, target, a.alias, a.normalized, a.source);
      if (!r.ok) {
        if ("conflictTopicId" in r) {
          // The name already belongs to another topic: that is where this
          // candidate should merge. Say so and change nothing.
          return conflict(`"${a.alias}" is already an alias of another topic — merge into that one.`, {
            conflictTopicId: r.conflictTopicId,
          });
        }
        return dbError(r.error);
      }
      detail.alias = r.created ? "created" : "existing";
    }
    for (const mp of plan.mappings) {
      const r = await attachMapping(admin, target, mp.node_id, mp.coverage);
      if (!r.ok) return dbError(r.error);
      detail.mapping = r.created ? "created" : "existing";
    }
    await admin.from("topics").update({ updated_at: new Date().toISOString() }).eq("id", target);
  }

  const { error: uErr } = await admin
    .from("topic_candidates")
    .update({
      status: plan.candidate.status,
      resolved_by: plan.candidate.resolved_by,
      resolved_at: plan.candidate.resolved_at,
      ...(plan.candidate.suggested_topic_id ? { suggested_topic_id: plan.candidate.suggested_topic_id } : {}),
    })
    .eq("id", candidateId)
    .eq("status", "open");
  if (uErr) return dbError(uErr);

  await audit(admin, m.id, `candidate_${mode}`, "candidate", candidateId, detail);
  return NextResponse.json({ ok: true, topicId: target, status: plan.candidate.status });
}
