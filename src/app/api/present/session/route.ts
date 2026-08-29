import { NextResponse } from "next/server";
import { caller, ownedSession, jsonBody, NOT_FOUND } from "@/utils/present/server";
import { pointerFor, type ShownItem } from "@/utils/present/context";

export const runtime = "nodejs";

// A lesson's lifecycle: start one, close one.
//
// CLOSING IS WHERE THE POINTER MOVES, and the decision is made HERE rather than
// by the client. The client knows what it showed; the server decides what that
// means, because "only the slot's own video or kit worksheet advances the
// pointer" is the rule the whole schema is shaped around and a rule enforced in
// a browser is a rule that holds until somebody writes a second client.
//
// The evidence is present_items — what she ACTUALLY put in front of the class —
// not what the session set out to teach. She can spend a Chapter 4 lesson
// revising chapters 1-5, and the pointer must not move at all.

export async function POST(request: Request) {
  const c = await caller();
  if (!c) return NOT_FOUND();
  const b = await jsonBody(request);
  if (!b) return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });

  const bookId = typeof b.bookId === "string" ? b.bookId : null;
  const chapterNum = typeof b.chapterNum === "number" ? b.chapterNum : null;
  if (!bookId || chapterNum === null) {
    return NextResponse.json({ error: "A book and chapter are required." }, { status: 400 });
  }

  const { data, error } = await c.admin
    .from("present_sessions")
    .insert({
      teacher_id: c.userId,
      school_id: typeof b.schoolId === "string" ? b.schoolId : null,
      class_id: typeof b.classId === "string" ? b.classId : null,
      subject: typeof b.subject === "string" ? b.subject : null,
      book_id: bookId,
      chapter_num: chapterNum,
      part: typeof b.part === "number" ? b.part : null,
      slot_day: typeof b.slotDay === "number" ? b.slotDay : null,
      slot_period: typeof b.slotPeriod === "number" ? b.slotPeriod : null,
    })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id: data.id });
}

/**
 * Close a session, and move the class's pointer if — and only if — she taught
 * the slot's own part.
 *
 * Idempotent: closing an already-closed session is a no-op rather than an error.
 * A panel loses its network at the bell and the close is retried; the second
 * attempt must not fail, and must not advance the pointer twice.
 */
export async function PATCH(request: Request) {
  const c = await caller();
  if (!c) return NOT_FOUND();
  const b = await jsonBody(request);
  if (!b) return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });

  const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
  const session = await ownedSession(c, sessionId);
  if (!session) return NOT_FOUND();
  if (session.ended_at) return NextResponse.json({ ok: true, alreadyClosed: true });

  const pageCount = typeof b.pageCount === "number" && b.pageCount > 0 ? Math.floor(b.pageCount) : 1;

  // What did she actually show? The items carry the generation each came from,
  // and `detail` carries where in the book it sat.
  const { data: itemRows } = await c.admin
    .from("present_items")
    .select("kind, detail")
    .eq("session_id", sessionId);

  type Item = { kind: string; detail: Record<string, unknown> | null };
  const items = (itemRows ?? []) as Item[];

  const shown: ShownItem[] = items.map((i) => ({
    kind: i.kind === "video" || i.kind === "worksheet" ? i.kind : "blank",
    bookId: typeof i.detail?.bookId === "string" ? i.detail.bookId : null,
    chapterNum: typeof i.detail?.chapterNum === "number" ? i.detail.chapterNum : null,
    part: typeof i.detail?.part === "number" ? i.detail.part : null,
  }));
  // Where she actually got to — the furthest part of THIS chapter that she
  // opened. Null when nothing she showed belonged to it, which is the revision
  // lesson: recorded in present_items, moving nothing.
  const reached = pointerFor(
    { book_id: session.book_id, chapter_num: session.chapter_num },
    shown,
  );

  const { error } = await c.admin
    .from("present_sessions")
    .update({ ended_at: new Date().toISOString(), page_count: pageCount })
    .eq("id", sessionId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // The pointer needs a class AND a subject to be about; an independent teacher
  // with neither simply has nowhere to record where she got to, and that is not
  // a failure worth reporting.
  if (reached && session.class_id && session.subject) {
    await c.admin.from("present_last_taught").upsert(
      {
        teacher_id: c.userId,
        class_id: session.class_id,
        subject: session.subject,
        book_id: session.book_id,
        chapter_num: reached.chapterNum,
        part: reached.part,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "teacher_id,class_id,subject" },
    );
  }

  return NextResponse.json({ ok: true, pointerMoved: !!reached, reached });
}
