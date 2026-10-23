import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import {
  canApprove,
  canReject,
  canRerender,
  canRetry,
  editPatch,
  isPinAction,
  LIMITS,
  type Pin,
} from "@/utils/catalogue/pinterest";
import { audit, bad, conflict, dbError, notFound, readJson, text, uuid } from "../../lib";

export const runtime = "nodejs";

// One pin at a time (Pinterest Pin Engine, migration 0154). Platform admins
// only (`publish`). Pinterest's Developer Guidelines require that the user
// "choose each Pin to be published", so every action here takes exactly ONE
// pin id — there is deliberately no list form and no approve-all (decision
// D1). THIS ROUTE NEVER POSTS: the worker posts approved pins in its rounds
// and re-checks every gate first.
//
//   approve   {pinId}                          in_review → approved
//   reject    {pinId, reason}                  → rejected (reason kept for the drafts)
//   edit      {pinId, title?, description?, alt_text?}
//                                              → back to in_review, prechecks cleared
//   rerender  {pinId}                          → draft (the worker redraws it)
//   retry     {pinId}                          failed → approved (attempts reset)
//
// Every write is conditional on the status the rule saw, so two admins
// clicking at once cannot both succeed; one platform_audit_log row per change.

type Body = { action?: unknown; pinId?: unknown; reason?: unknown; title?: unknown; description?: unknown; alt_text?: unknown };

const COLUMNS =
  "id, status, precheck, images, board_id, link, title, description, alt_text, pinterest_pin_id, approved_at, language, topic_id, template, updated_at";

const tableMissing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || /pinterest_pins/.test(e.message ?? ""));

export async function POST(request: Request) {
  const m = await isLibraryMemberRequest("publish");
  if (!m) return notFound();
  const body = await readJson<Body>(request);
  if (!body) return bad("Invalid JSON.");
  if (!isPinAction(body.action)) return bad("Unknown action.");
  const pinId = uuid(body.pinId);
  if (!pinId) return bad("pinId must be one pin id.");
  const action = body.action;
  const admin = createAdminClient();

  const got = await admin.from("pinterest_pins").select(COLUMNS).eq("id", pinId).maybeSingle();
  if (tableMissing(got.error)) return conflict("The Pinterest engine needs migration 0154 — apply it first.", { migration: "0154_pinterest_pin_engine.sql" });
  if (got.error) return dbError(got.error);
  if (!got.data) return notFound();
  const pin = got.data as unknown as Pin;
  const now = new Date().toISOString();
  const ctx = { language: pin.language, topic_id: pin.topic_id, template: pin.template };

  // update only if the row is still exactly what the rule saw: the same status
  // AND the same updated_at — an edit (or the worker's re-check) keeps the
  // status but moves updated_at, so an approve decided on the old copy fails
  const write = async (patch: Record<string, unknown>) => {
    const up = await admin
      .from("pinterest_pins")
      .update({ ...patch, updated_at: now })
      .eq("id", pinId)
      .eq("status", pin.status)
      .eq("updated_at", pin.updated_at)
      .select("id, status")
      .maybeSingle();
    if (up.error) return { error: dbError(up.error) };
    if (!up.data) return { error: conflict("This pin changed a moment ago — reload and look again.") };
    return { row: up.data as { id: string; status: string } };
  };

  if (action === "approve") {
    const can = canApprove(pin);
    if (!can.ok) return conflict(can.why);
    const r = await write({ status: "approved", approved_by: m.id, approved_at: now });
    if (r.error) return r.error;
    await audit(admin, m.id, "pin_approve", "pinterest_pin", pinId, { ...ctx, title: pin.title, link: pin.link });
    return NextResponse.json({ ok: true, action, pin: r.row });
  }

  if (action === "reject") {
    const reason = text(body.reason, LIMITS.reject_reason + 1);
    const can = canReject(pin, reason);
    if (!can.ok) return conflict(can.why);
    const r = await write({ status: "rejected", reject_reason: reason, approved_by: null, approved_at: null });
    if (r.error) return r.error;
    await audit(admin, m.id, "pin_reject", "pinterest_pin", pinId, { ...ctx, reason });
    return NextResponse.json({ ok: true, action, pin: r.row });
  }

  if (action === "edit") {
    const e = editPatch(pin, { title: body.title, description: body.description, alt_text: body.alt_text });
    if (!e.ok) return conflict(e.why);
    const r = await write(e.patch);
    if (r.error) return r.error;
    await audit(admin, m.id, "pin_edit", "pinterest_pin", pinId, {
      ...ctx,
      before: { title: pin.title, description: pin.description, alt_text: pin.alt_text },
      after: { title: e.patch.title, description: e.patch.description, alt_text: e.patch.alt_text },
    });
    return NextResponse.json({ ok: true, action, pin: r.row });
  }

  if (action === "rerender") {
    const can = canRerender(pin);
    if (!can.ok) return conflict(can.why);
    const r = await write({
      status: "draft",
      approved_by: null,
      approved_at: null,
      reject_reason: null,
      precheck: {},
      content_hash: null,
      last_error: null,
      edited: false,
      attempts: 0,
      round_id: null,
    });
    if (r.error) return r.error;
    await audit(admin, m.id, "pin_rerender", "pinterest_pin", pinId, ctx);
    return NextResponse.json({ ok: true, action, pin: r.row });
  }

  // retry: a pin that failed while POSTING goes back to approved, so the next
  // round may pick it again; the worker's attempts start over. post_token is
  // kept: if an earlier attempt reached Pinterest, the worker adopts that pin
  // instead of posting a second one.
  const can = canRetry(pin);
  if (!can.ok) return conflict(can.why);
  const r = await write({ status: "approved", attempts: 0, last_error: null, round_id: null, approved_by: m.id, approved_at: now });
  if (r.error) return r.error;
  await audit(admin, m.id, "pin_retry", "pinterest_pin", pinId, ctx);
  return NextResponse.json({ ok: true, action, pin: r.row });
}
