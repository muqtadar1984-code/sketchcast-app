import { Suspense } from "react";
import Link from "next/link";
import { LogoMark } from "../dashboard/icons";
import OAuthButton from "@/components/oauth-button";
import AuthError from "@/components/auth-error";
import LoginForm from "./login-form";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";

// Sign-in. A SERVER component so the page's own words come from the request's
// dictionary — resolveLocale() works signed-OUT too (the sc_locale cookie, then
// Accept-Language), which is the whole reason a parent who reads no English can
// get past this screen. The two interactive pieces (the form, the OAuth button)
// are client components handed exactly the strings they render.
export default async function LoginPage() {
  const locale = await resolveLocale();
  const t = await getDictionary(locale);
  return (
    <main className="min-h-screen flex items-center justify-center bg-[#FCFCFA] px-4">
      <div className="w-full max-w-sm card rounded-2xl p-8">
        <div className="flex items-center gap-2.5 mb-1">
          <LogoMark size={34} />
          {/* The product name is a name, in every language — never translated. */}
          <h1 className="text-2xl">
            SketchCast <span className="text-[#0C8175]">AI</span>
          </h1>
        </div>
        <p className="text-sm text-[#5B6470] mt-1 mb-6">{t.app.login.subtitle}</p>

        <Suspense fallback={null}>
          <AuthError />
          <LoginForm t={t.app.login} auth={t.app.auth} />
        </Suspense>

        <div className="flex items-center gap-3 my-5">
          <span className="h-px flex-1 bg-[#E6E8E4]" />
          <span className="text-xs text-[#98A0A9]">{t.app.auth.or}</span>
          <span className="h-px flex-1 bg-[#E6E8E4]" />
        </div>
        <OAuthButton provider="google" mode="in" t={t.app.oauth} />

        <p className="text-sm text-[#5B6470] mt-6 text-center">
          {t.app.login.newHere}{" "}
          <Link href="/signup" className="text-[#0C8175] font-medium hover:underline">
            {t.app.login.createAccount}
          </Link>
        </p>
        <p className="text-xs text-[#98A0A9] mt-2 text-center">
          {t.app.auth.schoolPrompt}{" "}
          <Link href="/schoolsignup" className="text-[#0C8175] hover:underline">
            {t.app.auth.schoolCta}
          </Link>
        </p>
      </div>
    </main>
  );
}
