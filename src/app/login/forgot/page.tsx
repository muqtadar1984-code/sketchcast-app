import Link from "next/link";
import { LogoMark } from "../../dashboard/icons";
import ForgotForm from "./forgot-form";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";

// "I've forgotten my password". A Server Component so the copy comes from the
// request's dictionary even though nobody is signed in — the negotiated locale
// (cookie, then Accept-Language) still applies. The form itself is the client
// half; see ./forgot-form.
export default async function ForgotPasswordPage() {
  const locale = await resolveLocale();
  const t = await getDictionary(locale);
  return (
    <main className="min-h-screen flex items-center justify-center bg-[#FCFCFA] px-4">
      <div className="w-full max-w-sm card rounded-2xl p-8">
        <div className="flex items-center gap-2.5 mb-1">
          <LogoMark size={34} />
          <h1 className="text-2xl">
            SketchCast <span className="text-[#0C8175]">AI</span>
          </h1>
        </div>
        <p className="text-sm text-[#5B6470] mt-1 mb-6">{t.app.forgot.subtitle}</p>

        <ForgotForm t={t.app.forgot} />

        <p className="text-sm text-[#5B6470] mt-6 text-center">
          {t.app.forgot.remembered}{" "}
          <Link href="/login" className="text-[#0C8175] font-medium hover:underline">
            {t.app.forgot.backToSignIn}
          </Link>
        </p>
      </div>
    </main>
  );
}
