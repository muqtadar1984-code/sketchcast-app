import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CATALOGUE_MISSING_ERROR, catalogueMissing } from "@/utils/catalogue/status";
import type { AliasSource, Coverage } from "@/utils/catalogue/types";

// Shared plumbing for the /api/library/* route handlers. Server-only (imported
// by route handlers, never by a Client Component). The guard itself is NOT
// here on purpose: every route calls isLibraryMemberRequest() as its own first
// statement, so the source-scan test (catalogue-routes.test.ts) can see it.

export type Admin = SupabaseClient;

export const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404 });
export const bad = (error: string) => NextResponse.json({ error }, { status: 400 });
export const conflict = (error: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, ...extra }, { status: 409 });

/** A database error → 409 with the migration hint when 0112 is missing
 *  (like the ops route does for 0110), else 500 with the message. */
export function dbError(err: { code?: string; message?: string }) {
  if (catalogueMissing(err)) return NextResponse.json({ error: CATALOGUE_MISSING_ERROR }, { status: 409 });
  return NextResponse.json({ error: err.message ?? "Database error." }, { status: 500 });
}

export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

/** A trimmed string capped at `max`, or "" for anything that is not a string. */
export function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuid(v: unknown): string | null {
  return typeof v === "string" && UUID.test(v.trim()) ? v.trim() : null;
}

export function isCoverage(v: unknown): v is Coverage {
  return v === "full" || v === "partial";
}

/** Every mutation lands in platform_audit_log as library_<verb>. Audit
 *  failures are swallowed: the action already happened, and a missing audit
 *  row must not read back to the member as a failed action. */
export async function audit(
  admin: Admin,
  actorId: string,
  verb: string,
  targetKind: "topic" | "candidate" | "book" | "curriculum_node",
  targetId: string,
  detail: Record<string, unknown>,
) {
  try {
    await admin.from("platform_audit_log").insert({
      actor_id: actorId,
      action: `library_${verb}`,
      target_kind: targetKind,
      target_id: targetId,
      detail,
    });
  } catch {
    // see above
  }
}

/** Attach an alias to a topic. `normalized` is unique across the whole table:
 *  the same alias already on THIS topic is a no-op; on ANOTHER topic it is a
 *  conflict the caller must surface (the two topics probably want merging). */
export async function attachAlias(
  admin: Admin,
  topicId: string,
  alias: string,
  normalized: string,
  source: AliasSource,
): Promise<{ ok: true; created: boolean } | { ok: false; conflictTopicId: string } | { ok: false; error: { code?: string; message: string } }> {
  const { data: existing, error: eErr } = await admin
    .from("topic_aliases")
    .select("id, topic_id")
    .eq("normalized", normalized)
    .maybeSingle();
  if (eErr) return { ok: false, error: eErr };
  if (existing) {
    if (existing.topic_id === topicId) return { ok: true, created: false };
    return { ok: false, conflictTopicId: existing.topic_id as string };
  }
  const { error } = await admin.from("topic_aliases").insert({ topic_id: topicId, alias, normalized, source });
  if (error) {
    // Lost a race to the same normalized value: re-read and classify.
    if (error.code === "23505") {
      const { data: again } = await admin.from("topic_aliases").select("topic_id").eq("normalized", normalized).maybeSingle();
      if (again?.topic_id === topicId) return { ok: true, created: false };
      if (again?.topic_id) return { ok: false, conflictTopicId: again.topic_id as string };
    }
    return { ok: false, error };
  }
  return { ok: true, created: true };
}

/** Map a topic to a curriculum node. unique(topic_id, node_id): an existing
 *  pair is left as it is (its coverage is not overwritten). */
export async function attachMapping(
  admin: Admin,
  topicId: string,
  nodeId: string,
  coverage: Coverage,
  notes: string | null = null,
): Promise<{ ok: true; created: boolean } | { ok: false; error: { code?: string; message: string } }> {
  const { data: existing, error: eErr } = await admin
    .from("topic_curriculum_map")
    .select("id")
    .eq("topic_id", topicId)
    .eq("node_id", nodeId)
    .maybeSingle();
  if (eErr) return { ok: false, error: eErr };
  if (existing) return { ok: true, created: false };
  const { error } = await admin
    .from("topic_curriculum_map")
    .insert({ topic_id: topicId, node_id: nodeId, coverage, notes });
  if (error) {
    if (error.code === "23505") return { ok: true, created: false };
    return { ok: false, error };
  }
  return { ok: true, created: true };
}

/** Insert a topic, answering with the existing row's id when the canonical key
 *  is already taken — the caller offers "merge instead". */
export async function insertTopic(
  admin: Admin,
  topic: { canonical_key: string; title: string; subject: string | null; summary?: string | null; status: "candidate"; created_by: string | null },
): Promise<{ ok: true; id: string } | { ok: false; existingId: string } | { ok: false; error: { code?: string; message: string } }> {
  const { data: dupe, error: dErr } = await admin
    .from("topics")
    .select("id")
    .eq("canonical_key", topic.canonical_key)
    .maybeSingle();
  if (dErr) return { ok: false, error: dErr };
  if (dupe) return { ok: false, existingId: dupe.id as string };
  const { data, error } = await admin.from("topics").insert(topic).select("id").single();
  if (error) {
    if (error.code === "23505") {
      const { data: again } = await admin.from("topics").select("id").eq("canonical_key", topic.canonical_key).maybeSingle();
      if (again?.id) return { ok: false, existingId: again.id as string };
    }
    return { ok: false, error };
  }
  return { ok: true, id: data.id as string };
}
