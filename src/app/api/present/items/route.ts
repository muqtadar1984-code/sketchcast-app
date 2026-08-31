import { NextResponse } from "next/server";
import { caller, ownedSession, jsonBody, NOT_FOUND } from "@/utils/present/server";

export const runtime = "nodejs";

// What she actually put in front of the class, in order.
//
// The reason this is its own table and its own route, rather than a field on the
// session: a session's CONTEXT and its CONTENT are different things. The slot
// says Chapter 4 Part 2; she may spend the period revising chapters 1-5. This is
// the record of the second, and it is what the recap will be grounded in and
// what decides whether the class's pointer moves.
//
// `detail` carries WHERE IN THE BOOK the thing sat, because that is what the
// pointer rule needs at close and the generation row may have been regenerated
// or withdrawn by then.

const KINDS = new Set(["video", "worksheet", "blank"]);
const MAX_ITEMS = 50;

export async function POST(request: Request) {
  const c = await caller();
  if (!c) return NOT_FOUND();
  const b = await jsonBody(request);
  if (!b) return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });

  const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
  const session = await ownedSession(c, sessionId);
  if (!session) return NOT_FOUND();

  const items = Array.isArray(b.items) ? b.items.slice(0, MAX_ITEMS) : null;
  if (!items?.length) return NextResponse.json({ error: "No items." }, { status: 400 });

  // Continue the sequence rather than restarting it: a second batch in the same
  // lesson must not collide with the first, and the order is the point.
  //
  // READ-THEN-INSERT, SO IT RETRIES. There is no sequence to allocate from —
  // (session_id, seq) is the primary key and the next number is whatever the
  // last read said plus one — so two writes landing together both compute the
  // same seq and the second gets 23505. That is not rare in the shape this
  // route is actually used: the board fires an item on every tap, and a teacher
  // opening the video and a worksheet in quick succession is the normal case.
  // A lost item costs the recap a piece of its evidence and the pointer a part,
  // silently, so the collision is retried rather than reported.
  const build = (from: number): Record<string, unknown>[] => {
    let seq = from;
    const rows: Record<string, unknown>[] = [];
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const i = raw as Record<string, unknown>;
      const kind = typeof i.kind === "string" ? i.kind : "";
      if (!KINDS.has(kind)) continue;
      const detail = i.detail && typeof i.detail === "object" && !Array.isArray(i.detail)
        ? (i.detail as Record<string, unknown>)
        : null;
      rows.push({
        session_id: sessionId,
        seq: seq++,
        generation_id: typeof i.generationId === "string" ? i.generationId : null,
        kind,
        detail,
      });
    }
    return rows;
  };

  const { data: last } = await c.admin
    .from("present_items")
    .select("seq")
    .eq("session_id", sessionId)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();

  let next = ((last?.seq as number | undefined) ?? -1) + 1;
  if (!build(next).length) {
    return NextResponse.json({ error: "Nothing recognisable." }, { status: 400 });
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const rows = build(next);
    const { error } = await c.admin.from("present_items").insert(rows);
    if (!error) return NextResponse.json({ ok: true, recorded: rows.length });
    // 23505 — somebody took these numbers between the read and the write. Ask
    // again where the sequence has got to and re-number.
    if (error.code !== "23505") {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const { data: again } = await c.admin
      .from("present_items")
      .select("seq")
      .eq("session_id", sessionId)
      .order("seq", { ascending: false })
      .limit(1)
      .maybeSingle();
    next = ((again?.seq as number | undefined) ?? next) + 1;
  }
  return NextResponse.json({ error: "Could not record the item." }, { status: 409 });
}

/** Taken back explicitly. Next auto-implements OPTIONS when a route file does
 *  not, replying 204 with an `Allow` header to ANY caller, signed in or not —
 *  which tells an unauthenticated prober that this surface exists. The whole
 *  point of answering 404 everywhere else is undone by that one reply. */
export async function OPTIONS() {
  return NOT_FOUND();
}
