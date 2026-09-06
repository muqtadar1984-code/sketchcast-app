import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { libraryAllows, type LibraryAction } from "@/utils/library-routing";
import { canonicalKey } from "@/utils/catalogue/key";
import { TEACHER_AVATARS, canTransition, catalogueMissing, reopenTarget } from "@/utils/catalogue/status";
import type { Topic, TopicStatus } from "@/utils/catalogue/types";
import { attachAlias, attachMapping, attachMappings, audit, bad, conflict, dbError, isCoverage, notFound, readJson, text, uuid } from "../../lib";

export const runtime = "nodejs";

// One topic. POST {action, ...} — every action is audited as library_<action>
// with target_kind 'topic'.
//
//   curate (editor, admin):
//     update          {title?, subject?, summary?, teacher_avatar?}
//     alias_add       {alias}            alias_remove   {aliasId}
//     mapping_add     {nodeId, coverage, notes?, mapChildren?}   mapping_remove {mappingId}
//                     mapChildren: true maps every direct child of nodeId (a
//                     sub-strand's objectives) instead of the node itself
//     prereq_add      {topicId}          prereq_remove  {topicId}
//     set_depth       {nodeId | null}    (must be one of the topic's mapped nodes)
//     retire                             reopen (retired→candidate, in_review→generating,
//                                                video_approved→in_review)
//     merge           {targetId}         this topic's aliases, mappings, open
//                                        candidates and prerequisite references
//                                        move to the target; this title becomes a
//                                        manual alias of the target; this topic retires
//   approve (reviewer, editor, admin):
//     approve                            candidate → approved
//
// A member whose role does not allow the action gets the same 404 as a
// non-member (library-access.ts: the portal is not probeable).

type Action =
  | "update"
  | "alias_add"
  | "alias_remove"
  | "mapping_add"
  | "mapping_remove"
  | "prereq_add"
  | "prereq_remove"
  | "set_depth"
  | "approve"
  | "retire"
  | "reopen"
  | "merge";

const NEEDS: Record<Action, LibraryAction> = {
  update: "curate",
  alias_add: "curate",
  alias_remove: "curate",
  mapping_add: "curate",
  mapping_remove: "curate",
  prereq_add: "curate",
  prereq_remove: "curate",
  set_depth: "curate",
  approve: "approve",
  retire: "curate",
  reopen: "curate",
  merge: "curate",
};

type Body = {
  action?: unknown;
  title?: unknown;
  subject?: unknown;
  summary?: unknown;
  teacher_avatar?: unknown;
  alias?: unknown;
  aliasId?: unknown;
  nodeId?: unknown;
  coverage?: unknown;
  notes?: unknown;
  mappingId?: unknown;
  mapChildren?: unknown;
  topicId?: unknown;
  targetId?: unknown;
};

