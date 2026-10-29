import type { ReactNode } from "react";
import { createClient } from "@/utils/supabase/server";
import { skTutorShellEnabledFor } from "@/utils/flags";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import SkTutorLauncher from "./sk-tutor-launcher";

// SK S3 slice D — the SK Shell for students on /sk. The pages under /sk keep
// every gate of their own (each one 404s on its own terms); this layout only
// adds the Shell's launcher, and only when skTutorShellEnabledFor() passes:
// the /sk gate (NEXT_PUBLIC_FEATURE_SK + FEATURE_SK, signed in, on
// SK_ALLOWED_EMAILS while that is set) AND the Shell's own (SK_ROLES must
// include the role — "student" is not in the default "teacher" — and the
// tenant opt-in). So the Shell can never reach anyone the tutor pages would
// turn away. The /api/sk/shell/* routes re-check on every call.

export default async function SkLayout({ children }: { children: ReactNode }) {
  let on = false;
  let role: string | null = null;
  try {
    if (process.env.NEXT_PUBLIC_FEATURE_SK === "true") {
      const supabase = await createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase.from("profiles").select("role, school_id").eq("id", user.id).maybeSingle();
        role = (profile?.role as string | null) ?? null;
        on = await skTutorShellEnabledFor(supabase, user, role, (profile?.school_id as string | null) ?? null);
      }
    }
  } catch (e) {
    // The pages render without the Shell rather than failing on its account.
    console.error("[sk] shell gate:", (e as Error).message);
    on = false;
  }
  if (!on) return <>{children}</>;
  const t = await getDictionary(await resolveLocale());
  return (
    <>
      {children}
      <SkTutorLauncher copy={t.sk.shell} tourCopy={t.app.tour} role={role} />
    </>
  );
}
