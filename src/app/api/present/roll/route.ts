import { NextResponse } from "next/server";
import { caller, ownedSession, jsonBody, NOT_FOUND } from "@/utils/present/server";
import { rollPdfPath, sessionFolder } from "@/utils/present/paths";

export const runtime = "nodejs";

// The roll, once it is a file.
//
// THE BYTES DO NOT COME THROUGH HERE. The board exports the PDF in the browser
// (pdf-lib, src/board/export-pdf.ts) and uploads it straight to the artifacts
// bucket with the teacher's own session — which works because that bucket
// carries exactly one policy, `(storage.foldername(name))[1] = auth.uid()::text`,
// so she may write anywhere under her own uid folder and nowhere else. That is
// the same reasoning upload-book.tsx uses for a 200 MB textbook: the app has no
// precedent for streaming large binaries through a Route Handler, next.config is
// empty of body-size tuning, and the one existing server-side upload is a 30 KB
// MP3.
//
// SO WHAT IS THIS ROUTE FOR? Recording the path, and refusing to record one it
// did not derive itself. `pdf_path` is a pointer the student page will sign, and
// a client-supplied pointer is a client-supplied claim. The path is rebuilt here
// from the session row that was just authorised — teacher_id and session id,
// neither of which the caller controls — and the object is confirmed to exist
// before the row is updated, so pdf_path never points at nothing.

export async function POST(request: Request) {
  const c = await caller();
  if (!c) return NOT_FOUND();
  const b = await jsonBody(request);
  if (!b) return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });

  const session = await ownedSession(c, typeof b.sessionId === "string" ? b.sessionId : "");
  if (!session) return NOT_FOUND();

  // Derived, never accepted. The client tells us WHICH lesson; we decide where
  // that lesson's file lives.
  const path = rollPdfPath(session.teacher_id, session.id);

  const { data: listed, error: listError } = await c.admin.storage
    .from("artifacts")
    .list(sessionFolder(session.teacher_id, session.id), { limit: 100 });
  if (listError) {
    return NextResponse.json({ error: listError.message }, { status: 500 });
  }

  const file = (listed ?? []).find((f) => f.name === "board.pdf");
  if (!file) {
    // The upload failed or never happened. Recording the path anyway would
    // publish a lesson whose "open the roll" button 404s in front of a parent.
    return NextResponse.json(
      { error: "The board file is not in storage yet." },
      { status: 409 },
    );
  }

  const { error } = await c.admin
    .from("present_sessions")
    .update({ pdf_path: path })
    .eq("id", session.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const size = (file.metadata as { size?: number } | null)?.size ?? null;
  return NextResponse.json({ ok: true, path, size });
}

/** Taken back explicitly — Next would otherwise answer OPTIONS with a 204 and an
 *  Allow header, telling an unauthenticated caller that this surface exists. */
export async function OPTIONS() {
  return NOT_FOUND();
}

/** Same reasoning as OPTIONS: Next answers a GET on a POST-only route with 405
 *  and an `Allow` header, which tells an unauthenticated prober the route
 *  exists. A 404 tells them nothing, which is the whole doctrine here. */
export async function GET() {
  return NOT_FOUND();
}
