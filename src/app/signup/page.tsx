import { Suspense } from "react";
import Link from "next/link";
import { LogoMark } from "../dashboard/icons";
import AuthError from "@/components/auth-error";
import SignupForm from "./signup-form";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";

// Self-signup. A Server Component around the client form, so the headings and
// links resolve from the request's dictionary while nobody is signed in yet.
export default async function SignupPage() {
  const locale = await resolveLocale();
  const t = await getDictionary(locale);
  return (
    <main className="min-h-screen flex items-center justify-center bg-[#FCFCFA] px-4">
      <div className="w-full max-w-sm card rounded-2xl p-8">
        <div className="flex items-center gap-2.5 mb-1">
          <LogoMark size={34} />
          <h1 className="text-2xl">{t.app.signup.title}</h1>
        </div>
        <p className="text-sm text-[#5B6470] mt-1 mb-6">{t.app.signup.subtitle}</p>

        <Suspense fallback={null}>
          <AuthError />
        </Suspense>

        <SignupForm t={t.app.signup} auth={t.app.auth} oauth={t.app.oauth} />

        <p className="text-sm text-[#5B6470] mt-6 text-center">
          {t.app.auth.alreadyHaveAccount}{" "}
          <Link href="/login" className="text-[#0C8175] font-medium hover:underline">
            {t.app.auth.signIn}
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
