import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { resolveCandidate, type ResolveMode, type ResolvePlan } from "@/utils/catalogue/status";
import type { TopicCandidate } from "@/utils/catalogue/types";
import { attachAlias, attachMappings, audit, bad, conflict, dbError, insertTopic, keyOwner, keyTaken, notFound, readJson, rollbackTopic, text, uuid } from "../lib";

export const runtime = "nodejs";

// POST {candidateId, mode: merge|create|dismiss, topicId?, subject?} — resolve
// one row of the unmapped queue (curate). The plan comes from the pure
// resolveCandidate(); this handler only executes it:
//   merge   — alias (+ node mappings for a curriculum candidate) onto topicId,
//             or onto the suggested topic when topicId is omitted
//   create  — a new candidate-status topic keyed canonicalKey(raw_title)
//   dismiss — nothing but the candidate row
// A GROUPED curriculum candidate (0113: node_ids lists the objectives, node_id
// is the anchor sub-strand/unit) maps EVERY node in node_ids as `full`; only a
// candidate with an empty node_ids maps its node_id. The plan's mapping list
// is the pure resolveCandidate()'s, and the count lands in the audit row.
// Every name the plan would attach is checked for an owner BEFORE anything is
// written: a key held by another topic — as its canonical_key or its alias — is
// a 409 naming that topic (existingId / conflictTopicId), which is where the
// candidate should merge; a topic merged away is followed to the live one. A
// conflict that still appears after the check is a lost race: in create mode
// the just-inserted topic is taken back out, and the answer is the same 409 —
// never a 200 with a half-attached topic.
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
    .select("id, source_kind, book_id, node_id, node_ids, rationale, raw_title, normalized, suggested_topic_id, status")
    .eq("id", candidateId)
    .maybeSingle();
  if (cErr) return dbError(cErr); // 0113 missing (node_ids) → 409 with the hint
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

  // Owner check for every alias the plan would attach, before any write. In
  // create mode insertTopic checks the canonical key itself (the same key as
  // the title alias), so only the keys it will not see are checked here.
  const MERGE_HINT = "merge into that one.";
  const skip = plan.mode === "create" && plan.topic ? plan.topic.canonical_key : null;
  for (const a of plan.aliases) {
    if (a.normalized === skip) continue;
    const held = await keyOwner(admin, a.normalized);
    if (!held.ok) return dbError(held.error);
    if (held.owner && held.owner.topicId !== target) {
      return keyTaken(a.normalized, held.owner, MERGE_HINT);
    }
  }

  let createdId: string | null = null;
  if (plan.mode === "create" && plan.topic) {
    const created = await insertTopic(admin, plan.topic);
    if (!created.ok) {
      if ("existingId" in created) return keyTaken(plan.topic.canonical_key, created.owner, "merge into it instead.");
      return dbError(created.error);
    }
    target = created.id;
    createdId = created.id;
  }

  const detail: Record<string, unknown> = {
    mode,
    raw_title: candidate.raw_title,
    source_kind: candidate.source_kind,
    book_id: candidate.book_id,
    node_id: candidate.node_id,
    node_ids: candidate.node_ids ?? [],
    topic_id: target,
  };

  if (target) {
    for (const a of plan.aliases) {
      const r = await attachAlias(admin, target, a.alias, a.normalized, a.source);
      if (!r.ok) {
        // The pre-check passed, so this is a race lost since. A just-created
        // topic goes back out (its aliases so far cascade with it); the answer
        // names the topic that owns the name and changes nothing else.
        if (createdId) await rollbackTopic(admin, createdId);
        if ("conflictTopicId" in r) {
          const held = await keyOwner(admin, a.normalized);
          if (held.ok && held.owner) return keyTaken(a.normalized, held.owner, MERGE_HINT);
          return conflict(`"${a.alias}" is already an alias of another topic — ${MERGE_HINT}`, {
            conflictTopicId: r.conflictTopicId,
          });
        }
        return dbError(r.error);
      }
      detail.alias = r.created ? "created" : "existing";
    }
    if (plan.mappings.length) {
      const r = await attachMappings(
        admin,
        target,
        plan.mappings.map((mp) => mp.node_id),
        "full",
      );
      if (!r.ok) return dbError(r.error);
      detail.mappings = plan.mappings.length;
      detail.mappings_created = r.created;
      detail.mappings_existing = r.existing;
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
