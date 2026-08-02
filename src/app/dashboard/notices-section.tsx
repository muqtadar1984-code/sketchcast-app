import { createClient } from "@/utils/supabase/server";
import { noticesFor } from "@/utils/notices";
import NoticeBanner from "./notice-banner";
import NoticesCard from "./notices-card";

// The notices pair — the pinned banner and the "next 10" list — as one
// self-contained block for the surfaces that OWN notices: the Diary, in each
// of its four worlds (teacher, parent, student, and leadership's read-only
// school diary).
//
// It fetches its own viewer rather than taking props, because the four call
// sites hold different fragments of one: the teacher and student diaries have
// a school_id but no role, the parent diary reaches its schools through
// parent_links, and only the school diary has both. One small RLS-scoped
// profile read here beats four call sites each plumbing a different subset —
// the same reasoning as fair-use-meter.tsx.
//
// The Library, the parent home and the student dashboard keep their OWN inline
// <NoticeBanner> (they already fetch notices for it): an urgent notice still
// interrupts where people work, while the browsable list lives in one place.
// Both children resolve their own dictionary, so nothing is passed down.
//
// ⚠️ The list is not only a list — <NoticesCard> carries the ONLY Acknowledge
// control in the product (the banner has none), and a signature is what a
// staff notice and an important Everyone notice actually ask for. So wherever
// this list is absent, nobody can sign. That is why the three surfaces above
// fall BACK to rendering the card when the Diary is unreachable (diaryReachable
// in each of them): FEATURE_DIARY is an independent flag from FEATURE_NOTICES,
// and a tenant with notices on and the diary off must not lose signing
// entirely — which is exactly what moving the card here would otherwise do.
export default async function NoticesSection({
  banner = true,
  list = true,
}: {
  banner?: boolean;
  list?: boolean;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, school_id")
    .eq("id", user.id)
    .maybeSingle();

  // Returns null when the feature is off, or when this viewer's school hasn't
  // got it — including the parent's school-through-children fallback.
  const notices = await noticesFor(supabase, {
    userId: user.id,
    role: (profile?.role as string | null) ?? null,
    schoolId: (profile?.school_id as string | null) ?? null,
  });
  if (!notices) return null;

  return (
    <>
      {banner && <NoticeBanner notices={notices.featured} />}
      {list && <NoticesCard notices={notices.upcoming} />}
    </>
  );
}
