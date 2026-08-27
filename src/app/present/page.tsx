import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { presentAllowed } from "@/utils/flags";
import { shapeFromConfig, type Slot } from "@/utils/timetable";
import type { LastTaught } from "@/utils/present/context";
import PresentClient, { type BookOption, type ClassName } from "./present-client";

export const dynamic = "force-dynamic";

// Present mode — the board a teacher drives on a classroom panel.
//
// This server component does the two things a server must: it enforces the gate,
// and it fetches. It deliberately does NOT decide which period it is. Vercel runs
// in UTC and the classroom is not; the panel's own clock is the classroom's
// clock, so the context is resolved on the client from the data handed down
// here. A server-side "it is Period 3" would be wrong by eight hours in Malaysia
// and right nowhere in particular.
//
// EVERY PRESENT QUERY IS BEST-EFFORT. Migration 0097 may not be applied yet, and
// this app's rule is that a not-yet-run migration can never break a page (see
// the same guard around books.language in the dashboard). A missing table gives
// an empty pointer list and a bar that asks her to pick, which is exactly the
// first-lesson experience anyway.

export default async function PresentPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!presentAllowed(user)) redirect("/dashboard");

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role, school_id")
    .eq("id", user.id)
    .maybeSingle();
  const schoolId = (profile?.school_id as string | null) ?? null;

  // The school's period/day shape. No school, or no config, resolves to the
  // default shape — which is harmless: with no slots to match, the bar simply
  // reports that it does not know.
  let shape = shapeFromConfig(null);
  if (schoolId) {
    const { data: school } = await supabase
      .from("schools")
      .select("config")
      .eq("id", schoolId)
      .maybeSingle();
    shape = shapeFromConfig(school?.config ?? null);
  }

  const { data: slotRows } = await supabase
    .from("timetable_slots")
    .select("class_id, day, period, subject, teacher_id, kind")
    .eq("teacher_id", user.id);
  const slots = (slotRows ?? []) as Slot[];

  // Class names and grades for the bar. Through the service role for the same
  // reason my-timetable does it: a member's RLS view of classes is narrower than
  // the grid they can already see, and a bar reading "Class" helps nobody.
  const classIds = [...new Set(slots.map((s) => s.class_id))];
  let classes: ClassName[] = [];
  if (classIds.length) {
    try {
      const admin = createAdminClient();
      const { data } = await admin.from("classes").select("id, name, grade").in("id", classIds);
      classes = (data ?? []) as ClassName[];
    } catch {
      const { data } = await supabase.from("classes").select("id, name, grade").in("id", classIds);
      classes = (data ?? []) as ClassName[];
    }
  }

  // Where each of her classes has got to. Absent before 0097 — see the header.
  let lastTaught: LastTaught[] = [];
  try {
    const { data } = await supabase
      .from("present_last_taught")
      .select("class_id, subject, book_id, chapter_num, part")
      .eq("teacher_id", user.id);
    lastTaught = (data ?? []) as LastTaught[];
  } catch {
    lastTaught = [];
  }

  // The books she can teach from — the manual picker's options, and the only
  // path available on a first lesson with any class.
  const { data: bookRows } = await supabase
    .from("books")
    .select("id, title, grade, subject, chapters")
    .is("removed_at", null)
    .order("title");
  const books: BookOption[] = ((bookRows ?? []) as BookOption[]).map((b) => ({
    id: b.id,
    title: b.title,
    grade: b.grade ?? null,
    subject: b.subject ?? null,
    chapters: Array.isArray(b.chapters) ? b.chapters : [],
  }));

  return (
    <PresentClient
      teacherId={user.id}
      teacherName={(profile?.full_name as string | null) ?? null}
      shape={shape}
      slots={slots}
      classes={classes}
      lastTaught={lastTaught}
      books={books}
    />
  );
}
