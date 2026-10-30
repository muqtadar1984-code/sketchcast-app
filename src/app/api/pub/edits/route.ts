import { NextResponse } from "next/server";
import { isBookMemberRequest, canOn } from "@/utils/books-access";
import { getWork } from "@/utils/books/store";
import { applyChapterEdits, decideEdit, saveEdit, suggestReword } from "@/utils/books/edits";
import { sameOrigin } from "../runs/same-origin";

export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/pub/edits — the reader's edits (phase 3a). Editors and up.
//   {book, action: "suggest", passage, context, instruction}               → {text}   (AI rewording, nothing saved)
//   {book, action: "save", kind: reword|edit|note, chapter, rev, unit, before, after?, instruction?}  → {id}
//   {book, action: "decide", id, to: rejected|resolved}
//   {book, action: "apply", chapter}                                         → {revision, run}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new NextResponse(null, { status: 403 });
  const m = await isBookMemberRequest();
  if (!m) return new NextResponse(null, { status: 404 });
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const work = await getWork(String(b.book ?? ""));
  if (!work || !canOn(m, work.uid, "read")) return new NextResponse(null, { status: 404 });
  if (!canOn(m, work.uid, "edit")) return NextResponse.json({ error: "Your role on this book may not edit it." }, { status: 403 });
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  let r: ({ ok: true } & Record<string, unknown>) | { error: string; status: number };
  try {
    if (b.action === "suggest") r = await suggestReword({ passage: s(b.passage), context: s(b.context), instruction: s(b.instruction), ages: work.age_band ?? null });
    else if (b.action === "save") {
      const kind = b.kind === "reword" || b.kind === "edit" || b.kind === "note" ? b.kind : null;
      if (!kind) return NextResponse.json({ error: "Unknown kind of change." }, { status: 400 });
      r = await saveEdit({ workUid: work.uid, revisionKey: s(b.rev), chapter: Number(b.chapter), kind, unit: s(b.unit), before: s(b.before), after: s(b.after) || null, instruction: s(b.instruction) || null, by: m.email });
    } else if (b.action === "decide") {
      const to = b.to === "rejected" || b.to === "resolved" ? b.to : null;
      if (!to) return NextResponse.json({ error: "Unknown decision." }, { status: 400 });
      r = await decideEdit({ workUid: work.uid, id: Number(b.id), to, by: m.email });
    } else if (b.action === "apply") r = await applyChapterEdits({ work, chapter: Number(b.chapter), by: m.email });
    else return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 300) }, { status: 500 });
  }
  if (!("ok" in r)) {
    const e = r as { error: string; status: number };
    return NextResponse.json({ error: e.error }, { status: e.status });
  }
  const rest: Record<string, unknown> = { ...r };
  delete rest.ok;
  return NextResponse.json(rest);
}
