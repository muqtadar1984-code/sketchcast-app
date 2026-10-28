import { NextResponse } from "next/server";
import { isBookMemberRequest, canOn } from "@/utils/books-access";
import { getWork } from "@/utils/books/store";
import { approveGateD } from "@/utils/books/decide";
import { sameOrigin } from "../runs/same-origin";

export const runtime = "nodejs";

// POST /api/pub/approvals  {book, chapter, rev, note}  →  201 {sha}
// An approver approves a chapter's CURRENT text at Gate D (only the book's current revision can be approved). The
// approval is the engine's hash of that text, inserted into pub_approvals, which never changes afterwards.
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new NextResponse(null, { status: 403 });
  const m = await isBookMemberRequest();
  if (!m) return new NextResponse(null, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { book?: string; chapter?: number; rev?: string; note?: string };
  const work = await getWork(body.book ?? "");
  if (!work || !canOn(m, work.uid, "read")) return new NextResponse(null, { status: 404 });
  if (!canOn(m, work.uid, "approve")) return NextResponse.json({ error: "Only an approver can approve at Gate D." }, { status: 403 });
  const chapter = Number(body.chapter);
  if (!Number.isInteger(chapter) || chapter < 1) return NextResponse.json({ error: "Unknown chapter." }, { status: 400 });
  if (!work.current_revision || body.rev !== work.current_revision) {
    return NextResponse.json({ error: "Only the book's current revision can be approved." }, { status: 409 });
  }
  const r = await approveGateD({ workUid: work.uid, revisionKey: work.current_revision, chapter, by: m.email, note: String(body.note ?? "").slice(0, 1000) });
  return "error" in r ? NextResponse.json({ error: r.error }, { status: r.status }) : NextResponse.json({ sha: r.sha }, { status: 201 });
}
