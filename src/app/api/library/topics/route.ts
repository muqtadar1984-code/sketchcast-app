import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { canonicalKey } from "@/utils/catalogue/key";
import { escapeLike, searchOr } from "@/utils/catalogue/status";
import type { TopicHit } from "@/utils/catalogue/types";
import { attachAlias, audit, bad, dbError, insertTopic, keyOwner, keyTaken, notFound, readJson, rollbackTopic, text } from "../lib";

export const runtime = "nodejs";

// Topics collection.
//   GET  ?q=&limit=&all=1  — the topic-search picker (any member). Retired
//                            topics are hidden unless all=1.
//   POST {title, subject?, summary?} — "New topic" (curate). The title becomes
//                            the canonical key AND a manual alias, so the
//                            harvester can find it by name from day one. A key
//                            somebody already holds — as their canonical_key or
//                            as one of their aliases — is refused with 409
//                            naming that topic (existingId), BEFORE anything is
//                            written; a topic merged away is followed to the
//                            live topic that now holds its name.
// Non-members (and reviewers on POST) get 404: the portal is not probeable.

type CreateBody = { title?: unknown; subject?: unknown; summary?: unknown };

export async function GET(request: Request) {
  const m = await isLibraryMemberRequest();
  if (!m) return notFound();

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, rawLimit)) : 20;
  const all = url.searchParams.get("all") === "1";

  const admin = createAdminClient();
  let query = admin
    .from("topics")
    .select("id, title, subject, status, canonical_key")
    .order("title", { ascending: true })
    .limit(limit);
  if (!all) query = query.neq("status", "retired");
  if (q) {
    // Match the display title OR the key of what was typed, so "Cells" finds
    // the topic keyed "cell". Keys are full of `_`, a LIKE wildcard: escaped.
    const key = canonicalKey(q);
    const clauses = [searchOr(q, ["title"]), key ? `canonical_key.ilike.%${escapeLike(key)}%` : null].filter(Boolean);
    if (clauses.length) query = query.or(clauses.join(","));
  }
  const { data, error } = await query;
  if (error) return dbError(error);
  return NextResponse.json({ topics: (data ?? []) as TopicHit[] });
}

export async function POST(request: Request) {
  const m = await isLibraryMemberRequest("curate");
  if (!m) return notFound();

  const body = await readJson<CreateBody>(request);
  if (!body) return bad("Invalid JSON.");
  const title = text(body.title, 120);
  const subject = text(body.subject, 60) || null;
  const summary = text(body.summary, 2000) || null;
  if (!title) return bad("title is required.");
  const key = canonicalKey(title);
  if (!key) return bad("The title has no Latin letters or digits, so it has no canonical key. Use an English working title.");

  const admin = createAdminClient();
  const created = await insertTopic(admin, {
    canonical_key: key,
    title,
    subject,
    summary,
    status: "candidate",
    created_by: m.id,
  });
  if (!created.ok) {
    if ("existingId" in created) return keyTaken(key, created.owner, "open it, or pick another title.");
    return dbError(created.error);
  }
  const alias = await attachAlias(admin, created.id, title, key, "manual");
  if (!alias.ok) {
    // insertTopic checked the aliases too, so this is a race lost between the
    // check and the insert: take the topic back out and refuse, rather than
    // answer 200 for a topic the harvester could never find by name.
    await rollbackTopic(admin, created.id);
    if ("conflictTopicId" in alias) {
      const held = await keyOwner(admin, key);
      if (held.ok && held.owner) return keyTaken(key, held.owner, "open it, or pick another title.");
      return NextResponse.json({ error: `"${title}" is already an alias of another topic.`, existingId: alias.conflictTopicId }, { status: 409 });
    }
    return dbError(alias.error);
  }
  await audit(admin, m.id, "topic_create", "topic", created.id, {
    title,
    canonical_key: key,
    subject,
    alias: alias.created ? "created" : "existing",
  });
  return NextResponse.json({ ok: true, id: created.id });
}