const TOPIC_COLUMNS =
  "id, canonical_key, title, subject, summary, teacher_avatar, depth_node_id, prerequisites, status, bank_maturity, created_by, created_at, updated_at";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const m = await isLibraryMemberRequest();
  if (!m) return notFound();

  const { id: rawId } = await ctx.params;
  const id = uuid(rawId);
  if (!id) return notFound();

  const body = await readJson<Body>(request);
  if (!body) return bad("Invalid JSON.");
  const action = body.action as Action;
  if (typeof action !== "string" || !(action in NEEDS)) return bad("Unknown action.");
  if (!libraryAllows(m.role, NEEDS[action])) return notFound();

  const admin = createAdminClient();
  const { data: topicRow, error: tErr } = await admin.from("topics").select(TOPIC_COLUMNS).eq("id", id).maybeSingle();
  if (tErr) return dbError(tErr);
  if (!topicRow) return NextResponse.json({ error: "Topic not found." }, { status: 404 });
  const topic = topicRow as unknown as Topic;
  const touch = { updated_at: new Date().toISOString() };

  // ── update ─────────────────────────────────────────────────────────────────
  if (action === "update") {
    const patch: Record<string, string | null> = {};
    if (body.title !== undefined) {
      const title = text(body.title, 120);
      if (!title) return bad("title cannot be blank.");
      patch.title = title;
    }
    if (body.subject !== undefined) patch.subject = text(body.subject, 60) || null;
    if (body.summary !== undefined) patch.summary = text(body.summary, 2000) || null;
    if (body.teacher_avatar !== undefined) {
      const av = text(body.teacher_avatar, 60);
      if (av && !(TEACHER_AVATARS as readonly string[]).includes(av) && !/^avatar_[a-z0-9_]+$/.test(av)) {
        return bad("teacher_avatar must be a roster id (avatar_…) or blank.");
      }
      patch.teacher_avatar = av || null;
    }
    if (Object.keys(patch).length === 0) return bad("Nothing to update.");
    const { error } = await admin.from("topics").update({ ...patch, ...touch }).eq("id", id);
    if (error) return dbError(error);
    const before: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) before[k] = (topic as unknown as Record<string, unknown>)[k] ?? null;
    await audit(admin, m.id, "topic_update", "topic", id, { before, after: patch });
    return NextResponse.json({ ok: true });
  }

  // ── aliases ────────────────────────────────────────────────────────────────
  if (action === "alias_add") {
    const alias = text(body.alias, 120);
    if (!alias) return bad("alias is required.");
    const normalized = canonicalKey(alias);
    if (!normalized) return bad("That alias has no Latin letters or digits, so it has no key.");
    const r = await attachAlias(admin, id, alias, normalized, "manual");
    if (!r.ok) {
      if ("conflictTopicId" in r) {
        return conflict(`"${alias}" is already an alias of another topic.`, { conflictTopicId: r.conflictTopicId });
      }
      return dbError(r.error);
    }
    if (!r.created) return NextResponse.json({ ok: true, unchanged: true });
    await admin.from("topics").update(touch).eq("id", id);
    await audit(admin, m.id, "alias_add", "topic", id, { alias, normalized });
    return NextResponse.json({ ok: true });
  }

  if (action === "alias_remove") {
    const aliasId = uuid(body.aliasId);
    if (!aliasId) return bad("aliasId is required.");
    const { data: row } = await admin.from("topic_aliases").select("id, alias, normalized").eq("id", aliasId).eq("topic_id", id).maybeSingle();
    if (!row) return NextResponse.json({ error: "Alias not found on this topic." }, { status: 404 });
    const { error } = await admin.from("topic_aliases").delete().eq("id", aliasId).eq("topic_id", id);
    if (error) return dbError(error);
    await admin.from("topics").update(touch).eq("id", id);
    await audit(admin, m.id, "alias_remove", "topic", id, { alias: row.alias, normalized: row.normalized });
    return NextResponse.json({ ok: true });
  }

  // ── curriculum mappings ────────────────────────────────────────────────────
  if (action === "mapping_add") {
    const nodeId = uuid(body.nodeId);
    if (!nodeId) return bad("nodeId is required.");
    if (!isCoverage(body.coverage)) return bad("coverage must be full or partial.");
    const notes = text(body.notes, 500) || null;
    const { data: node, error: nErr } = await admin.from("curriculum_nodes").select("id, code").eq("id", nodeId).maybeSingle();
    if (nErr) return dbError(nErr);
    if (!node) return NextResponse.json({ error: "Curriculum node not found." }, { status: 404 });
    if (body.mapChildren === true) {
      // "Map all N objectives": the group's direct children, not the group.
      const { data: kids, error: kErr } = await admin
        .from("curriculum_nodes")
        .select("id, code")
        .eq("parent_id", nodeId)
        .order("sort", { ascending: true, nullsFirst: false })
        .order("code", { ascending: true })
        .limit(500);
      if (kErr) return dbError(kErr);
      const children = (kids ?? []) as { id: string; code: string }[];
      if (!children.length) return bad("That node has no children to map; map the node itself.");
      const r = await attachMappings(
        admin,
        id,
        children.map((c) => c.id),
        body.coverage,
        notes,
      );
      if (!r.ok) return dbError(r.error);
      if (!r.created) return NextResponse.json({ ok: true, unchanged: true, mapped: 0 });
      await admin.from("topics").update(touch).eq("id", id);
      await audit(admin, m.id, "mapping_add", "topic", id, {
        node_id: nodeId,
        code: node.code,
        coverage: body.coverage,
        children: children.length,
        mappings_created: r.created,
        mappings_existing: r.existing,
        child_codes: children.map((c) => c.code),
      });
      return NextResponse.json({ ok: true, mapped: r.created });
    }
    const r = await attachMapping(admin, id, nodeId, body.coverage, notes);
    if (!r.ok) return dbError(r.error);
    if (!r.created) return NextResponse.json({ ok: true, unchanged: true });
    await admin.from("topics").update(touch).eq("id", id);
    await audit(admin, m.id, "mapping_add", "topic", id, { node_id: nodeId, code: node.code, coverage: body.coverage, mappings: 1 });
    return NextResponse.json({ ok: true, mapped: 1 });
  }

  if (action === "mapping_remove") {
    const mappingId = uuid(body.mappingId);
    if (!mappingId) return bad("mappingId is required.");
    const { data: row } = await admin
      .from("topic_curriculum_map")
      .select("id, node_id, coverage")
      .eq("id", mappingId)
      .eq("topic_id", id)
      .maybeSingle();
    if (!row) return NextResponse.json({ error: "Mapping not found on this topic." }, { status: 404 });
    const { error } = await admin.from("topic_curriculum_map").delete().eq("id", mappingId).eq("topic_id", id);
    if (error) return dbError(error);
    // The depth node must stay one of the mapped nodes.
    const patch: Record<string, unknown> = { ...touch };
    if (topic.depth_node_id === row.node_id) patch.depth_node_id = null;
    await admin.from("topics").update(patch).eq("id", id);
    await audit(admin, m.id, "mapping_remove", "topic", id, {
      node_id: row.node_id,
      coverage: row.coverage,
      depth_cleared: topic.depth_node_id === row.node_id,
    });
    return NextResponse.json({ ok: true });
  }

  // ── prerequisites ──────────────────────────────────────────────────────────
  if (action === "prereq_add" || action === "prereq_remove") {
    const other = uuid(body.topicId);
    if (!other) return bad("topicId is required.");
    if (other === id) return bad("A topic cannot be its own prerequisite.");
    const current = Array.isArray(topic.prerequisites) ? topic.prerequisites : [];
    let next: string[];
    if (action === "prereq_add") {
      const { data: exists } = await admin.from("topics").select("id, status").eq("id", other).maybeSingle();
      if (!exists) return NextResponse.json({ error: "Prerequisite topic not found." }, { status: 404 });
      if (current.includes(other)) return NextResponse.json({ ok: true, unchanged: true });
      next = [...current, other];
    } else {
      if (!current.includes(other)) return NextResponse.json({ ok: true, unchanged: true });
      next = current.filter((p) => p !== other);
    }
    const { error } = await admin.from("topics").update({ prerequisites: next, ...touch }).eq("id", id);
    if (error) return dbError(error);
    await audit(admin, m.id, action, "topic", id, { prerequisite: other, count: next.length });
    return NextResponse.json({ ok: true });
  }

  // ── depth node ─────────────────────────────────────────────────────────────
  if (action === "set_depth") {
    const nodeId = body.nodeId === null || body.nodeId === "" ? null : uuid(body.nodeId);
    if (body.nodeId !== null && body.nodeId !== "" && !nodeId) return bad("nodeId must be a node id or null.");
    if (nodeId) {
      const { data: mapped } = await admin
        .from("topic_curriculum_map")
        .select("id")
        .eq("topic_id", id)
        .eq("node_id", nodeId)
        .maybeSingle();
      if (!mapped) return bad("The depth node must be one of this topic's mapped nodes.");
    }
    const { error } = await admin.from("topics").update({ depth_node_id: nodeId, ...touch }).eq("id", id);
    if (error) return dbError(error);
    await audit(admin, m.id, "set_depth", "topic", id, { before: topic.depth_node_id, after: nodeId });
    return NextResponse.json({ ok: true });
  }

  // ── status ─────────────────────────────────────────────────────────────────
  if (action === "approve" || action === "retire" || action === "reopen") {
    const to: TopicStatus | null =
      action === "approve" ? "approved" : action === "retire" ? "retired" : reopenTarget(topic.status);
    if (!to) return bad(`A ${topic.status} topic cannot be reopened.`);
    if (!canTransition(topic.status, to)) {
      return conflict(`Cannot move a ${topic.status} topic to ${to}.`, { from: topic.status, to });
    }
    const { error } = await admin.from("topics").update({ status: to, ...touch }).eq("id", id);
    if (error) return dbError(error);
    await audit(admin, m.id, `topic_${action}`, "topic", id, { from: topic.status, to });
    return NextResponse.json({ ok: true, status: to });
  }

  // ── merge ──────────────────────────────────────────────────────────────────
  // Not one transaction (no RPC exists for it yet — see the open question in
  // the report); the steps are ordered so an interruption leaves nothing
  // dangling: attachments move first, the source retires last. Every step is
  // IDEMPOTENT — each moves "whatever of mine is still here", so a merge that
  // failed part-way is completed by clicking Merge again with the same target:
  // the aliases/mappings/candidates already moved are simply not there to move,
  // the target's prerequisite set is a union, attachAlias is a no-op on an
  // alias it already has, and retiring is retiring. A failure answers
  // {error, step, ...detail} — 409 for a unique-violation, else 500 — and is
  // audited as library_topic_merge_failed with the same step name, so the
  // trail shows exactly how far the merge got.
  if (action === "merge") {
    const targetId = uuid(body.targetId);
    if (!targetId) return bad("targetId is required.");
    if (targetId === id) return bad("A topic cannot be merged into itself.");
    const { data: targetRow, error: gErr } = await admin.from("topics").select(TOPIC_COLUMNS).eq("id", targetId).maybeSingle();
    if (gErr) return dbError(gErr);
    if (!targetRow) return NextResponse.json({ error: "Target topic not found." }, { status: 404 });
    const target = targetRow as unknown as Topic;
    if (target.status === "retired") return bad("The target topic is retired — reopen it first, or pick another.");
    if (topic.status === "retired") return bad("This topic is already retired.");

    const detail: Record<string, unknown> = { into: targetId, into_title: target.title };

    type MergeStep = "aliases" | "mappings" | "candidates" | "prerequisites" | "title_alias" | "retire";
    const failed = async (step: MergeStep, err: { code?: string; message?: string }, extra: Record<string, unknown> = {}) => {
      const error = err.message ?? "Database error.";
      await audit(admin, m.id, "topic_merge_failed", "topic", id, { step, error, code: err.code ?? null, ...detail, ...extra });
      if (catalogueMissing(err)) return dbError(err);
      const status = err.code === "23505" ? 409 : 500;
      return NextResponse.json({ error, step, ...detail, ...extra }, { status });
    };

    // 1. aliases → target (normalized is globally unique, so a move never collides)
    {
      const { data: moved, error } = await admin
        .from("topic_aliases")
        .update({ topic_id: targetId })
        .eq("topic_id", id)
        .select("id");
      if (error) return failed("aliases", error);
      detail.aliases_moved = moved?.length ?? 0;
    }

    // 2. mappings → target, dropping the ones the target already has
    {
      const [{ data: mine, error: e1 }, { data: theirs, error: e2 }] = await Promise.all([
        admin.from("topic_curriculum_map").select("id, node_id").eq("topic_id", id),
        admin.from("topic_curriculum_map").select("node_id").eq("topic_id", targetId),
      ]);
      if (e1) return failed("mappings", e1);
      if (e2) return failed("mappings", e2);
      const have = new Set((theirs ?? []).map((r) => r.node_id as string));
      const dup = (mine ?? []).filter((r) => have.has(r.node_id as string)).map((r) => r.id as string);
      const move = (mine ?? []).filter((r) => !have.has(r.node_id as string)).map((r) => r.id as string);
      if (dup.length) {
        const { error } = await admin.from("topic_curriculum_map").delete().in("id", dup);
        if (error) return failed("mappings", error, { mappings_to_drop: dup.length });
      }
      if (move.length) {
        const { error } = await admin.from("topic_curriculum_map").update({ topic_id: targetId }).in("id", move);
        if (error) return failed("mappings", error, { mappings_to_move: move.length, mappings_dropped_as_duplicate: dup.length });
      }
      detail.mappings_moved = move.length;
      detail.mappings_dropped_as_duplicate = dup.length;
    }

    // 3. open candidates that pointed here → point at the target
    {
      const { data: moved, error } = await admin
        .from("topic_candidates")
        .update({ suggested_topic_id: targetId })
        .eq("suggested_topic_id", id)
        .eq("status", "open")
        .select("id");
      if (error) return failed("candidates", error);
      detail.candidates_repointed = moved?.length ?? 0;
    }

    // 4. prerequisite references: topics that required THIS now require the target;
    //    the target inherits this topic's own prerequisites (never itself).
    {
      const { data: dependants, error: dErr } = await admin.from("topics").select("id, prerequisites").contains("prerequisites", [id]);
      if (dErr) return failed("prerequisites", dErr);
      let repointed = 0;
      for (const d of dependants ?? []) {
        const prev = (d.prerequisites as string[]) ?? [];
        const next = [...new Set(prev.map((p) => (p === id ? targetId : p)))].filter((p) => p !== (d.id as string));
        const { error } = await admin.from("topics").update({ prerequisites: next, ...touch }).eq("id", d.id);
        if (error) {
          // Count only the ones done, name the one that failed, and stop: a
          // retry repoints exactly the dependants that still name this topic.
          return failed("prerequisites", error, {
            dependants_repointed: repointed,
            dependants_remaining: (dependants ?? []).length - repointed,
            dependant_id: d.id,
          });
        }
        repointed++;
      }
      detail.dependants_repointed = repointed;
      const mine = Array.isArray(topic.prerequisites) ? topic.prerequisites : [];
      const theirs = Array.isArray(target.prerequisites) ? target.prerequisites : [];
      const merged = [...new Set([...theirs, ...mine])].filter((p) => p !== targetId && p !== id);
      const targetPatch: Record<string, unknown> = { prerequisites: merged, ...touch };
      // 5. depth: the target keeps its own; otherwise inherits ours (now mapped on it)
      if (!target.depth_node_id && topic.depth_node_id) targetPatch.depth_node_id = topic.depth_node_id;
      const { error } = await admin.from("topics").update(targetPatch).eq("id", targetId);
      if (error) return failed("prerequisites", error, { target_prerequisites: merged.length });
    }

    // 6. this title becomes a manual alias of the target. A CONFLICT here —
    //    the normalized title already belongs to a third topic — is recorded,
    //    not failed: the merge cannot fix that, and a retry would hit it again
    //    forever, leaving the source un-retired. A database error does fail.
    {
      const normalized = canonicalKey(topic.title) || topic.canonical_key;
      if (!normalized) {
        detail.title_alias = "no_key";
      } else {
        const r = await attachAlias(admin, targetId, topic.title, normalized, "manual");
        if (r.ok) detail.title_alias = r.created ? "created" : "existing";
        else if ("conflictTopicId" in r) {
          detail.title_alias = "conflict";
          detail.title_alias_owner = r.conflictTopicId;
        } else return failed("title_alias", r.error);
      }
    }

    // 7. retire the source
    {
      const { error } = await admin.from("topics").update({ status: "retired", ...touch }).eq("id", id);
      if (error) return failed("retire", error);
    }

    await audit(admin, m.id, "topic_merge", "topic", id, detail);
    await audit(admin, m.id, "topic_merge_target", "topic", targetId, { from: id, from_title: topic.title });
    return NextResponse.json({ ok: true, targetId, ...detail });
  }

  return bad("Unknown action.");
}
