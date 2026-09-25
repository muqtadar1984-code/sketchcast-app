import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isPlatformAdminRequest } from "@/utils/platform-admin";
import { notifyIssueResolved } from "@/utils/notify";

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
  const { data: row } = await admin
    .from("platform_issues")
    .select("status, severity, category, resolution_note, reporter_id, generation_id, book_id")
    .eq("id", id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "Issue not found." }, { status: 404 });
  const before = { status: row.status, severity: row.severity };

  const { error: uErr } = await admin.from("platform_issues").update(patch).eq("id", id);
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });

  // Every resolution reaches the client (founder direction 2026-09-25): the
  // first move INTO resolved emails the owner what was done, with an
  // invitation to reply. Re-saving a resolved issue does not mail again.
  let notified = false;
  if (patch.status === "resolved" && row.status !== "resolved") {
    notified = await notifyOwner(admin, row, (patch.resolution_note as string | null | undefined) ?? row.resolution_note);
  }

  await admin.from("platform_audit_log").insert({
    actor_id: staff.id,
    action: "issue_status",
    target_kind: "issue",
    target_id: id,
    detail: { before, after: patch, notified },
  });

  return NextResponse.json({ ok: true, notified });
}

/** The issue's owner — the generation's owner first (an auto-filed issue
 *  names the reporter as the owner too), else the reporter — and their book. */
async function notifyOwner(
  admin: ReturnType<typeof createAdminClient>,
  row: { category: string | null; resolution_note: string | null; reporter_id: string | null; generation_id: string | null; book_id: string | null },
  note: string | null,
): Promise<boolean> {
  try {
    let ownerId: string | null = row.reporter_id;
    let kind: string | null = null;
    let bookId: string | null = row.book_id;
    if (row.generation_id) {
      const { data: gen } = await admin.from("generations").select("owner_id, kind, book_id").eq("id", row.generation_id).maybeSingle();
      if (gen) {
        ownerId = (gen.owner_id as string) ?? ownerId;
        kind = (gen.kind as string) ?? null;
        bookId = (gen.book_id as string) ?? bookId;
      }
    }
    if (!ownerId) return false;
    let bookTitle: string | null = null;
    if (bookId) {
      const { data: book } = await admin.from("books").select("title").eq("id", bookId).maybeSingle();
      bookTitle = (book?.title as string) ?? null;
    }
    const { data: u } = await admin.auth.admin.getUserById(ownerId);
    return await notifyIssueResolved(u?.user?.email ?? null, { kind, category: row.category, bookTitle, note });
  } catch (e) {
    console.error("issue owner lookup failed:", e);
    return false;
  }
}
