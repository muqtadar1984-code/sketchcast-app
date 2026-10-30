import { NextResponse } from "next/server";
import { isBookMemberRequest, canOn } from "@/utils/books-access";
import { getWork } from "@/utils/books/store";
import { withdrawRelease } from "@/utils/books/releases";
import { sameOrigin } from "../runs/same-origin";

export const runtime = "nodejs";

// POST /api/pub/releases  {book, action: "withdraw", id, reason}
// An approver withdraws a release: SK then shows it to no new reader (existing purchasers keep access unless the
// founder decides otherwise). A withdrawal is recorded with who and why, and cannot be undone or edited.
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new NextResponse(null, { status: 403 });
  const m = await isBookMemberRequest();
  if (!m) return new NextResponse(null, { status: 404 });
  const b = (await request.json().catch(() => ({}))) as { book?: string; action?: string; id?: number; reason?: string };
  const work = await getWork(b.book ?? "");
  if (!work || !canOn(m, work.uid, "read")) return new NextResponse(null, { status: 404 });
  if (!canOn(m, work.uid, "approve")) return NextResponse.json({ error: "Only an approver can withdraw a release." }, { status: 403 });
  if (b.action !== "withdraw") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  const r = await withdrawRelease({ workUid: work.uid, id: Number(b.id), reason: String(b.reason ?? ""), by: m.email });
  return "error" in r ? NextResponse.json({ error: r.error }, { status: r.status }) : NextResponse.json({ ok: true });
}
