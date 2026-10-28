import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { isBookMemberRequest, canOn } from "@/utils/books-access";
import { getArtifact, getWork, fixtureFileFor, fixturePath } from "@/utils/books/store";
import { s3Link } from "@/utils/books/files";

export const runtime = "nodejs";

// GET /api/pub/file?book=<slug>&id=<artifact id>[&download=1]
// A book file (PDF, packet, report, record): a 302 to a short-lived link into
// the private books bucket. 404 for non-members, unknown books and files (the
// app is not probeable). Read-only; every member with `read` on the book.
export async function GET(request: Request) {
  const m = await isBookMemberRequest();
  if (!m) return new NextResponse(null, { status: 404 });
  const url = new URL(request.url);
  const work = await getWork(url.searchParams.get("book") ?? "");
  const id = Number(url.searchParams.get("id"));
  if (!work || !Number.isInteger(id) || !canOn(m, work.uid, "read")) return new NextResponse(null, { status: 404 });
  const a = await getArtifact(work.uid, id);
  if (!a?.storage_key) return new NextResponse(null, { status: 404 });
  const download = url.searchParams.get("download") === "1" ? a.title : undefined;

  if (fixturePath()) {
    // development fixture: serve the local file the bundle would have uploaded
    const local = fixtureFileFor(a.storage_key);
    if (!local) return new NextResponse(null, { status: 404 });
    return new NextResponse(new Uint8Array(await readFile(/*turbopackIgnore: true*/ local)), {
      headers: { "content-type": a.content_type ?? "application/octet-stream", "cache-control": "private, no-store" },
    });
  }
  const link = await s3Link(a.storage_key, download);
  if (!link) return NextResponse.json({ error: "The books bucket is not configured (BOOKS_S3_BUCKET)." }, { status: 503 });
  return NextResponse.redirect(link, { status: 302, headers: { "cache-control": "private, no-store" } });
}
