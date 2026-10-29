import { NextResponse } from "next/server";
import { isBookMemberRequest, canOn } from "@/utils/books-access";
import { getWork } from "@/utils/books/store";
import { approveGateE } from "@/utils/books/decide";
import { sameOrigin } from "../runs/same-origin";

export const runtime = "nodejs";

// POST /api/pub/gate-e  {book, run, note}  →  201
// An approver approves a compiled book (a finished compile_book run) at Gate E: exactly that PDF, by its hash, once
// every chapter in it is Gate D approved for the text it printed. The approval never changes afterwards.
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new NextResponse(null, { status: 403 });
  const m = await isBookMemberRequest();
  if (!m) return new NextResponse(null, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { book?: string; run?: number; note?: string };
  const work = await getWork(body.book ?? "");
  if (!work || !canOn(m, work.uid, "read")) return new NextResponse(null, { status: 404 });
  if (!canOn(m, work.uid, "approve")) return NextResponse.json({ error: "Only an approver can approve at Gate E." }, { status: 403 });
  const runId = Number(body.run);
  if (!Number.isInteger(runId) || runId < 1) return NextResponse.json({ error: "Unknown run." }, { status: 400 });
  const r = await approveGateE({ workUid: work.uid, runId, revisionKey: work.current_revision ?? null, by: m.email, note: String(body.note ?? "").slice(0, 1000) });
  return "error" in r ? NextResponse.json({ error: r.error }, { status: r.status }) : NextResponse.json({ ok: true }, { status: 201 });
}
