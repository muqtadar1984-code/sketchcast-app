import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { founderEmails, isPlatformAdminRequest } from "@/utils/platform-admin";

export const runtime = "nodejs";

// Ops controls (staff only, every action audited):
//   suspend / unsuspend  — profiles.suspended_at (RLS cutoff for live tokens)
//                          + Supabase auth ban (blocks new logins)
//   set_caps             — per-teacher overrides of the 0011/0016 caps
//   takedown / restore   — soft-delete a book or generation (recoverable)
//   admin_grant / admin_revoke — platform_admins membership (FOUNDERS only)
// Non-staff get 404 (the console isn't probeable). Self/staff targets are
// refused for destructive actions (footgun guard).

type Body = {
  action?: "suspend" | "unsuspend" | "set_caps" | "takedown" | "restore" | "admin_grant" | "admin_revoke";
  targetId?: string;               // profile id, or book/generation id for takedown
  targetKind?: "book" | "generation"; // takedown/restore only
  maxBooks?: number | null;
  maxChapters?: number | null;
  maxStudents?: number | null;
  maxChildren?: number | null;
  note?: string;
};

function capVal(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 100000 ? n : undefined;
}

export async function POST(request: Request) {
  const staff = await isPlatformAdminRequest();
  if (!staff) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const targetId = (body.targetId ?? "").trim();
  if (!targetId) return NextResponse.json({ error: "targetId is required." }, { status: 400 });

  const admin = createAdminClient();

  const audit = async (action: string, targetKind: string, detail: Record<string, unknown>) => {
    await admin.from("platform_audit_log").insert({
      actor_id: staff.id,
      action,
      target_kind: targetKind,
      target_id: targetId,
      detail: body.note ? { ...detail, note: body.note } : detail,
    });
  };

  // ── Profile-targeted actions ────────────────────────────────────────────────
  if (body.action === "suspend" || body.action === "unsuspend" || body.action === "set_caps") {
    const { data: target } = await admin
      .from("profiles")
      .select("*")
      .eq("id", targetId)
      .maybeSingle();
    if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });

    if (body.action === "suspend" || body.action === "unsuspend") {
      // Footgun guard: never against yourself or another staff account.
      if (targetId === staff.id) {
        return NextResponse.json({ error: "You can't suspend yourself." }, { status: 400 });
      }
      let targetEmail = "";
      try {
        const { data: u } = await admin.auth.admin.getUserById(targetId);
        targetEmail = (u?.user?.email ?? "").toLowerCase();
      } catch {
        // proceed with profile-only knowledge
      }
      const { data: staffRow } = await admin
        .from("platform_admins")
        .select("user_id")
        .eq("user_id", targetId)
        .is("revoked_at", null)
        .maybeSingle();
      if (staffRow || founderEmails().includes(targetEmail)) {
        return NextResponse.json({ error: "Target is platform staff — revoke that first." }, { status: 400 });
      }

      const suspending = body.action === "suspend";
      const { error: pErr } = await admin
        .from("profiles")
        .update({ suspended_at: suspending ? new Date().toISOString() : null })
        .eq("id", targetId);
      if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });
      try {
        await admin.auth.admin.updateUserById(targetId, {
          ban_duration: suspending ? "87600h" : "none",
        });
      } catch (e) {
        // RLS cutoff already holds; surface the partial state instead of hiding it
        await audit(body.action, "profile", { warning: `auth ban failed: ${(e as Error).message}` });
        return NextResponse.json(
          { ok: true, warning: "Data access updated, but the login ban could not be set — retry." },
        );
      }
      await audit(body.action, "profile", { was_suspended: !!target.suspended_at });
      return NextResponse.json({ ok: true });
    }

    // set_caps
    const patch: Record<string, number | null> = {};
    const mb = capVal(body.maxBooks);
    const mc = capVal(body.maxChapters);
    const ms = capVal(body.maxStudents);
    const mk = capVal(body.maxChildren);
    if (mb !== undefined) patch.max_books = mb;
    if (mc !== undefined) patch.max_chapters = mc;
    if (ms !== undefined) patch.max_students = ms;
    if (mk !== undefined) patch.max_children = mk;
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "No valid caps given (0–100000 or null)." }, { status: 400 });
    }
    const { error: cErr } = await admin.from("profiles").update(patch).eq("id", targetId);
    if (cErr) {
      const msg = cErr.message.includes("max_books") || cErr.message.includes("column")
        ? "Cap columns missing — run migration 0016 first."
        : cErr.message;
      return NextResponse.json({ error: msg }, { status: 500 });
    }
    await audit("cap_override", "profile", {
      before: {
        max_books: target.max_books ?? null,
        max_chapters: target.max_chapters ?? null,
        max_students: target.max_students ?? null,
        max_children: target.max_children ?? null,
      },
      after: patch,
    });
    return NextResponse.json({ ok: true });
  }

  // ── Content takedown / restore ──────────────────────────────────────────────
  if (body.action === "takedown" || body.action === "restore") {
    const kind = body.targetKind;
    if (kind !== "book" && kind !== "generation") {
      return NextResponse.json({ error: "targetKind must be book or generation." }, { status: 400 });
    }
    const table = kind === "book" ? "books" : "generations";
    const removing = body.action === "takedown";
    const { data: row } = await admin.from(table).select("id, removed_at").eq("id", targetId).maybeSingle();
    if (!row) return NextResponse.json({ error: `${kind} not found.` }, { status: 404 });
    const { error: tErr } = await admin
      .from(table)
      .update({
        removed_at: removing ? new Date().toISOString() : null,
        removed_by: removing ? staff.id : null,
      })
      .eq("id", targetId);
    if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });
    await audit(body.action, kind, { was_removed: !!row.removed_at });
    return NextResponse.json({ ok: true });
  }

  // ── Staff membership (founders only — staff cannot mint staff) ─────────────
  if (body.action === "admin_grant" || body.action === "admin_revoke") {
    if (!founderEmails().includes(staff.email)) {
      return NextResponse.json({ error: "Founders only." }, { status: 403 });
    }
    if (body.action === "admin_grant") {
      const { error: gErr } = await admin
        .from("platform_admins")
        .upsert({ user_id: targetId, granted_by: staff.id, note: body.note ?? null, revoked_at: null });
      if (gErr) return NextResponse.json({ error: gErr.message }, { status: 500 });
    } else {
      const { error: rErr } = await admin
        .from("platform_admins")
        .update({ revoked_at: new Date().toISOString() })
        .eq("user_id", targetId);
      if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 });
    }
    await audit(body.action, "profile", {});
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
