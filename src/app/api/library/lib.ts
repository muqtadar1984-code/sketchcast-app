import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalKey } from "@/utils/catalogue/key";
import {
  keyTakenMessage,
  migrationMissingMessage,
  missingMigration,
  pickKeyOwner,
  type KeyOwner,
  type OwnerRow,
} from "@/utils/catalogue/status";
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

/** The 409 for a key somebody already holds. `existingId` is what the client
 *  panels read (new-topic-form, create-from-node, candidate-actions); the rest
 *  says who and how, so the message can name a retired holder honestly. */
export const keyTaken = (key: string, owner: KeyOwner, hint: string) =>
  conflict(keyTakenMessage(key, owner, hint), {
    existingId: owner.topicId,
    existingTitle: owner.title,
    existingStatus: owner.status,
    via: owner.via,
  });

/** A database error → 409 with the migration hint when 0112 (a table) or
 *  0113 (a column: kind, node_ids, rationale, params) is missing — like the
 *  ops route does for 0110 — else 500 with the message. */
export function dbError(err: { code?: string; message?: string }) {
  const migration = missingMigration(err);
  if (migration) return NextResponse.json({ error: migrationMissingMessage(migration), migration }, { status: 409 });
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
/** A uuid from the body, trimmed and LOWER-CASED, or null. Postgres prints a
 *  uuid in lower case, and some of these ids are compared as TEXT — the
 *  derive route's live check and the jobs_one_live_derive index both key on
 *  params->>'curriculum_id' — so a case-variant of an id must be the same id,
 *  not a way past the check. */
export function uuid(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return UUID.test(s) ? s : null;
}

export function isCoverage(v: unknown): v is Coverage {
  return v === "full" || v === "partial";
}

/** A body field that should be a list of ids: every entry a uuid, duplicates
 *  dropped, capped. null when the field is absent (the caller applies its
 *  default); an empty array or a list with a non-uuid is `invalid`. */
export function uuidList(v: unknown, max = 500): { ids: string[] } | { invalid: true } | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) return { invalid: true };
  const ids: string[] = [];
  for (const raw of v) {
    const id = uuid(raw);
    if (!id) return { invalid: true };
    if (!ids.includes(id)) ids.push(id);
    if (ids.length > max) return { invalid: true };
  }
  return { ids };
}

/** Map one topic to each of `nodeIds` (attachMapping per node: an existing
 *  pair is kept as it is; a node that no longer exists is skipped and listed
 *  in `missing`). Stops at the first database error. */
export async function attachMappings(
  admin: Admin,
  topicId: string,
  nodeIds: readonly string[],
  coverage: Coverage,
  notes: string | null = null,
): Promise<{ ok: true; created: number; existing: number; missing: string[] } | { ok: false; error: { code?: string; message: string }; nodeId: string }> {
  let created = 0;
  let existing = 0;
  const missing: string[] = [];
  for (const nodeId of nodeIds) {
    const r = await attachMapping(admin, topicId, nodeId, coverage, notes);
    if (!r.ok) return { ok: false, error: r.error, nodeId };
    if (r.missing) missing.push(nodeId);
    else if (r.created) created++;
    else existing++;
  }
  return { ok: true, created, existing, missing };
}

/** ids per `.in()` — a uuid is 36 chars and the list travels in the URL (the
 *  candidates page's IN_CHUNK). */
export const IN_CHUNK = 150;

/** Which of `ids` curriculum_nodes still has. topic_candidates.node_ids
 *  (0113) is uuid[] with no foreign key, so a candidate may name an objective
 *  deleted since the derive; mapping that id is a 23503. The routes look the
 *  planned ids up here first and map only the ones found (splitMappingNodes).
 *  Chunked at IN_CHUNK. */
export async function existingNodeIds(
  admin: Admin,
  ids: readonly string[],
): Promise<{ ok: true; ids: Set<string> } | { ok: false; error: { code?: string; message: string } }> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await admin.from("curriculum_nodes").select("id").in("id", ids.slice(i, i + IN_CHUNK));
    if (error) return { ok: false, error };
    for (const r of (data ?? []) as { id: string }[]) found.add(r.id);
  }
  return { ok: true, ids: found };
}

/** Map one topic to every node in `nodeIds` in ONE round trip: an upsert on
 *  unique(topic_id, node_id) with ignoreDuplicates, so an existing pair is left
 *  as it is (its coverage is not overwritten) and `created` counts the rows
 *  RETURNING gave back (the timetable generator's fill mode does the same). A
 *  node deleted between the caller's existingNodeIds() and this write fails the
 *  whole statement with 23503; that race falls back to attachMappings, which
 *  skips the vanished node and maps the rest. */
export async function upsertMappings(
  admin: Admin,
  topicId: string,
  nodeIds: readonly string[],
  coverage: Coverage,
  notes: string | null = null,
): Promise<{ ok: true; created: number; existing: number; missing: string[] } | { ok: false; error: { code?: string; message: string } }> {
  const ids = [...new Set(nodeIds)];
  if (!ids.length) return { ok: true, created: 0, existing: 0, missing: [] };
  const { data, error } = await admin
    .from("topic_curriculum_map")
    .upsert(
      ids.map((node_id) => ({ topic_id: topicId, node_id, coverage, notes })),
      { onConflict: "topic_id,node_id", ignoreDuplicates: true },
    )
    .select("id");
  if (error) {
    if (error.code === "23503") {
      const r = await attachMappings(admin, topicId, ids, coverage, notes);
      return r.ok ? r : { ok: false, error: r.error };
    }
    return { ok: false, error };
  }
  const created = data?.length ?? 0;
  return { ok: true, created, existing: ids.length - created, missing: [] };
}

