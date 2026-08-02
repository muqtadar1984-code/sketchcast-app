import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { i18nEnabled } from "@/utils/flags";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from "./locales";

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
//   3. Accept-Language           — the browser's own ranking, negotiated below
//   4. DEFAULT_LOCALE            — English, exactly today's behaviour
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

  const saved = await profileLocale();
  if (saved) return saved;

  const negotiated = negotiateLocale((await headers()).get("accept-language"));
  return negotiated ?? DEFAULT_LOCALE;
});

/** The signed-in user's saved preference, or null for anyone we can't ask. */
async function profileLocale(): Promise<Locale | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    // Best-effort by design: on a pre-0069 database PostgREST answers 42703
    // ("column does not exist"), which means "nobody has a saved language yet",
    // not "something is broken" — the header decides instead. Same for any
    // transient read failure.
    const { data, error } = await supabase.from("profiles").select("ui_locale").eq("id", user.id).maybeSingle();
    if (error || !data) return null;
    const saved = (data as { ui_locale?: string | null }).ui_locale ?? null;
    return isLocale(saved) ? saved : null;
  } catch {
    // Missing env vars, an unreachable auth server — never take the page down.
    return null;
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
