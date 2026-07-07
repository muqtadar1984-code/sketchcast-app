import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { aiTutorEnabled } from "@/utils/flags";
import { resolveTutorContext, loadGrounding, buildMastery } from "@/utils/tutor/service";

export const runtime = "nodejs";

// Coach recap — the AGGREGATE view for the student, their teacher, or their
// parent: chapter-mastery band, quiz score, practice count, and the weak spots.
// It deliberately exposes NO raw chat (privacy). Access is one of:
//   • the student themselves,
//   • the teacher who owns the lesson (generation.owner_id),
//   • a VERIFIED linked parent of that student.
export async function GET(request: Request) {
  if (!aiTutorEnabled()) return NextResponse.json({ error: "Not available." }, { status: 404 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const url = new URL(request.url);
  const generationId = url.searchParams.get("generationId") ?? "";
  const studentId = url.searchParams.get("studentId") ?? "";
  if (!generationId || !studentId) return NextResponse.json({ error: "Missing parameters." }, { status: 400 });

  const admin = createAdminClient();

  // Authorise the requester against this (student, generation).
  let allowed = user.id === studentId;
  if (!allowed) {
    const { data: gen } = await admin.from("generations").select("owner_id").eq("id", generationId).maybeSingle();
    if (gen?.owner_id === user.id) allowed = true;
  }
  if (!allowed) {
    const { data: link } = await admin
      .from("parent_links")
      .select("id")
      .eq("parent_id", user.id)
      .eq("child_id", studentId)
      .not("verified_at", "is", null)
      .maybeSingle();
    if (link) allowed = true;
  }
  if (!allowed) return NextResponse.json({ error: "Not your student." }, { status: 403 });

  // The lesson must actually be assigned to this student (student_progress row).
  const ctx = await resolveTutorContext(admin, studentId, generationId);
  if (!ctx) return NextResponse.json({ error: "This lesson isn't assigned to that student." }, { status: 404 });

  const grounding = await loadGrounding(admin, ctx.bookId, ctx.chapterNum);
  const chapterTitle = grounding?.chapterTitle ?? "this chapter";
  const { mastery, practiceCount, model } = await buildMastery(admin, studentId, ctx.bookId, ctx.chapterNum, chapterTitle);

  return NextResponse.json({
    chapterTitle,
    attempted: model.attempted,
    scorePct: model.scorePct,
    mastery, // { score, band, label }
    practiceCount,
    weakQuestions: model.weakQuestions,
  });
}
