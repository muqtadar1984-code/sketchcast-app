import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import AppHeader from "../app-header";
import { InkUnderline } from "@/components/ink-mark";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { loadSkSettings, type SettingsDb } from "@/sk/settings";
import { dateFmt, privacyProps } from "./lines";
import SkPrivacy from "./sk-privacy";

export const dynamic = "force-dynamic";

// /dashboard/settings — "SK & privacy" (SK S6 slice C; design decisions 2, 5,
// 7; Final Plan §9.5). Every signed-in user: the three SK preferences (stored
// as workflow facts, so they follow the user across devices), what SK
// remembers, and "Delete my SK memory". A verified parent: per child, SK
// learning memory (`transcripts`) and voice input (`voice`), and deleting the
// child's SK memory. A principal: the school's learning-memory switch. A
// student: whether their memory is on and who turned it on (never a switch).
//
// The data is read here, on the server (src/sk/settings.ts loadSkSettings —
// session reads, plus the service role only for the consent / school rows the
// session cannot see); the controls are a client island that calls the
// routes. Nothing on this page sends anything to anyone.

export default async function SettingsPage() {
  const locale = await resolveLocale();
  const dict = await getDictionary(locale);
  const t = dict.settings;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("role, school_id").eq("id", user.id).maybeSingle();
  const role = (profile?.role as string | null) ?? null;
  const schoolId = (profile?.school_id as string | null) ?? null;
  let admin: SettingsDb | null = null;
  try {
    admin = createAdminClient() as unknown as SettingsDb;
  } catch {
    admin = null;
  }
  const data = await loadSkSettings({ session: supabase as unknown as SettingsDb, admin, userId: user.id, role, schoolId });
  const props = privacyProps(t, data, dateFmt(locale));

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <h1 className="text-3xl sm:text-4xl mb-2">{t.title}</h1>
        <InkUnderline className="block h-3 w-28 mb-6" />
        <SkPrivacy {...props} />
      </main>
    </div>
  );
}
