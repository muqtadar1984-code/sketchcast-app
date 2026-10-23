import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { isAgentAction, runOnceAccepts, utcDay, type AgentSettings, type Round } from "@/utils/catalogue/pinterest";
import { audit, bad, conflict, dbError, notFound, readJson } from "../../lib";

export const runtime = "nodejs";

// The Pinterest agent's Library controls (migration 0154). Admins only
// (`publish`). THIS ROUTE NEVER POSTS: it flips the settings row the worker
// reads every tick, or asks the worker for one extra round.
//
//   run_once       "Run once more": one extra round now — up to
//                  per_language_per_day more pins per language, one at a time
//   pause / resume platform_settings pinterest_agent.paused
//   clear_breaker  after the worker tripped it (repeated failures, a 401/403
//                  from Pinterest): the founder has looked and lets it go on
//
// Switching the agent on, and dry run off, is deliberately NOT here: those are
// the founder's go-live steps (build plan §6), done in the settings row with
// an audit, not by a button.

type Body = { action?: unknown };

const SETTINGS_KEY = "pinterest_agent";

const tableMissing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || /pinterest_(pins|publish_rounds)/.test(e.message ?? ""));

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
  if (!settingsQ.data) return conflict("The Pinterest engine needs migration 0154 — apply it first.", { migration: "0154_pinterest_pin_engine.sql" });
  const settings = ((settingsQ.data.value ?? {}) as AgentSettings) || {};
  const now = new Date().toISOString();

  const save = async (value: AgentSettings) =>
    admin.from("platform_settings").upsert({ key: SETTINGS_KEY, value, updated_at: now }, { onConflict: "key" });

  if (action === "pause" || action === "resume") {
    const value: AgentSettings = { ...settings, paused: action === "pause" };
    const up = await save(value);
    if (up.error) return dbError(up.error);
    await audit(admin, m.id, `pinterest_agent_${action}`, "platform_setting", null, { key: SETTINGS_KEY, paused: value.paused });
    return NextResponse.json({ ok: true, action, settings: value });
  }

  if (action === "clear_breaker") {
    if (!settings.breaker?.tripped) return conflict("The breaker is not tripped.");
    const value: AgentSettings = { ...settings, breaker: { tripped: false, failures: 0 } };
    const up = await save(value);
    if (up.error) return dbError(up.error);
    await audit(admin, m.id, "pinterest_agent_clear_breaker", "platform_setting", null, { key: SETTINGS_KEY, was: settings.breaker });
    return NextResponse.json({ ok: true, action, settings: value });
  }

  // run_once
  const [roundQ, approvedQ] = await Promise.all([
    admin.from("pinterest_publish_rounds").select("id, status").in("status", ["requested", "running"]).limit(1).maybeSingle(),
    admin.from("pinterest_pins").select("id", { count: "exact", head: true }).eq("status", "approved"),
  ]);
  if (tableMissing(roundQ.error) || tableMissing(approvedQ.error)) return conflict("The Pinterest engine needs migration 0154 — apply it first.");
  if (roundQ.error) return dbError(roundQ.error);
  if (approvedQ.error) return dbError(approvedQ.error);
  const accepts = runOnceAccepts((roundQ.data as Pick<Round, "status"> | null) ?? null, approvedQ.count ?? 0, settings);
  if (!accepts.ok) return conflict(accepts.why);
  const ins = await admin
    .from("pinterest_publish_rounds")
    .insert({ trigger: "manual", day: utcDay(Date.now()), status: "requested", requested_by: m.id })
    .select("id")
    .single();
  if (ins.error) {
    if (ins.error.code === "23505") return conflict("A round is already in progress — it posts one pin at a time.");
    return dbError(ins.error);
  }
  await audit(admin, m.id, "pinterest_agent_run_once", "platform_setting", null, { key: SETTINGS_KEY, round_id: ins.data.id, dry_run: settings.dry_run !== false });
  return NextResponse.json({ ok: true, action, roundId: ins.data.id });
}
