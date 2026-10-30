import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { caller, jsonBody, NOT_FOUND } from "@/utils/present/server";
import { adoptCatalogueKit, adoptProductChapter, type AdoptDeps } from "@/utils/present/adopt";

export const runtime = "nodejs";

// POST /api/present/adopt — the Board's adopt-on-pick (utils/present/adopt.ts).
//   { bookId, chapterNum, kit? }  a SketchCast book's chapter → her copy of one
//                           of its catalogue kits (`kit` = that kit's lesson id
//                           when the chapter has several; omitted → the first)
//   { catalogueKit }        a catalogue kit (topic_kits.id) → her copy of it
// → 200 { kitId, title }: her own done, book-less presentation, which
//   /api/present/session {kitId} and /api/present/kit?kit= then accept.
// → 409 { reason: "no_kit" }   the chapter's kit is not made yet
// → 403 { reason: "locked" | "ineligible" }  a capped tier's locked kit / not allowed
// → 404 everything else (the Board's rule: a stranger learns nothing).
// Behind the Board's own gate (caller(): signed in + presentEntitled).

export async function POST(request: Request) {
  const c = await caller();
  if (!c) return NOT_FOUND();
  const b = await jsonBody(request);
  if (!b) return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });

  const session = await createClient();
  const deps: AdoptDeps = {
    admin: c.admin as unknown as AdoptDeps["admin"],
    rpc: (fn, args) => session.rpc(fn, args) as unknown as PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>,
  };

  const result =
    typeof b.catalogueKit === "string"
      ? await adoptCatalogueKit(deps, c.userId, b.catalogueKit)
      : typeof b.bookId === "string" && typeof b.chapterNum === "number"
        ? await adoptProductChapter(deps, b.bookId, b.chapterNum, typeof b.kit === "string" ? b.kit : null)
        : null;
  if (!result) return NextResponse.json({ error: "A book chapter or a catalogue kit is required." }, { status: 400 });
  if (result.ok) return NextResponse.json({ kitId: result.kitId, title: result.title });
  if (result.status === 404) return NOT_FOUND();
  return NextResponse.json({ error: result.reason, reason: result.reason }, { status: result.status });
}

/** Taken back explicitly, as every /api/present route does (see kit/route.ts). */
export async function OPTIONS() {
  return NOT_FOUND();
}
