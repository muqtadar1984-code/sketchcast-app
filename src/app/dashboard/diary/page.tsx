import { notFound, redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import {
  diaryEnabled,
  parentPortalEnabled,
  roleHatsEnabled,
  schoolAnalyticsEnabledFor,
  timetableEnabledFor,
} from "@/utils/flags";
import { hatsFor, resolveHat, type Hat } from "@/utils/hats";
import { activeHatCookie } from "@/utils/hats-server";
import { isDayKey } from "./date-nav";
import ParentDiary from "./parent-view";
import StudentDiary from "./student-view";
import TeacherDiary from "./teacher-view";

// The class diary — ONE url, role-branched worlds. This file stays a THIN
// switch: each world lives in its own server component next door
// (teacher-view.tsx / parent-view.tsx / student-view.tsx), so the branches
// evolve independently. Leadership never lands here — their read-only diary
// is /dashboard/school/diary.
//
// The branch never trusts the RAW hat cookie: hats are derived from what the
// account actually holds (hatsFor, the same inputs the header uses) and the
// cookie only PICKS among them (resolveHat), so a stale or forged cookie can
// only ever fall back to a held hat — never route someone into another world.

export const dynamic = "force-dynamic";

export default async function DiaryPage({
  searchParams,
}: {
  searchParams: Promise<{ d?: string; c?: string; as?: string }>;
}) {
  if (!diaryEnabled()) notFound();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { d, c, as } = await searchParams;

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, school_id")
    .eq("id", user.id)
    .maybeSingle();
  const role = (profile?.role as string | null) ?? null;
  const schoolId = (profile?.school_id as string | null) ?? null;

  // Opening the diary advances the seen-watermark (0066 column grant — the
  // bell idiom). Best-effort: a pre-0066 DB must never break the page.
  try {
    await supabase.from("profiles").update({ diary_seen_at: new Date().toISOString() }).eq("id", user.id);
  } catch {
    /* ignore */
  }

  // Students hold no hats — plain role check, straight to their read-only day.
  if (role === "student") return <StudentDiary date={d} />;

  // Parent standing: any adult with links (a parent account, or a teacher who
  // is also a parent) — pl_parent_read returns only the viewer's own links.
  let hasChildren = false;
  if (parentPortalEnabled()) {
    const { data: pl } = await supabase.from("parent_links").select("id").limit(1);
    hasChildren = (pl?.length ?? 0) > 0;
  }

  // One-hat mode: derive the held hats exactly as the header does, then let the
  // cookie choose among them (never the other way round).
  let hat: Hat | null = null;
  if (roleHatsEnabled()) {
    let hasScope = false;
    if ((role === "teacher" || role === "coordinator") && schoolId) {
      // RLS cs_self_read + school filter: only grants in the CURRENT school
      // count (a stale grant from a school this user has left is not a hat).
      const { data: sc } = await supabase
        .from("coordinator_scope")
        .select("id")
        .eq("school_id", schoolId)
        .limit(1);
      hasScope = (sc?.length ?? 0) > 0;
    }
    const hats = hatsFor({
      role,
      hasScope,
      hasChildren,
      analyticsOn: await schoolAnalyticsEnabledFor(supabase, schoolId),
      timetableOn: schoolId ? await timetableEnabledFor(supabase, schoolId) : false,
      diaryOn: diaryEnabled(), // true here — the page 404s above when it isn't
    });
    hat = resolveHat(await activeHatCookie(), hats);
  }

  // One-hat mode: a leadership hat's diary is the read-only school surface.
  if (hat === "principal" || hat === "coordinator") redirect("/dashboard/school/diary");

  // Union mode (FEATURE_ROLE_HATS off): a teacher-role adult with linked
  // children holds BOTH worlds and has no hat switcher, so ?as=parent is the
  // door to theirs — surfaced as a small link on each view, the same way the
  // union header carries both doors (Library + My Children) side by side.
  const dual = !roleHatsEnabled() && role !== "parent" && hasChildren;
  const keepDay = isDayKey(d) ? `d=${d}` : "";

  // Parent world: the parent-role account, an adult wearing the Parent hat, or
  // a union-mode dual-identity adult who asked for it.
  if (role === "parent" || hat === "parent" || (dual && as === "parent"))
    return <ParentDiary date={d} teacherHref={dual ? `/dashboard/diary${keepDay ? `?${keepDay}` : ""}` : null} />;

  // Teacher world (plain teachers, and admins/coordinators in Teacher mode):
  // their own classes, compose + the class day. ?c= picks the class.
  return (
    <TeacherDiary
      date={d}
      classParam={c}
      parentHref={dual ? `/dashboard/diary?as=parent${keepDay ? `&${keepDay}` : ""}` : null}
    />
  );
}
