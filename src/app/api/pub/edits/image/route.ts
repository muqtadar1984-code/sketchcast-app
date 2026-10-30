import { NextResponse } from "next/server";
import { isBookMemberRequest, canOn } from "@/utils/books-access";
import { getWork } from "@/utils/books/store";
import { s3Link } from "@/utils/books/files";
import { listEdits, localEditPicture, saveImageEdit } from "@/utils/books/edits";
import { sameOrigin } from "../../runs/same-origin";

export const runtime = "nodejs";
export const maxDuration = 60;

// /api/pub/edits/image — replacing a picture in the reader (phase 3b).
//   POST multipart {book, chapter, rev, ref, caption?, file}   → {id}      (editors and up)
//   GET  ?book=<slug>&id=<edit id>                             → the new picture of a pending replacement (readers)
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new NextResponse(null, { status: 403 });
  const m = await isBookMemberRequest();
  if (!m) return new NextResponse(null, { status: 404 });
  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Send the picture as a form." }, { status: 400 });
  const work = await getWork(String(form.get("book") ?? ""));
  if (!work || !canOn(m, work.uid, "read")) return new NextResponse(null, { status: 404 });
  if (!canOn(m, work.uid, "edit")) return NextResponse.json({ error: "Your role on this book may not edit it." }, { status: 403 });
  const file = form.get("file");
  if (!(file instanceof Blob)) return NextResponse.json({ error: "Choose a picture file." }, { status: 400 });
  const r = await saveImageEdit({
    workUid: work.uid,
    slug: work.slug,
    revisionKey: String(form.get("rev") ?? ""),
    chapter: Number(form.get("chapter")),
    ref: String(form.get("ref") ?? ""),
    bytes: new Uint8Array(await file.arrayBuffer()),
    caption: String(form.get("caption") ?? "") || null,
    by: m.email,
  });
  if (!("ok" in r)) {
    const e = r as { error: string; status: number };
    return NextResponse.json({ error: e.error }, { status: e.status });
  }
  return NextResponse.json({ id: r.id });
}

export async function GET(request: Request) {
  const m = await isBookMemberRequest();
  if (!m) return new NextResponse(null, { status: 404 });
  const url = new URL(request.url);
  const work = await getWork(url.searchParams.get("book") ?? "");
  if (!work || !canOn(m, work.uid, "read")) return new NextResponse(null, { status: 404 });
  const e = (await listEdits(work.uid)).find((x) => x.id === Number(url.searchParams.get("id")) && x.kind === "image");
  const key = e?.meta?.key;
  if (!key) return new NextResponse(null, { status: 404 });
  const local = localEditPicture(key);
  if (local) return new NextResponse(local as BodyInit, { headers: { "content-type": e.meta?.content_type ?? "image/png", "cache-control": "private, max-age=300" } });
  const link = await s3Link(key);
  return link ? NextResponse.redirect(link, 302) : new NextResponse(null, { status: 404 });
}
