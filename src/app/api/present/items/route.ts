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
  const { data: last } = await c.admin
    .from("present_items")
    .select("seq")
    .eq("session_id", sessionId)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();
  let seq = ((last?.seq as number | undefined) ?? -1) + 1;

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
  if (!rows.length) return NextResponse.json({ error: "Nothing recognisable." }, { status: 400 });

  const { error } = await c.admin.from("present_items").insert(rows);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, recorded: rows.length });
}
