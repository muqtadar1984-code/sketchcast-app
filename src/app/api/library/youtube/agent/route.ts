import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { buildVideoRows } from "@/utils/catalogue/youtube-videos";
import {
  OPEN_STATUSES,
  isAgentAction,
  planQueue,
  quotaDay,
  runOnceAccepts,
  type AgentSettings,
  type QueueItem,
  type Round,
} from "@/utils/catalogue/youtube-agent";
import { loadTranslatedVideos } from "@/app/library/translations/youtube/load";
import { audit, bad, conflict, dbError, notFound, readJson, uuid } from "../../lib";

export const runtime = "nodejs";

// The YouTube Publishing Agent's Library controls (Bulk YouTube Posting plan
// §2.5 / §3, migration 0150). Admins only (`publish`). THIS ROUTE NEVER
// POSTS: it writes the queue and the rounds; the worker (sketchcast-ai
// catalogue/publish_agent.py) turns one queued kit per language per day into
// an ordinary topic_publish job, with every gate of a single post.
//
//   preview  {kitIds}   what `add` would do — writes nothing
//   add      {kitIds}   queue the postable ones (selectableForPost, the view's
//                       one rule), oldest first per language
//   remove   {itemIds}  take waiting items out (pending or selected)
//   run_once            "Run once more": one extra round now — one more video
//                       per language, one at a time (founder 2026-10-21)
//   pause / resume      platform_settings youtube_publish_agent.paused
//
// One platform_audit_log row per change.

type Body = { action?: unknown; kitIds?: unknown; itemIds?: unknown };

const SETTINGS_KEY = "youtube_publish_agent";
const MIGRATION = "0150_youtube_publish_agent.sql";

const tableMissing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || /youtube_publish_(queue|rounds)/.test(e.message ?? ""));
const needsMigration = () =>
  conflict("The YouTube publish agent needs migration 0150 — apply it first.", { migration: MIGRATION });

const ids = (v: unknown, max: number): string[] | null => {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) return null;
  const out = v.map(uuid);
  return out.every((x): x is string => !!x) ? [...new Set(out)] : null;
};

export async function POST(request: Request) {
  const m = await isLibraryMemberRequest("publish");
  if (!m) return notFound();
  const body = await readJson<Body>(request);
  if (!body) return bad("Invalid JSON.");
  if (!isAgentAction(body.action)) return bad("Unknown action.");
  const action = body.action;
  const admin = createAdminClient();

  const settingsQ = await admin.from("platform_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
  if (settingsQ.error) return dbError(settingsQ.error);
  const settings = ((settingsQ.data?.value ?? {}) as AgentSettings) || {};

  if (action === "pause" || action === "resume") {
    const now = new Date().toISOString();
    const value: AgentSettings = { ...settings, paused: action === "pause" };
    const up = await admin.from("platform_settings").upsert({ key: SETTINGS_KEY, value, updated_at: now }, { onConflict: "key" });
    if (up.error) return dbError(up.error);
    await audit(admin, m.id, `youtube_agent_${action}`, "platform_setting", null, { key: SETTINGS_KEY, paused: value.paused });
    return NextResponse.json({ ok: true, action, settings: value });
  }

  const openQ = await admin.from("youtube_publish_queue").select("id, kit_id, language, status").in("status", [...OPEN_STATUSES]);
  if (tableMissing(openQ.error)) return needsMigration();
  if (openQ.error) return dbError(openQ.error);
  const open = (openQ.data ?? []) as Pick<QueueItem, "id" | "kit_id" | "language" | "status">[];

  if (action === "run_once") {
    const roundQ = await admin.from("youtube_publish_rounds").select("id, status").in("status", ["requested", "running"]).limit(1).maybeSingle();
    if (roundQ.error) return dbError(roundQ.error);
    const pending = open.filter((o) => o.status === "pending").length;
    const accepts = runOnceAccepts((roundQ.data as Round | null) ?? null, pending, !!settings.paused);
    if (!accepts.ok) return conflict(accepts.why);
    const ins = await admin
      .from("youtube_publish_rounds")
      .insert({ trigger: "manual", quota_day: quotaDay(Date.now()), status: "requested", requested_by: m.id })
      .select("id")
      .single();
    if (ins.error) {
      if (ins.error.code === "23505") return conflict("A round is already in progress — it posts one video per language, one at a time.");
      return dbError(ins.error);
    }
    const languages = [...new Set(open.filter((o) => o.status === "pending").map((o) => o.language))].sort();
    await audit(admin, m.id, "youtube_agent_run_once", "translations", null, { round_id: ins.data.id, languages });
    return NextResponse.json({ ok: true, action, roundId: ins.data.id, languages });
  }

  if (action === "remove") {
    const itemIds = ids(body.itemIds, 1000);
    if (!itemIds) return bad("itemIds must be a non-empty list of ids.");
    const up = await admin
      .from("youtube_publish_queue")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .in("id", itemIds)
      .in("status", ["pending", "selected"])
      .select("id, kit_id, language");
    if (up.error) return dbError(up.error);
    await audit(admin, m.id, "youtube_queue_remove", "translations", null, { items: up.data ?? [] });
    return NextResponse.json({ ok: true, action, removed: (up.data ?? []).length });
  }

  // preview / add — the same plan; add then writes it
  const kitIds = ids(body.kitIds, 2000);
  if (!kitIds) return bad("kitIds must be a non-empty list of kit ids.");
  const load = await loadTranslatedVideos(admin);
  if (!load.ok) return NextResponse.json({ error: load.error }, { status: 500 });
  const plan = planQueue(buildVideoRows(load.input), kitIds, open);
  if (action === "preview") return NextResponse.json({ ok: true, action, plan });

  if (plan.accepted.length === 0) return conflict("None of the selected translations can be queued.", { plan });
  const now = new Date().toISOString();
  const rows = plan.accepted.map((a, i) => ({
    kit_id: a.kitId,
    topic_id: a.topicId,
    language: a.language,
    added_by: m.id,
    // one timestamp per row, in selection order, so "oldest first" is the order shown
    added_at: new Date(Date.parse(now) + i).toISOString(),
  }));
  const ins = await admin.from("youtube_publish_queue").insert(rows).select("id");
  if (ins.error) {
    if (ins.error.code === "23505") return conflict("Some of these were queued a moment ago by someone else — reload and try again.");
    return dbError(ins.error);
  }
  await audit(admin, m.id, "youtube_queue_add", "translations", null, {
    count: rows.length,
    kit_ids: rows.map((r) => r.kit_id),
    per_language: plan.perLanguage,
  });
  return NextResponse.json({ ok: true, action, added: (ins.data ?? []).length, plan });
}
