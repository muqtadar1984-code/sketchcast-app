import { NextResponse } from "next/server";
import { isBookMemberRequest, canOn } from "@/utils/books-access";
import { getWork } from "@/utils/books/store";
import { ruleFinding, RULINGS, type Ruling } from "@/utils/books/decide";
import { sameOrigin } from "../../runs/same-origin";

export const runtime = "nodejs";

// POST /api/pub/findings/<id>  {book, to: accepted|rejected|deferred|open, reason}
// A member with the edit right rules on a finding. 404 for non-members and unknown books; 403 without the right;
// 400 for a bad ruling or a rejection without a reason; 409 when the finding was applied or ruled meanwhile.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return new NextResponse(null, { status: 403 });
  const m = await isBookMemberRequest();
  if (!m) return new NextResponse(null, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { book?: string; to?: string; reason?: string };
  const work = await getWork(body.book ?? "");
  const id = Number((await params).id);
  if (!work || !Number.isInteger(id) || !canOn(m, work.uid, "read")) return new NextResponse(null, { status: 404 });
  if (!canOn(m, work.uid, "edit")) return NextResponse.json({ error: "Your role on this book may not rule on findings." }, { status: 403 });
  if (!RULINGS.includes(body.to as Ruling)) return NextResponse.json({ error: "Unknown ruling." }, { status: 400 });
  const r = await ruleFinding({ workUid: work.uid, findingId: id, to: body.to as Ruling, reason: String(body.reason ?? "").slice(0, 2000), by: m.email });
  return "error" in r ? NextResponse.json({ error: r.error }, { status: r.status }) : NextResponse.json({ ok: true });
}
