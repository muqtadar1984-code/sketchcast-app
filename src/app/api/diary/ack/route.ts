import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { diaryEnabled } from "@/utils/flags";

export const runtime = "nodejs";

// Class diary — a parent "signs the diary" (0066). One ack per (note × parent ×
// child): a parent with two children in the same class signs once per child.
// Insert-only — a receipt, not a toggle. The insert runs under the CALLER'S
// session so RLS (da_insert) proves: caller is the child's parent, can read the
// note, and the note actually concerns that child.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = { noteId?: string; studentId?: string };

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

  const noteId = typeof body.noteId === "string" && UUID_RE.test(body.noteId) ? body.noteId : null;
  const studentId = typeof body.studentId === "string" && UUID_RE.test(body.studentId) ? body.studentId : null;
  if (!noteId || !studentId) {
    return NextResponse.json({ error: "A note id and a child are required." }, { status: 400 });
  }

  const { error: iErr } = await supabase
    .from("diary_acks")
    .insert({ note_id: noteId, parent_id: user.id, student_id: studentId });
  if (iErr) {
    // Signing twice is fine — the receipt already exists.
    if (iErr.code === "23505") return NextResponse.json({ ok: true, already: true });
    // RLS denial → not this caller's child, or the note isn't theirs to sign.
    if (iErr.code === "42501") {
      return NextResponse.json({ error: "You can't sign that note for that child." }, { status: 403 });
    }
    return NextResponse.json({ error: iErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
