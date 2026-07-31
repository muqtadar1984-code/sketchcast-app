import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { diaryEnabled } from "@/utils/flags";

export const runtime = "nodejs";

// Class diary — reply on a note's thread (0066), or retract your own reply.
//
//   POST   { noteId, body, studentId? }
//   DELETE { id }   — the author retracts their own reply (dr_author_delete)
//
// Any PARTICIPANT on the note may reply: the author, the teacher side, the
// parent side, or the student the note concerns (never on parents_only rows —
// the helper excludes them by construction). Leadership reads but can't write.
// The insert runs under the CALLER'S session so RLS (dr_insert →
// diary_note_participant) is the authority.
//
// WHO A REPLY IS ABOUT (diary_replies.student_id, read by diary_reply_visible):
// on a CLASS-WIDE note the audience is thirty households, so a family's reply is
// scoped to that family and the school side — "Aisha's rash is better" must not
// broadcast. This route decides it; the client never has to:
//   · personal note      → the note's own student (its audience is one family);
//   · class-wide, author or the class's teacher → NULL (a real broadcast);
//   · student replying   → themselves;
//   · parent replying    → their child in that class (derived when they have
//                          exactly one; `studentId` picks when they have more).
// Anything a caller supplies is checked against their own children — a reply can
// never be filed under someone else's child.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = { noteId?: string; body?: string; studentId?: string };
type NoteRow = { author_id: string; class_id: string | null; student_id: string | null };

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
  if (!noteId) return NextResponse.json({ error: "A note id is required." }, { status: 400 });
  const askedStudent =
    typeof body.studentId === "string" && UUID_RE.test(body.studentId) ? body.studentId : null;
  if (body.studentId != null && body.studentId !== "" && !askedStudent) {
    return NextResponse.json({ error: "That child id isn't valid." }, { status: 400 });
  }
  const text = (body.body ?? "").trim();
  if (!text) return NextResponse.json({ error: "The reply is empty." }, { status: 400 });
  if (text.length > 2000) {
    return NextResponse.json({ error: "The reply is too long (2000 characters max)." }, { status: 400 });
  }

  // Who is this reply about? Read the note under the CALLER'S session — an
  // invisible note simply yields nothing here and the insert below produces the
  // usual RLS denial, so nothing leaks about notes the caller can't see.
  const { data: noteRow } = await supabase
    .from("diary_notes")
    .select("author_id, class_id, student_id")
    .eq("id", noteId)
    .maybeSingle();
  const note = noteRow as NoteRow | null;
  let replyStudent: string | null = null;

  if (note?.student_id) {
    // Personal note — one family already; carry its student so the row is
    // self-describing (dr_read doesn't need it here).
    replyStudent = note.student_id;
  } else if (note?.class_id && note.author_id !== user.id) {
    const [meQ, classQ, linksQ] = await Promise.all([
      supabase.from("profiles").select("role").eq("id", user.id).maybeSingle(),
      supabase.from("classes").select("teacher_id").eq("id", note.class_id).maybeSingle(),
      supabase.from("parent_links").select("child_id"),
    ]);
    const role = (meQ.data?.role as string | null) ?? null;
    // The class's own teacher speaks to the whole class, even when they also
    // happen to be a parent in it — decided by STANDING, not by profile role.
    const schoolSide = (classQ.data?.teacher_id as string | null) === user.id;

    if (role === "student") {
      // A student speaks for their own family. Nobody speaks for another child.
      if (askedStudent && askedStudent !== user.id) {
        return NextResponse.json({ error: "You can only reply about yourself." }, { status: 403 });
      }
      replyStudent = user.id;
    } else if (!schoolSide) {
      const childIds = ((linksQ.data ?? []) as { child_id: string }[]).map((l) => l.child_id);
      if (childIds.length) {
        const { data: enr } = await supabase
          .from("enrollments")
          .select("student_id")
          .eq("class_id", note.class_id)
          .in("student_id", childIds);
        const mine = [...new Set(((enr ?? []) as { student_id: string }[]).map((e) => e.student_id))];
        if (askedStudent) {
          if (!mine.includes(askedStudent)) {
            return NextResponse.json({ error: "That isn't your child in this class." }, { status: 403 });
          }
          replyStudent = askedStudent;
        } else if (mine.length === 1) {
          replyStudent = mine[0];
        } else if (mine.length > 1) {
          // Two children in one class: guessing would file the reply — and its
          // audience — under the wrong child, so ask instead.
          return NextResponse.json(
            { error: "Say which child this reply is about." },
            { status: 400 },
          );
        }
      }
    }
    // Everyone else (co-teacher, leadership) leaves it NULL: a class-visible
    // broadcast, which is also what RLS lets them write at most.
  }

  const insert = async (withStudent: boolean) =>
    supabase
      .from("diary_replies")
      .insert({
        note_id: noteId,
        author_id: user.id,
        body: text,
        ...(withStudent ? { student_id: replyStudent } : {}),
      })
      .select("id")
      .single();

  let res = await insert(true);
  // A database where 0066 ran BEFORE student_id existed (the migration's
  // `add column if not exists` is there for exactly those) rejects the column
  // outright. Don't lose the reply over it — save it unscoped; re-running 0066
  // restores family scoping for everything written afterwards.
  if (res.error && (res.error.code === "PGRST204" || /student_id/i.test(res.error.message ?? ""))) {
    console.error("diary.replies student_id unavailable:", res.error.message);
    res = await insert(false);
  }
  const { data: row, error: iErr } = res;
  if (iErr || !row) {
    // RLS denial → not a participant on that note (or the note doesn't exist —
    // indistinguishable by design, so nothing leaks about hidden notes).
    if (iErr?.code === "42501") {
      return NextResponse.json({ error: "You can't reply on that note." }, { status: 403 });
    }
    return NextResponse.json({ error: iErr?.message ?? "Could not save the reply." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: row.id, studentId: replyStudent });
}

// A thread is a record — there is no edit path — but the person who wrote a
// line can take it back, which is what the privacy policy promises and what
// dr_author_delete (author_id = auth.uid()) allows. Runs under the CALLER'S
// session, exactly like the note delete; the cached translation of the reply
// goes with it via 0066's diary_drop_translations trigger.
export async function DELETE(request: Request) {
  if (!diaryEnabled()) {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const id = typeof body.id === "string" && UUID_RE.test(body.id) ? body.id : null;
  if (!id) return NextResponse.json({ error: "A reply id is required." }, { status: 400 });

  // .select() so the deleted rows come BACK: someone else's reply doesn't raise
  // under RLS, it just matches nothing — zero rows IS the denial.
  const { data: gone, error: dErr } = await supabase
    .from("diary_replies")
    .delete()
    .eq("id", id)
    .select("id");
  if (dErr) {
    // 42501 = the policy refused outright (a suspended account hits the
    // RESTRICTIVE 0015 rule here).
    if (dErr.code === "42501") {
      return NextResponse.json({ error: "That isn't yours to delete." }, { status: 403 });
    }
    // Log the detail; never hand PostgREST internals to the client.
    console.error("diary.replies delete:", dErr.message);
    return NextResponse.json({ error: "Could not delete the reply." }, { status: 500 });
  }
  // Not-yours and never-existed read the same on purpose — nothing leaks about
  // threads the caller can't see.
  if (!gone?.length) {
    return NextResponse.json({ error: "That isn't yours to delete." }, { status: 403 });
  }

  return NextResponse.json({ ok: true });
}
