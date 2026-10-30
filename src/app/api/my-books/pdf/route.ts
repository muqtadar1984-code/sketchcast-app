import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { loadMyBooks, type MyBooksDb } from "@/utils/my-books/load";
import { s3Link, s3Probe } from "@/utils/books/files";
import { PDF_LINK_SECONDS } from "@/utils/my-books/tiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/my-books/pdf?product=<sk_book_products.id> — "Download PDF" on
// the Library's My books strip (SK S7 K3; design decision 6: a short-lived link
// to the digital PDF, given only after the access check, no watermark yet).
//
//   signed out                       → 401
//   not a book this reader may have  → 404 (no link is ever minted; not probeable)
//   the role may not read the file   → back to /dashboard?book_pdf=unavailable,
//     or the file is missing           logged "[sk-library] s3 denied" / "… missing"
//   otherwise                        → 302 to a 10-minute presigned link,
//                                      logged in analytics_access_log
//                                      (scope 'book_download')
//
// The access decision is the strip's own (src/utils/my-books): finals only,
// skAccess for the reader, their verified children's grants, and a withdrawn
// book only for readers who held it before the withdrawal. Not gated by any
// SK flag — this is the Library.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function unavailable(req: NextRequest): NextResponse {
  return NextResponse.redirect(new URL("/dashboard?book_pdf=unavailable", req.url), 302);
}

/** "Biology: Cells.pdf" — a file name the reader's OS will accept. */
function pdfName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${base || "book"}.pdf`;
}

export async function GET(req: NextRequest) {
  const session = await createClient();
  const {
    data: { user },
  } = await session.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const productId = (req.nextUrl.searchParams.get("product") ?? "").trim();
  if (!UUID.test(productId)) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const [book] = await loadMyBooks(createAdminClient() as unknown as MyBooksDb, user.id, new Date(), { productId });
  if (!book) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!book.pdfKey) return unavailable(req);

  const probe = await s3Probe(book.pdfKey);
  if (probe !== "ok") {
    if (probe === "denied") console.error("[sk-library] s3 denied", book.pdfKey);
    else console.error(`[sk-library] pdf ${probe}`, book.pdfKey);
    return unavailable(req);
  }
  const link = await s3Link(book.pdfKey, pdfName(book.title), PDF_LINK_SECONDS);
  if (!link) return unavailable(req);

  // Best-effort audit row (RLS: an actor appends their own). A failed insert
  // never costs the reader their download.
  try {
    const { error } = await session.from("analytics_access_log").insert({
      actor_id: user.id,
      scope: "book_download",
      target_kind: "sk_book_product",
      target_id: book.productId,
      detail: { release_id: book.releaseId, for_child: book.forChildren.length > 0, withdrawn: book.withdrawn },
    });
    if (error) console.error("[sk-library] download log failed:", error.message);
  } catch (e) {
    console.error("[sk-library] download log failed:", (e as Error).message);
  }

  return NextResponse.redirect(link, 302);
}
