import { NextResponse } from "next/server";
import { caller, ownedSession, jsonBody, NOT_FOUND, type Caller } from "@/utils/present/server";
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

/**
 * Is this her class?
 *
 * Two ways, matching the two ways the bar can offer one: she owns it
 * (`classes.teacher_id`, what the picker lists), or she teaches it in the
 * timetable (`timetable_slots`, which is how a school teacher reaches a class
 * she does not own). Anything else is refused rather than silently downgraded to
 * null — a lesson quietly published to nobody is a bug report, not a fix.
 */
async function teaches(c: Caller, classId: string): Promise<boolean> {
  const [own, slot] = await Promise.all([
    c.admin.from("classes").select("id").eq("id", classId).eq("teacher_id", c.userId).maybeSingle(),
    c.admin
      .from("timetable_slots")
      .select("class_id")
      .eq("class_id", classId)
      .eq("teacher_id", c.userId)
      .limit(1),
  ]);
  return !!own.data || !!slot.data?.length;
}

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

  // THE CLASS IS AN AUDIENCE, NOT A LABEL — checked here, not taken.
  //
  // It was a label until Phase 3: a name on her own row, wrong at worst. It is
  // now the audience selector, because mayReadRecap() grants a published note to
  // everyone enrolled in present_sessions.class_id. Taken from the body and
  // written through the service role, it would let an allowlisted caller publish
  // a lesson note into a class she does not teach — this route's own header says
  // why that is not acceptable: "a rule enforced in a browser is a rule that
  // holds until somebody writes a second client."
  //
  // The school is DERIVED rather than checked, for the same reason and more
  // simply: it is her school or it is nothing.
  const claimedClass = typeof b.classId === "string" ? b.classId : null;
  const classId = claimedClass && (await teaches(c, claimedClass)) ? claimedClass : null;
  if (claimedClass && !classId) {
    // 403 here, not the 404 every other refusal in Present mode answers. The
    // 404 rule exists so an unauthenticated prober cannot learn the surface
    // exists; this caller is signed in AND allowlisted, so the surface is
    // already known to them and a silent null would be worse — a lesson
    // published to nobody, discovered at the bell.
    return NextResponse.json({ error: "That is not your class." }, { status: 403 });
  }

  const { data: me } = await c.admin
    .from("profiles")
    .select("school_id")
    .eq("id", c.userId)
    .maybeSingle();

  const { data, error } = await c.admin
    .from("present_sessions")
    .insert({
      teacher_id: c.userId,
      school_id: (me?.school_id as string | null) ?? null,
      class_id: classId,
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

/** Taken back explicitly. Next auto-implements OPTIONS when a route file does
 *  not, replying 204 with an `Allow` header to ANY caller, signed in or not —
 *  which tells an unauthenticated prober that this surface exists. The whole
 *  point of answering 404 everywhere else is undone by that one reply. */
export async function OPTIONS() {
  return NOT_FOUND();
}

/** Same reasoning as OPTIONS: Next answers a GET on a POST-only route with 405
 *  and an `Allow` header, which tells an unauthenticated prober the route
 *  exists. A 404 tells them nothing, which is the whole doctrine here. */
export async function GET() {
  return NOT_FOUND();
}
