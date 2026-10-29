import { NextResponse } from "next/server";
import { isBookMemberRequest, canOn } from "@/utils/books-access";
import { getWork } from "@/utils/books/store";
import { revokeWaiver, waiveCheck } from "@/utils/books/waivers";
import { sameOrigin } from "../runs/same-origin";

export const runtime = "nodejs";

// POST /api/pub/waivers
//   {book, action: "waive", topic_id, topic_title, check, language, sub_status, reason}
//   {book, action: "revoke", id}
// A member with the edit right waives (or revokes the waiver of) one failing readiness check for this book; the next
// Readiness re-check or Gate R honours it. 404 for non-members and unknown books; 403 without the right; 400 for a
// refused waiver; 409 when it already exists or was revoked meanwhile; 503 before migration 0168.
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new NextResponse(null, { status: 403 });
  const m = await isBookMemberRequest();
  if (!m) return new NextResponse(null, { status: 404 });
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const work = await getWork(String(b.book ?? ""));
  if (!work || !canOn(m, work.uid, "read")) return new NextResponse(null, { status: 404 });
  if (!canOn(m, work.uid, "edit")) return NextResponse.json({ error: "Your role on this book may not waive readiness checks." }, { status: 403 });
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const r =
    b.action === "revoke"
      ? await revokeWaiver({ workUid: work.uid, id: Number(b.id), by: m.email })
      : b.action === "waive"
        ? await waiveCheck({
            workUid: work.uid,
            topicId: String(b.topic_id ?? ""),
            topicTitle: String(b.topic_title ?? ""),
            check: String(b.check ?? ""),
            language: str(b.language),
            subStatus: str(b.sub_status),
            reason: String(b.reason ?? ""),
            by: m.email,
          })
        : { error: "Unknown action.", status: 400 };
  return "error" in r ? NextResponse.json({ error: r.error }, { status: r.status }) : NextResponse.json({ ok: true });
}
