import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { canonicalKey } from "@/utils/catalogue/key";
import { searchOr } from "@/utils/catalogue/status";
import type { TopicHit } from "@/utils/catalogue/types";
import { attachAlias, audit, bad, dbError, insertTopic, notFound, readJson, text } from "../lib";

export const runtime = "nodejs";

// Topics collection.
//   GET  ?q=&limit=&all=1  — the topic-search picker (any member). Retired
//                            topics are hidden unless all=1.
//   POST {title, subject?, summary?} — "New topic" (curate). The title becomes
//                            the canonical key AND a manual alias, so the
//                            harvester can find it by name from day one.
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
    // the topic keyed "cell".
    const key = canonicalKey(q);
    const clauses = [searchOr(q, ["title"]), key ? `canonical_key.ilike.%${key}%` : null].filter(Boolean);
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
    if ("existingId" in created) {
      return NextResponse.json(
        { error: `A topic with the key "${key}" already exists.`, existingId: created.existingId },
        { status: 409 },
      );
    }
    return dbError(created.error);
  }
  const alias = await attachAlias(admin, created.id, title, key, "manual");
  await audit(admin, m.id, "topic_create", "topic", created.id, {
    title,
    canonical_key: key,
    subject,
    alias: alias.ok ? (alias.created ? "created" : "existing") : "conflict",
  });
  return NextResponse.json({ ok: true, id: created.id });
}
