import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isPlatformAdminRequest } from "@/utils/platform-admin";

export const runtime = "nodejs";

// Issue lifecycle (staff only): status / severity / resolution updates via the
// service role (reporters have no UPDATE path under RLS). Non-staff get 404 —
// the console must not be probeable. Every change lands in the audit log.

type Body = {
  id?: string;
  status?: "open" | "triaged" | "in_progress" | "resolved";
  severity?: "low" | "normal" | "high" | "critical";
  resolution_note?: string | null;
};

const STATUSES = ["open", "triaged", "in_progress", "resolved"];
const SEVERITIES = ["low", "normal", "high", "critical"];

export async function PATCH(request: Request) {
  const staff = await isPlatformAdminRequest();
  if (!staff) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return NextResponse.json({ error: "Bad status." }, { status: 400 });
    patch.status = body.status;
    patch.resolved_at = body.status === "resolved" ? new Date().toISOString() : null;
  }
  if (body.severity !== undefined) {
    if (!SEVERITIES.includes(body.severity)) return NextResponse.json({ error: "Bad severity." }, { status: 400 });
    patch.severity = body.severity;
  }
  if (body.resolution_note !== undefined) {
    patch.resolution_note = (body.resolution_note ?? "").trim().slice(0, 2000) || null;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: before } = await admin
    .from("platform_issues")
    .select("status, severity")
    .eq("id", id)
    .maybeSingle();
  if (!before) return NextResponse.json({ error: "Issue not found." }, { status: 404 });

  const { error: uErr } = await admin.from("platform_issues").update(patch).eq("id", id);
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });

  await admin.from("platform_audit_log").insert({
    actor_id: staff.id,
    action: "issue_status",
    target_kind: "issue",
    target_id: id,
    detail: { before, after: patch },
  });

  return NextResponse.json({ ok: true });
}
