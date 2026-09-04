import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { LogoMark } from "../../dashboard/icons";
import FinishForm from "./finish-form";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { fmt } from "@/i18n/format";
import { countryFromHeaders } from "@/utils/geo";
import { schoolHostname } from "@/utils/school-routing";

// Both signup paths (email + Google) land here after auth to set up the
// school (0101, Phase 3). A Server Component: it resolves the copy, the edge's
// country guess and the Turnstile site key, and hands them to the form.
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
  const country = countryFromHeaders(await headers());
  // The widget renders only when the key exists; the route verifies only when
  // the secret does (utils/turnstile.ts explains the pairing).
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || null;
  const schoolHost = schoolHostname() ?? "school.sketchcast.app";
  // /terms and /privacy exist on the marketing site in every locale, under the
  // locale prefix for all but English.
  const legalBase = locale === "en" ? "https://sketchcast.app" : `https://sketchcast.app/${locale}`;

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#FCFCFA] px-4 py-10">
      <div className="w-full max-w-lg card rounded-2xl p-8">
        <div className="flex items-center gap-2.5 mb-1">
          <LogoMark size={34} />
          <h1 className="text-2xl">{t.app.schoolSignup.finish.title}</h1>
        </div>
        <p className="text-sm text-[#5B6470] mt-1 mb-6">
          {fmt(t.app.schoolSignup.finish.signedInAs, { email: user.email ?? "" })}
        </p>
        <FinishForm
          t={t.app.schoolSignup.finish}
          common={t.common}
          locale={locale}
          country={country}
          siteKey={siteKey}
          schoolHost={schoolHost}
          legalBase={legalBase}
        />
      </div>
    </main>
  );
}
