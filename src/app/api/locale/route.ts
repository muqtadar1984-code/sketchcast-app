import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { LOCALE_COOKIE, isLocale } from "@/i18n/locales";

export const runtime = "nodejs";

// Set the interface language. Two writes, deliberately unequal:
//
//   · the sc_locale COOKIE is the one that must succeed — it is what
//     resolveLocale() reads first on the very next request, so it is what makes
//     the switch visible. Not httpOnly: it carries a preference, never a
//     credential, and the switcher reads it to show the current pick.
//   · profiles.ui_locale (0069) is the durable copy that carries the choice to
//     the user's next browser. Best-effort — a signed-OUT visitor (the login
//     page has a switcher too) has no row to write, and a pre-0069 database has
//     no column. Neither is a reason to refuse the language.
//
// Hence no 401 and no feature flag, unlike the diary routes: there is nothing
// here to protect. The only hard failure is an unknown locale, which would be a
// 500 on every subsequent page (the dictionary loader maps the code straight to
// an import), so it is validated against the registry before anything is set.

export async function POST(request: Request) {
  let body: { locale?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const locale = body.locale;
  if (!isLocale(locale)) {
    return NextResponse.json({ error: "That language isn't supported." }, { status: 400 });
  }

  let saved = false;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      // Column-level grant (0069) + the profiles_update_self row policy: the
      // caller can only ever write their own language. 42703 = pre-0069
      // database, 42501 = migration run without the grant — both mean "the
      // preference doesn't persist yet", never "the switch failed".
      const { error } = await supabase.from("profiles").update({ ui_locale: locale }).eq("id", user.id);
      if (error) console.error("locale.persist:", error.code, error.message);
      else saved = true;
    }
  } catch (e) {
    console.error("locale.persist:", (e as Error).message);
  }

  const res = NextResponse.json({ ok: true, locale, saved });
  res.cookies.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false, // the client switcher reads it — see the note above
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
