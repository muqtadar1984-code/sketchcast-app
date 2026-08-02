import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { LogoMark } from "../../dashboard/icons";
import FinishForm from "./finish-form";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { fmt } from "@/i18n/format";

// Both signup paths (email + Google) land here after auth to name the new school.
export default async function SchoolFinishPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/schoolsignup");

  const { data: profile } = await supabase
    .from("profiles")
    .select("school_id")
    .eq("id", user.id)
    .single();
  // Already part of a school → nothing to set up here.
  if (profile?.school_id) redirect("/dashboard");

  const locale = await resolveLocale();
  const t = await getDictionary(locale);

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#FCFCFA] px-4">
      <div className="w-full max-w-sm card rounded-2xl p-8">
        <div className="flex items-center gap-2.5 mb-1">
          <LogoMark size={34} />
          <h1 className="text-2xl">{t.app.schoolSignup.finish.title}</h1>
        </div>
        <p className="text-sm text-[#5B6470] mt-1 mb-6">
          {fmt(t.app.schoolSignup.finish.signedInAs, { email: user.email ?? "" })}
        </p>
        <FinishForm t={t.app.schoolSignup.finish} common={t.common} />
      </div>
    </main>
  );
}
