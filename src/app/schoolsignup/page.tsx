import { Suspense } from "react";
import { headers } from "next/headers";
import Link from "next/link";
import { LogoMark } from "../dashboard/icons";
import OAuthButton from "@/components/oauth-button";
import AuthError from "@/components/auth-error";
import SchoolSignupForm from "./schoolsignup-form";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { countryFromHeaders } from "@/utils/geo";

// Public "Set up your school" (option C). Create an account (email or Google),
// then name your NEW school on the next step and become its admin. Both paths
// funnel through /schoolsignup/finish. A Server Component so the copy resolves
// from the request's dictionary before anyone signs in.
export default async function SchoolSignupPage() {
  const locale = await resolveLocale();
  const t = await getDictionary(locale);
  // Same capture as /signup: read on the server, sent back with the
  // registration so 0098's trigger can stamp it at INSERT. This path stamps
  // onboarded_at at creation and therefore NEVER sees the onboarding step that
  // asks for a country — without this it would have no country, ever.
  const country = countryFromHeaders(await headers());
  return (
    <main className="min-h-screen flex items-center justify-center bg-[#FCFCFA] px-4">
      <div className="w-full max-w-sm card rounded-2xl p-8">
        <div className="flex items-center gap-2.5 mb-1">
          <LogoMark size={34} />
          <h1 className="text-2xl">{t.app.schoolSignup.title}</h1>
        </div>
        <p className="text-sm text-[#5B6470] mt-1 mb-6">{t.app.schoolSignup.subtitle}</p>

        <Suspense fallback={null}>
          <AuthError />
        </Suspense>

        <SchoolSignupForm t={t.app.schoolSignup} country={country} />

        <div className="flex items-center gap-3 my-5">
          <span className="h-px flex-1 bg-[#E6E8E4]" />
          <span className="text-xs text-[#98A0A9]">{t.app.auth.or}</span>
          <span className="h-px flex-1 bg-[#E6E8E4]" />
        </div>
        <OAuthButton provider="google" mode="up" next="/schoolsignup/finish" t={t.app.oauth} />
        <p className="text-xs text-[#98A0A9] mt-3">{t.app.schoolSignup.nextStepHint}</p>

        <p className="text-sm text-[#5B6470] mt-6 text-center">
          {t.app.auth.alreadyHaveAccount}{" "}
          <Link href="/login" className="text-[#0C8175] font-medium hover:underline">
            {t.app.auth.signIn}
          </Link>
        </p>
      </div>
    </main>
  );
}
