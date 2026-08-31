import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { i18nEnabled } from "@/utils/flags";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from "./locales";
import { localeForCountry } from "./country-locale";
import { countryFromHeaders } from "@/utils/geo";

// Which language THIS request is rendered in.
//
// There is no /[lang] segment: the portal is auth-gated and dynamic, so a
// locale in the URL would buy nothing and cost a 39-route restructure. The
// locale is negotiated per request instead, in this order:
//
//   1. the sc_locale COOKIE      — an explicit pick, so it outranks everything
//                                  (and it is what a signed-OUT visitor on the
//                                  login page can still set)
//   2. profiles.ui_locale        — the durable preference (0069), which carries
//                                  the choice to a new browser or device
//   3. Accept-Language           — the browser's own ranking, negotiated below,
//                                  but only when it names a language that is
//                                  NOT English
//   4. the COUNTRY               — profiles.country (0085) if we have one, else
//                                  the CDN's guess for this request, mapped
//                                  through ./country-locale
//   5. Accept-Language / DEFAULT — English, exactly today's behaviour
//
// STEP 4 IS THE ONE THAT NEEDS DEFENDING. A teacher in Egypt whose phone shipped
// with an English system locale sends `Accept-Language: en-US`, and until now
// read an English portal while we generated their lessons in Arabic. Country is
// the only other evidence there is. It is deliberately placed BELOW the browser
// rather than above it, so it can only ever displace ENGLISH: a browser that
// positively asks for French keeps French, wherever the reader happens to be.
// The cookie and the saved preference both still outrank it, so one click in the
// switcher settles the question permanently for anyone we guess wrong about.
//
// EVERY step degrades to the next one rather than failing: no session, a
// pre-0069 database with no ui_locale column, a Supabase blip — the page still
// renders, in the best language we can prove. This runs in the ROOT layout, so
// a throw here would be a white screen for the whole app.
//
// React `cache` dedupes it: the root layout, the dashboard layout and a page
// can each ask, and only the first pays for the profile read.

/** The best of our ten locales for the current request. */
export const resolveLocale = cache(async (): Promise<Locale> => {
  // Dark until the rollout finishes. Detection is the dangerous half: without
  // this, an ar-* browser gets dir="rtl" document-wide the moment this merges,
  // wrapped around whatever is still English. Off ⇒ exactly today's behaviour.
  if (!i18nEnabled()) return DEFAULT_LOCALE;

  const store = await cookies();
  const chosen = store.get(LOCALE_COOKIE)?.value;
  if (isLocale(chosen)) return chosen;

  const prefs = await profilePrefs();
  if (prefs.locale) return prefs.locale;

  const h = await headers();
  const negotiated = negotiateLocale(h.get("accept-language"));
  // A positively-asked-for language always wins. English is the one answer we
  // treat as "no answer", because it is what an unconfigured device sends.
  if (negotiated && negotiated !== DEFAULT_LOCALE) return negotiated;

  // The user's own stated country first; the edge's guess only for someone who
  // hasn't got one yet (a visitor on the login page, a brand-new account).
  const implied = localeForCountry(prefs.country ?? countryFromHeaders(h));
  if (implied) return implied;

  return negotiated ?? DEFAULT_LOCALE;
});

type Prefs = { locale: Locale | null; country: string | null };
const NO_PREFS: Prefs = { locale: null, country: null };

/** The signed-in user's saved language AND stated country, in ONE read — steps
 * 2 and 4 above both need the profile, and this resolver runs on every server
 * render. Nulls for anyone we can't ask. */
async function profilePrefs(): Promise<Prefs> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NO_PREFS;
    // Best-effort by design: on a pre-0069 database PostgREST answers 42703
    // ("column does not exist"), which means "nobody has a saved language yet",
    // not "something is broken" — the header decides instead. Same for any
    // transient read failure.
    //
    // The retry is not belt-and-braces: `country` arrived in 0085, sixteen
    // migrations after ui_locale, so a database part-way between the two
    // answers 42703 for the PAIR and would lose the saved language along with
    // the country. Asking again for the older column alone costs one round trip
    // on a path that is already failing, and keeps the language working.
    let row = await supabase.from("profiles").select("ui_locale, country").eq("id", user.id).maybeSingle();
    if (row.error) {
      row = await supabase.from("profiles").select("ui_locale").eq("id", user.id).maybeSingle();
    }
    if (row.error || !row.data) return NO_PREFS;
    const d = row.data as { ui_locale?: string | null; country?: string | null };
    return {
      locale: isLocale(d.ui_locale) ? d.ui_locale : null,
      country: d.country ?? null,
    };
  } catch {
    // Missing env vars, an unreachable auth server — never take the page down.
    return NO_PREFS;
  }
}

/**
 * Pick the best of our ten locales from an Accept-Language header, with no
 * dependency: parse the "tag;q=0.8" pairs, drop q=0, sort by quality (the sort
 * is stable, so equally-weighted tags keep the browser's own order), then walk
 * each tag from its most specific form down to the bare language —
 * "ms-Arab-MY" → "ms-arab" (Jawi!) → "ms", "pt-BR" → "pt", "en-US" → "en".
 *
 * "*" is skipped rather than honoured: it means "anything", which is what the
 * DEFAULT_LOCALE fallback already does, and treating it as a match would let it
 * beat a real, lower-ranked language the reader actually asked for.
 *
 * Exported for its own sake — it is pure, and the one piece here worth testing.
 */
export function negotiateLocale(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().toLowerCase().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const quality = q ? Number.parseFloat(q.slice(2)) : 1;
      return { tag: tag.trim(), quality: Number.isFinite(quality) ? quality : 0 };
    })
    .filter((e) => e.tag && e.tag !== "*" && e.quality > 0)
    .sort((a, b) => b.quality - a.quality);

  for (const { tag } of ranked) {
    const subtags = tag.split("-");
    for (let i = subtags.length; i > 0; i--) {
      const candidate = subtags.slice(0, i).join("-");
      if (isLocale(candidate)) return candidate;
    }
  }
  return null;
}
