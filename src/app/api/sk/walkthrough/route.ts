import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import {
  calendarEnabledFor,
  catalogueTabEnabled,
  diaryEnabled,
  examGenerationEnabled,
  noticesEnabledFor,
  parentPortalEnabled,
  platformConsoleEnabled,
  presentAllowed,
  roleHatsEnabled,
  schoolAnalyticsEnabledFor,
  skShellEnabledFor,
  timetableEnabledFor,
} from "@/utils/flags";
import { activeHatCookie } from "@/utils/hats-server";
import { walkRoleFor, type WalkFacts, type WalkRole } from "@/sk/walkthrough/stops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// SK's first-login walkthrough (founder 2026-10-30): what the tour needs to
// know about the caller to plan its stops — books (and the one the Library
// stops open), the first class, children, and the per-school switches. (SK
// Tutor is retired, 2026-10-31: no tutor chapter or tab fact.) Called once when
// a tour starts (never on page load).
//
// READ-ONLY: every query is a select through the caller's own session (RLS).
// No model call, no write, no audit row. Gated exactly like the Shell
// (skShellEnabledFor); anyone else gets 404.

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role, school_id").eq("id", user.id).maybeSingle();
  const role = (profile?.role as string | null) ?? null;
  const schoolId = (profile?.school_id as string | null) ?? null;
  if (!(await skShellEnabledFor(supabase, user, role, schoolId))) return NextResponse.json({ error: "Not available." }, { status: 404 });

  const hat = await activeHatCookie();
  const tour: WalkRole = walkRoleFor(role, hat);
  // reportIssue: the floating "Report a problem" widget renders (every role's
  // dashboard shows it under this flag) — else the tour's report stop skips.
  const facts: WalkFacts = { diary: diaryEnabled(), reportIssue: platformConsoleEnabled() };

  try {
    if (tour === "teacher") {
      const own = await supabase.from("books").select("id", { count: "exact", head: true }).eq("owner_id", user.id);
      let books = (own.count ?? 0) > 0;
      if (!books && schoolId) {
        const shelf = await supabase.from("books").select("id", { count: "exact", head: true }).eq("school_id", schoolId);
        books = (shelf.count ?? 0) > 0;
      }
      // The Library lists classes newest first; "the first class" is that one.
      const { data: cls } = await supabase.from("classes").select("id").eq("teacher_id", user.id).order("created_at", { ascending: false }).limit(1);
      Object.assign(facts, {
        books,
        bookId: books ? await tourBook(supabase, user.id) : null,
        classId: (cls?.[0]?.id as string | undefined) ?? null,
        catalogue: catalogueTabEnabled(),
        exam: examGenerationEnabled(),
        timetable: !!schoolId && (await timetableEnabledFor(supabase, schoolId)),
        calendar: await calendarEnabledFor(supabase, schoolId),
        board: presentAllowed(user),
      });
    } else if (tour === "student") {
      // Nothing beyond the shared facts (diary, reportIssue).
    } else if (tour === "parent") {
      const { data: links } = await supabase.from("parent_links").select("verified_at, source").eq("parent_id", user.id);
      const rows = (links ?? []) as Array<{ verified_at: string | null; source: string | null }>;
      Object.assign(facts, {
        children: rows.length,
        verifiedChildren: rows.filter((l) => !!l.verified_at).length,
        schoolParent: rows.some((l) => l.source === "school"),
        parentPortal: parentPortalEnabled(),
        catalogue: catalogueTabEnabled(),
      });
    } else {
      Object.assign(facts, {
        analytics: await schoolAnalyticsEnabledFor(supabase, schoolId),
        timetable: await timetableEnabledFor(supabase, schoolId),
        notices: await noticesEnabledFor(supabase, schoolId),
        roleHats: roleHatsEnabled(),
      });
    }
  } catch (e) {
    // A failed read leaves that fact unknown: the tour still plays, and the
    // anchor wait skips whatever is not on the page.
    console.warn("[sk] walkthrough facts:", (e as Error).message);
  }

  return NextResponse.json({ role: tour, facts }, { headers: { "cache-control": "no-store" } });
}

/** The book the teacher's Library stops open (`/dashboard?book=<id>` opens its
 *  row, so its chapters, parts and kits are on the page): the newest of their
 *  OWN books with a finished lesson — so Assign, the downloads and the
 *  new-version control have something to point at — else their newest own
 *  book. Only their own: a school-shelf book may sit in the closed "also in
 *  your school" list, where nothing is visible. Null = no own book. */
async function tourBook(supabase: Awaited<ReturnType<typeof createClient>>, userId: string): Promise<string | null> {
  const { data: own } = await supabase.from("books").select("id").eq("owner_id", userId).eq("status", "ready").order("created_at", { ascending: false }).limit(50);
  const ids = ((own ?? []) as Array<{ id: string }>).map((b) => b.id);
  if (!ids.length) return null;
  const { data: done } = await supabase
    .from("generations")
    .select("book_id")
    .eq("owner_id", userId)
    .eq("kind", "presentation")
    .eq("status", "done")
    .in("book_id", ids)
    .order("created_at", { ascending: false })
    .limit(1);
  return ((done?.[0]?.book_id as string | undefined) ?? ids[0]) || null;
}
