import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isPlatformAdminRequest } from "@/utils/platform-admin";
import { duplicatesToCancel, type GenRow } from "@/utils/console-queue";

export const runtime = "nodejs";

// Queue controls for /console/queue (surge plan §4.2–4.4, Phase 2; staff only).
//   cancel            QUEUED generations in scope → deleted, credit refunded by
//                     credit_ledger_void_unconsumed (the teacher's own ✕ path)
//   stop              as cancel, PLUS a stop request on every PROCESSING build
//                     in scope (jobs.cancel_requested_at): the worker aborts at
//                     its next progress write; credit voided 'staff_cancel'
//   cancel_duplicates one book: every unit+kind with more than one non-failed
//                     kit keeps its OLDEST and cancels the queued rest
//   hold / release    queue_holds on an owner, a book, or one owner's book —
//                     claim_fair_job skips held work; holds expire (default 24 h)
// Scope = explicit generationIds, or ownerId and/or bookId. Every action is
// audited in platform_audit_log (the cancel RPC audits each row itself).
// Everything here needs migration 0153; before it, the RPCs 404 and the route
// says so.

type Body = {
  action?: "cancel" | "stop" | "cancel_duplicates" | "hold" | "release";
  generationIds?: string[];
  ownerId?: string;
  bookId?: string;
  hours?: number;
  reason?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export async function POST(request: Request) {
  const staff = await isPlatformAdminRequest();
  if (!staff) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const { action } = body;
  const ownerId = isId(body.ownerId) ? body.ownerId : undefined;
  const bookId = isId(body.bookId) ? body.bookId : undefined;
  const reason = (body.reason ?? "").toString().slice(0, 300) || `console: ${action}`;
  const admin = createAdminClient();

  if (action === "hold" || action === "release") {
    if (!ownerId && !bookId) return NextResponse.json({ error: "ownerId or bookId is required." }, { status: 400 });
    if (action === "hold") {
      const hours = Math.min(168, Math.max(1, Number(body.hours) || 24));
      const { error } = await admin.from("queue_holds").insert({
        owner_id: ownerId ?? null,
        book_id: bookId ?? null,
        reason,
        created_by: staff.id,
        until: new Date(Date.now() + hours * 3600_000).toISOString(),
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    } else {
      let q = admin.from("queue_holds").update({ released_at: new Date().toISOString() }).is("released_at", null);
      q = ownerId ? q.eq("owner_id", ownerId) : q.is("owner_id", null);
      q = bookId ? q.eq("book_id", bookId) : q.is("book_id", null);
      const { error } = await q;
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    await admin.from("platform_audit_log").insert({
      actor_id: staff.id,
      action: `queue:${action}`,
      target_kind: ownerId ? "user" : "book",
      target_id: ownerId ?? bookId,
      detail: { owner_id: ownerId ?? null, book_id: bookId ?? null, reason },
    });
    return NextResponse.json({ ok: true });
  }

  if (action !== "cancel" && action !== "stop" && action !== "cancel_duplicates") {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  let ids: string[] = [];
  if (action === "cancel_duplicates") {
    if (!bookId) return NextResponse.json({ error: "bookId is required." }, { status: 400 });
    let q = admin
      .from("generations")
      .select("id, kind, status, chapter_ref, params, created_at")
      .eq("book_id", bookId)
      .is("removed_at", null)
      .limit(5000);
    if (ownerId) q = q.eq("owner_id", ownerId);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const rows: GenRow[] = ((data ?? []) as { id: string; kind: string; status: string; chapter_ref: string | null; params: { part?: unknown; revision?: unknown } | null; created_at: string }[])
      .filter((g) => g.params?.revision !== true)
      .map((g) => ({
        id: g.id,
        kind: g.kind,
        status: g.status,
        chapter_ref: g.chapter_ref,
        part: typeof g.params?.part === "number" ? g.params.part : null,
        created_at: g.created_at,
      }));
    ids = duplicatesToCancel(rows);
  } else if (Array.isArray(body.generationIds) && body.generationIds.length) {
    ids = body.generationIds.filter(isId).slice(0, 2000);
  } else {
    if (!ownerId && !bookId) return NextResponse.json({ error: "A scope is required." }, { status: 400 });
    let q = admin
      .from("generations")
      .select("id")
      .in("status", action === "stop" ? ["queued", "processing"] : ["queued"])
      .limit(5000);
    if (ownerId) q = q.eq("owner_id", ownerId);
    if (bookId) q = q.eq("book_id", bookId);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
  }

  if (!ids.length) return NextResponse.json({ cancelled: 0, refunded: 0, stopping: 0, running_left: 0 });

  const { data, error } = await admin.rpc("staff_cancel_generations", {
    p_ids: ids,
    p_actor: staff.id,
    p_reason: reason,
    p_stop_running: action === "stop",
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
