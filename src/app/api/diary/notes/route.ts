import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { diaryEnabled } from "@/utils/flags";

export const runtime = "nodejs";

// Class diary — author a note (0066). A note targets EXACTLY ONE of a class
// (class-wide) or a student (personal). Teachers write to classes they own or
// students they teach; parents write per-student notes about their own children
// only; students never author notes (they reply). The insert runs under the
// CALLER'S session so RLS (dn_insert) is the authority on standing — this route
// only shapes and pre-validates so denials come back as friendly 400/403s.

const NOTE_TYPES = ["homework", "reminder", "praise", "concern", "health", "general"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Days are bucketed in a FIXED civil zone (Malaysia, UTC+8, no DST) — the same
// convention every diary surface reads by: todayKey() in
// src/app/dashboard/diary/date-nav.tsx. Kept in step here rather than imported,
// because that module is a component file (note-types.ts was split out for
// exactly this reason). Letting entry_date fall through to the DB's UTC
// current_date instead would file a note written at 01:00 MYT under YESTERDAY,
// where nobody looks for it.
const TZ_OFFSET_MS = 8 * 3600000;
const civilTodayKey = () => new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10);

/** Is this a real calendar day? DATE_RE only proves the SHAPE — "2026-02-31"
 * passes it and reaches Postgres as a 22008, which surfaces as "could not save"
 * rather than "you typed a date that doesn't exist". Round-trip through a UTC
 * date: only a real day survives unchanged. */
function isRealDay(key: string): boolean {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

type Body = {
  classId?: string | null;
  studentId?: string | null;
  type?: string;
  body?: string;
  parentsOnly?: boolean;
  entryDate?: string | null;
};

export async function POST(request: Request) {
  if (!diaryEnabled()) {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  // Target: class-wide XOR personal (the 0018 shares idiom the table CHECKs).
  const classId = typeof body.classId === "string" && UUID_RE.test(body.classId) ? body.classId : null;
  const studentId = typeof body.studentId === "string" && UUID_RE.test(body.studentId) ? body.studentId : null;
  if ((classId ? 1 : 0) + (studentId ? 1 : 0) !== 1) {
    return NextResponse.json({ error: "A note goes to exactly one class OR one student." }, { status: 400 });
  }

  const noteType = NOTE_TYPES.includes(body.type as (typeof NOTE_TYPES)[number])
    ? (body.type as string)
    : "general";
  const text = (body.body ?? "").trim();
  if (!text) return NextResponse.json({ error: "The note is empty." }, { status: 400 });
  if (text.length > 4000) {
    return NextResponse.json({ error: "The note is too long (4000 characters max)." }, { status: 400 });
  }
  const parentsOnly = body.parentsOnly === true;

  // Optional entry date; omitted → today in the diary's civil zone, NOT the
  // DB's UTC current_date (see civilTodayKey above).
  const given = body.entryDate;
  const entryDate =
    typeof given === "string" && DATE_RE.test(given) && isRealDay(given) ? given : null;
  if (given != null && given !== "" && !entryDate) {
    return NextResponse.json({ error: "That isn't a real date (YYYY-MM-DD)." }, { status: 400 });
  }

  // Role shaping BEFORE the insert so denials read as intent, not RLS noise:
  // students never author notes, and a parent's reach is per-child only.
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  const role = (me?.role as string | null) ?? null;
  if (role === "student") {
    return NextResponse.json({ error: "Students reply to diary notes — they don't write them." }, { status: 403 });
  }
  if (role === "parent" && classId) {
    return NextResponse.json({ error: "Parents write notes about their own child, not a whole class." }, { status: 403 });
  }

  // Insert under the caller's session — dn_insert pins author_id to the caller
  // and proves teacher/parent standing over the target.
  const { data: row, error: iErr } = await supabase
    .from("diary_notes")
    .insert({
      author_id: user.id,
      class_id: classId,
      student_id: studentId,
      note_type: noteType,
      body: text,
      parents_only: parentsOnly,
      entry_date: entryDate ?? civilTodayKey(),
    })
    .select("id, entry_date")
    .single();
  if (iErr || !row) {
    // RLS denial → the caller has no standing over that class/student.
    if (iErr?.code === "42501") {
      return NextResponse.json({ error: "That class or student isn't yours to write to." }, { status: 403 });
    }
    return NextResponse.json({ error: iErr?.message ?? "Could not save the note." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: row.id, entryDate: row.entry_date });
}
