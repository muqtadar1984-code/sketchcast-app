import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { isBookMemberRequest, canOn } from "@/utils/books-access";
import { getChapter, getWork, fixtureFileFor, fixturePath } from "@/utils/books/store";
import { libraryPictureLink, s3Link } from "@/utils/books/files";

export const runtime = "nodejs";

// GET /api/pub/figure?book=<slug>&rev=<revision>&ch=<n>&ref=<figure ref>
// A picture placed in a chapter, resolved through THAT chapter revision's own
// figure map (so a picture is only served where the book actually used it):
// book illustrations from the books bucket, library pictures from the shared
// library bucket (read only). 302 to a short-lived link; 404 otherwise.
export async function GET(request: Request) {
  const m = await isBookMemberRequest();
  if (!m) return new NextResponse(null, { status: 404 });
  const url = new URL(request.url);
  const work = await getWork(url.searchParams.get("book") ?? "");
  const ch = Number(url.searchParams.get("ch"));
  const ref = url.searchParams.get("ref") ?? "";
  if (!work || !Number.isInteger(ch) || !canOn(m, work.uid, "read")) return new NextResponse(null, { status: 404 });
  const chapter = await getChapter(work.uid, url.searchParams.get("rev") ?? "", ch);
  const fig = chapter?.body.figures?.[ref];
  if (!fig?.path) return new NextResponse(null, { status: 404 });

  if (fig.store === "s3") {
    if (fixturePath()) {
      const local = fixtureFileFor(fig.path);
      if (!local) return new NextResponse(null, { status: 404 });
      return new NextResponse(new Uint8Array(await readFile(local)), {
        headers: { "content-type": "image/png", "cache-control": "private, max-age=300" },
      });
    }
    const link = await s3Link(fig.path);
    return link ? NextResponse.redirect(link, 302) : new NextResponse(null, { status: 404 });
  }
  if (fixturePath()) return new NextResponse(null, { status: 404 }); // no library access from a local fixture
  const link = await libraryPictureLink(fig.path);
  return link ? NextResponse.redirect(link, 302) : new NextResponse(null, { status: 404 });
}
