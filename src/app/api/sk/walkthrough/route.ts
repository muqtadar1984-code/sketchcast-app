import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import {
  catalogueTabEnabled,
  diaryEnabled,
  examGenerationEnabled,
  noticesEnabledFor,
  parentPortalEnabled,
  presentAllowed,
  roleHatsEnabled,
  schoolAnalyticsEnabledFor,
  skShellEnabledFor,
  timetableEnabledFor,
} from "@/utils/flags";
import { activeHatCookie } from "@/utils/hats-server";
import { chaptersFor } from "@/sk/kit-server";
import { walkRoleFor, type WalkFacts, type WalkRole } from "@/sk/walkthrough/stops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// SK's first-login walkthrough (founder 2026-10-30): what the tour needs to
// know about the caller to plan its stops — books, the first class, children,
// the first SK Tutor chapter, and the per-school switches. Called once when
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
  const facts: WalkFacts = { diary: diaryEnabled() };

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
        classId: (cls?.[0]?.id as string | undefined) ?? null,
        catalogue: catalogueTabEnabled(),
        exam: examGenerationEnabled(),
        timetable: !!schoolId && (await timetableEnabledFor(supabase, schoolId)),
        board: presentAllowed(user),
      });
    } else if (tour === "student") {
      facts.tutorPath = await firstTutorChapter(supabase, user.id);
    } else if (tour === "parent") {
      const { data: links } = await supabase.from("parent_links").select("verified_at, source").eq("parent_id", user.id);
      const rows = (links ?? []) as Array<{ verified_at: string | null; source: string | null }>;
      Object.assign(facts, {
        children: rows.length,
        verifiedChildren: rows.filter((l) => !!l.verified_at).length,
        schoolParent: rows.some((l) => l.source === "school"),
        parentPortal: parentPortalEnabled(),
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

/** The first chapter /sk would list (books by title, chapters in order). */
async function firstTutorChapter(supabase: Awaited<ReturnType<typeof createClient>>, userId: string): Promise<string | null> {
  if (process.env.NEXT_PUBLIC_FEATURE_SK !== "true") return null;
  const { data: products } = await supabase.from("sk_book_products").select("slug, title");
  const list = ((products ?? []) as Array<{ slug: string; title: string | null }>).sort((a, b) => (a.title ?? a.slug).localeCompare(b.title ?? b.slug));
  for (const p of list) {
    const entries = await chaptersFor(userId, p.slug);
    const first = entries[0];
    if (first) return `/sk/${p.slug}/${encodeURIComponent(first.chapterRef)}`;
  }
  return null;
}
