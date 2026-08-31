import { NextResponse } from "next/server";
import { caller, ownedSession, jsonBody, NOT_FOUND } from "@/utils/present/server";

export const runtime = "nodejs";

// The board's log, mirrored to the server.
//
// This is the other half of BoardStore: the client appends locally first and
// batches through here, so a school's wi-fi going away costs a later flush and
// nothing else. The records arriving are the same shape the client already
// stores — a stroke, a page, or a void — because the client and this table are
// folds of ONE sequence rather than two representations to reconcile.
//
// UPSERT, NOT INSERT. A failed flush is retried by the client with the same
// records and the same sequence numbers, and a retry must not fail on a
// duplicate key or double-write a stroke. (seq) is the primary key precisely so
// a resend is a no-op.

const MAX_RECORDS = 500;
/** A generous cap on one stroke. A 40-minute lesson is thousands of strokes of a
 *  few hundred points; a single stroke with more than this is not a stroke. */
const MAX_POINTS = 30_000;

type StrokeRecord = {
  kind: "stroke";
  seq: number;
  stroke: {
    id: string;
    page: number;
    tool: string;
    color: string;
    width: number;
    pts: number[];
  };
};
type PageRecord = { kind: "page"; seq: number; index: number; background: unknown };
type VoidRecord = { kind: "void"; seq: number; strokeId: string; targetSeq?: number };

const TOOLS = new Set(["pen", "highlighter", "eraser"]);

export async function POST(request: Request) {
  const c = await caller();
  if (!c) return NOT_FOUND();
  const b = await jsonBody(request);
  if (!b) return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });

  const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
  const session = await ownedSession(c, sessionId);
  if (!session) return NOT_FOUND();

  const records = Array.isArray(b.records) ? b.records : null;
  if (!records) return NextResponse.json({ error: "No records." }, { status: 400 });
  if (records.length > MAX_RECORDS) {
    return NextResponse.json({ error: "Too many records in one batch." }, { status: 413 });
  }

  const strokes: Record<string, unknown>[] = [];
  const pages: Record<string, unknown>[] = [];
  const voids: number[] = [];

  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as StrokeRecord | PageRecord | VoidRecord;
    if (typeof r.seq !== "number" || !Number.isFinite(r.seq)) continue;

    if (r.kind === "stroke") {
      const s = (r as StrokeRecord).stroke;
      // Validated rather than trusted: these rows are written under the service
      // role, so the route is the only thing standing between a malformed body
      // and a table the board will later try to render.
      if (!s || typeof s !== "object") continue;
      if (!TOOLS.has(s.tool)) continue;
      if (typeof s.width !== "number" || !(s.width > 0)) continue;
      if (typeof s.page !== "number" || s.page < 0) continue;
      if (!Array.isArray(s.pts) || s.pts.length % 3 !== 0 || s.pts.length > MAX_POINTS) continue;
      if (s.pts.some((n) => typeof n !== "number" || !Number.isFinite(n))) continue;
      strokes.push({
        session_id: sessionId,
        seq: r.seq,
        page_idx: s.page,
        tool: s.tool,
        color: typeof s.color === "string" ? s.color.slice(0, 32) : "#14181F",
        width: s.width,
        pts: s.pts,
      });
    } else if (r.kind === "page") {
      const p = r as PageRecord;
      if (typeof p.index !== "number" || p.index < 0) continue;
      pages.push({ session_id: sessionId, idx: p.index, background: p.background ?? { kind: "blank" } });
    } else if (r.kind === "void") {
      const v = r as VoidRecord;
      // The record the client assigned the stroke, carried across by the store.
      // A void with no target is one for a stroke this device never held — a
      // merge of two devices makes that possible — and is dropped rather than
      // guessed at.
      if (typeof v.targetSeq === "number" && Number.isInteger(v.targetSeq)) voids.push(v.targetSeq);
    }
  }

  if (strokes.length) {
    const { error } = await c.admin.from("present_strokes").upsert(strokes, {
      onConflict: "session_id,seq",
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (pages.length) {
    const { error } = await c.admin.from("present_pages").upsert(pages, {
      onConflict: "session_id,idx",
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (voids.length) {
    // A tombstone, never a delete: the row keeps its place in the sequence, so a
    // replay of this table can never resurrect what she removed.
    await c.admin
      .from("present_strokes")
      .update({ voided_at: new Date().toISOString() })
      .eq("session_id", sessionId)
      .in("seq", voids);
  }

  return NextResponse.json({
    ok: true,
    strokes: strokes.length,
    pages: pages.length,
    voids: voids.length,
  });
}

/** Taken back explicitly. Next auto-implements OPTIONS when a route file does
 *  not, replying 204 with an `Allow` header to ANY caller, signed in or not —
 *  which tells an unauthenticated prober that this surface exists. The whole
 *  point of answering 404 everywhere else is undone by that one reply. */
export async function OPTIONS() {
  return NOT_FOUND();
}
