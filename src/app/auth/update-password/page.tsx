import { LogoMark } from "../../dashboard/icons";
import UpdatePasswordForm from "./update-password-form";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";

// The "choose a new password" screen. A Server Component wrapper so the copy
// comes from the request's dictionary — a student sent here by a forced reset,
// or a parent following a recovery link, reads it in their own language before
// they have a dashboard to change it from. The session check and the update
// itself stay in the client half (see ./update-password-form).
export default async function UpdatePasswordPage() {
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
        <p className="text-sm text-[#5B6470] mt-1 mb-6">{t.app.updatePassword.subtitle}</p>

        <UpdatePasswordForm t={t.app.updatePassword} auth={t.app.auth} common={t.common} />
      </div>
    </main>
  );
}
