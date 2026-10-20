import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { controlPatch, isAgentControl, type AutoTranslateSettings } from "@/utils/catalogue/auto-translate";
import { audit, bad, conflict, dbError, notFound, readJson } from "../../lib";

export const runtime = "nodejs";

// The Auto Translate Agent's buttons (plan §6.1): On / Off, Pause / Resume,
// Go live / Dry run. Each MERGES a few keys into platform_settings
// 'auto_translate' (migration 0147) — the worker reads the row every minute,
// so a button takes effect within a tick, with no redeploy. Admins only
// (`publish`, the Library's admin-only action): the agent spends money and
// puts kits in front of reviewers. One platform_audit_log row per press.
//
// Pause is the founder's development/testing hold. Off and Pause both leave
// the one translation in flight to finish; stopping THAT kit is the existing
// reject / × path. Resume also clears a tripped breaker.

type Body = { action?: unknown };

export async function POST(request: Request) {
  const m = await isLibraryMemberRequest("publish");
  if (!m) return notFound();
  const body = await readJson<Body>(request);
  if (!body) return bad("Invalid JSON.");
  if (!isAgentControl(body.action)) return bad("Unknown action.");
  const action = body.action;
  const admin = createAdminClient();

  const { data, error } = await admin.from("platform_settings").select("value").eq("key", "auto_translate").maybeSingle();
  if (error) return dbError(error);
  if (!data) return conflict("The Auto Translate Agent needs migration 0147 — apply it first.", { migration: "0147_auto_translate_agent.sql" });

  const now = new Date().toISOString();
  const patch = controlPatch(action, now);
  const value: AutoTranslateSettings = { ...((data.value ?? {}) as AutoTranslateSettings), ...patch };
  const up = await admin.from("platform_settings").update({ value, updated_at: now }).eq("key", "auto_translate");
  if (up.error) return dbError(up.error);
  await audit(admin, m.id, `auto_translate_${action}`, "platform_setting", null, { key: "auto_translate", patch });
  return NextResponse.json({ ok: true, action, settings: value });
}