/** Every mutation lands in platform_audit_log as library_<verb>. Audit
 *  failures are swallowed: the action already happened, and a missing audit
 *  row must not read back to the member as a failed action. */
export async function audit(
  admin: Admin,
  actorId: string,
  verb: string,
  // 'blueprint' (Phase 3): a question_set_blueprints row, audited by the
  // blueprints route — the only target that is not a topic or taxonomy row.
  targetKind: "topic" | "candidate" | "book" | "curriculum_node" | "curriculum" | "blueprint",
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
 *  pair is left as it is (its coverage is not overwritten). A node that no
 *  longer exists (23503 — deleted since the caller planned the mapping) is
 *  `missing`, not an error: nothing was written, and the caller must not fail
 *  a whole create — or orphan a half-made topic — over an objective somebody
 *  removed. (The table's only other foreign key is topic_id; a topic gone
 *  under us means there is nothing to map onto either way.) */
export async function attachMapping(
  admin: Admin,
  topicId: string,
  nodeId: string,
  coverage: Coverage,
  notes: string | null = null,
): Promise<{ ok: true; created: boolean; missing?: true } | { ok: false; error: { code?: string; message: string } }> {
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
    if (error.code === "23503") return { ok: true, created: false, missing: true };
    return { ok: false, error };
  }
  return { ok: true, created: true };
}

type DbErr = { code?: string; message: string };
type OwnerResult = { ok: true; owner: KeyOwner | null } | { ok: false; error: DbErr };

const OWNER_COLUMNS = "id, title, status";

async function topicById(admin: Admin, id: string): Promise<{ row: OwnerRow | null; error: DbErr | null }> {
  const { data, error } = await admin.from("topics").select(OWNER_COLUMNS).eq("id", id).maybeSingle();
  return { row: (data as OwnerRow | null) ?? null, error };
}

/** The topic an alias resolves to (the alias row's topic_id, then that topic), or null. */
async function aliasOwner(admin: Admin, normalized: string): Promise<{ row: OwnerRow | null; error: DbErr | null }> {
  const { data: alias, error } = await admin.from("topic_aliases").select("topic_id").eq("normalized", normalized).maybeSingle();
  if (error) return { row: null, error };
  if (!alias?.topic_id) return { row: null, error: null };
  return topicById(admin, alias.topic_id as string);
}

/** Who holds `key` — as a canonical_key (topics) or as an alias (topic_aliases,
 *  resolved to its topic) — with the live-over-retired preference of
 *  pickKeyOwner. One query each; a retired key holder costs one more to follow
 *  its title alias to wherever it was merged. null: nobody holds it. */
export async function keyOwner(admin: Admin, key: string): Promise<OwnerResult> {
  const { data: byKey, error: kErr } = await admin.from("topics").select(OWNER_COLUMNS).eq("canonical_key", key).maybeSingle();
  if (kErr) return { ok: false, error: kErr };
  const { row: byAlias, error: aErr } = await aliasOwner(admin, key);
  if (aErr) return { ok: false, error: aErr };
  let byTitleAlias: OwnerRow | null = null;
  const holder = (byKey as OwnerRow | null) ?? null;
  if (holder && holder.status === "retired" && !(byAlias && byAlias.status !== "retired")) {
    const titleKey = canonicalKey(holder.title);
    if (titleKey && titleKey !== key) {
      const { row, error } = await aliasOwner(admin, titleKey);
      if (error) return { ok: false, error };
      byTitleAlias = row;
    }
  }
  return { ok: true, owner: pickKeyOwner(holder, byAlias, byTitleAlias) };
}

/** Insert a topic, answering with the owner when the canonical key is already
 *  held — as somebody's canonical_key OR as somebody's alias (the caller
 *  answers 409 via keyTaken and offers "merge instead"). The check runs BEFORE
 *  the insert; the unique index is the backstop for a race, and a 23505 is
 *  read back the same way. */
export async function insertTopic(
  admin: Admin,
  topic: { canonical_key: string; title: string; subject: string | null; summary?: string | null; status: "candidate"; created_by: string | null },
): Promise<{ ok: true; id: string } | { ok: false; existingId: string; owner: KeyOwner } | { ok: false; error: DbErr }> {
  const held = await keyOwner(admin, topic.canonical_key);
  if (!held.ok) return held;
  if (held.owner) return { ok: false, existingId: held.owner.topicId, owner: held.owner };
  const { data, error } = await admin.from("topics").insert(topic).select("id").single();
  if (error) {
    if (error.code === "23505") {
      const again = await keyOwner(admin, topic.canonical_key);
      if (again.ok && again.owner) return { ok: false, existingId: again.owner.topicId, owner: again.owner };
    }
    return { ok: false, error };
  }
  return { ok: true, id: data.id as string };
}

/** Undo a topic insert whose follow-up (alias, mapping) could not be made, so a
 *  refused request leaves no half-made topic behind. Aliases and mappings go
 *  with it (on delete cascade). Best effort: the refusal is answered either
 *  way, and an orphan is visible on /library/topics where a lost 409 is not. */
export async function rollbackTopic(admin: Admin, id: string): Promise<void> {
  try {
    await admin.from("topics").delete().eq("id", id).eq("status", "candidate");
  } catch {
    // see above
  }
}
