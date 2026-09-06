import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { canonicalKey } from "@/utils/catalogue/key";
import { attachAlias, attachMapping, audit, bad, dbError, insertTopic, notFound, readJson, text, uuid } from "../lib";

export const runtime = "nodejs";

// POST {nodeId, title?, subject?} — "Create topic from node" on /library/curricula
// (curate). The node's title (or the given one) becomes a candidate topic, an
// alias with source 'curriculum', and a full-coverage mapping to the node. If
// the key already belongs to a topic, the answer is 409 with that topic's id so
// the editor can map the node to it instead.

type Body = { nodeId?: unknown; title?: unknown; subject?: unknown };

export async function POST(request: Request) {
  const m = await isLibraryMemberRequest("curate");
  if (!m) return notFound();

  const body = await readJson<Body>(request);
  if (!body) return bad("Invalid JSON.");
  const nodeId = uuid(body.nodeId);
  if (!nodeId) return bad("nodeId is required.");

  const admin = createAdminClient();
  const { data: node, error: nErr } = await admin
    .from("curriculum_nodes")
    .select("id, code, title, grade, strand, curriculum_id, curricula(code, name)")
    .eq("id", nodeId)
    .maybeSingle();
  if (nErr) return dbError(nErr);
  if (!node) return NextResponse.json({ error: "Curriculum node not found." }, { status: 404 });

  const title = text(body.title, 120) || text(node.title, 120);
  if (!title) return bad("The node has no title; give one.");
  const key = canonicalKey(title);
  if (!key) return bad("The title has no Latin letters or digits, so it has no canonical key.");
  const subject = text(body.subject, 60) || null;

  const created = await insertTopic(admin, { canonical_key: key, title, subject, status: "candidate", created_by: m.id });
  if (!created.ok) {
    if ("existingId" in created) {
      return NextResponse.json(
        { error: `A topic with the key "${key}" already exists — map the node to it instead.`, existingId: created.existingId },
        { status: 409 },
      );
    }
    return dbError(created.error);
  }
  const alias = await attachAlias(admin, created.id, title, key, "curriculum");
  const mapping = await attachMapping(admin, created.id, nodeId, "full");
  if (!mapping.ok) return dbError(mapping.error);

  const curriculum = node.curricula as unknown as { code?: string; name?: string } | { code?: string; name?: string }[] | null;
  const cur = Array.isArray(curriculum) ? curriculum[0] : curriculum;
  await audit(admin, m.id, "topic_create_from_node", "curriculum_node", nodeId, {
    topic_id: created.id,
    title,
    canonical_key: key,
    node_code: node.code,
    curriculum: cur?.code ?? null,
    alias: alias.ok ? (alias.created ? "created" : "existing") : "conflict",
  });
  return NextResponse.json({ ok: true, id: created.id });
}
