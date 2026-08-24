// FIRST-TOUCH ATTRIBUTION — where a visitor came from, decided once.
//
// FIRST touch, not last: the question worth answering is "what introduced this
// person to SketchCast", and by the time they sign up they have usually bounced
// through the landing page, a pricing page and a login screen, every one of
// which would overwrite a last-touch value with something internal and useless.
// So the first answer wins and is never revised.
//
// WHY THIS IS NEEDED AT ALL. Nothing in the app has ever recorded a referrer,
// and the two channels the 2026-08 onboarding answers show as largest are both
// invisible to server logs:
//   · ChatGPT and other assistants — usually send NO Referer at all, and when
//     they do it is a chat host that says nothing about the conversation.
//   · WhatsApp / Telegram forwards — send no Referer by construction.
// Neither will ever show up as anything but "direct". That is not a bug to fix
// here; it is the reason the onboarding "How did you hear about us?" answer
// stays the primary source and this is corroboration.

/** Hosts we care to name rather than record as a bare domain. */
const KNOWN: Array<[RegExp, string]> = [
  // Assistants first — the largest measured channel, and the one most likely to
  // arrive with a bare or missing Referer.
  [/(^|\.)chatgpt\.com$/, "chatgpt"],
  [/(^|\.)openai\.com$/, "chatgpt"],
  [/(^|\.)perplexity\.ai$/, "perplexity"],
  [/(^|\.)claude\.ai$/, "claude"],
  [/(^|\.)gemini\.google\.com$/, "gemini"],
  [/(^|\.)copilot\.microsoft\.com$/, "copilot"],
  // Search.
  [/(^|\.)google\.[a-z.]+$/, "google"],
  [/(^|\.)bing\.com$/, "bing"],
  [/(^|\.)duckduckgo\.com$/, "duckduckgo"],
  [/(^|\.)yandex\.[a-z.]+$/, "yandex"],
  // Social / messaging. WhatsApp and Telegram almost never send a Referer, so
  // these match the rare in-app-browser case rather than the common one.
  [/(^|\.)linkedin\.com$/, "linkedin"],
  [/(^|\.)lnkd\.in$/, "linkedin"],
  [/(^|\.)facebook\.com$/, "facebook"],
  [/(^|\.)youtube\.com$/, "youtube"],
  [/(^|\.)t\.co$/, "x"],
  [/(^|\.)x\.com$/, "x"],
  [/(^|\.)whatsapp\.com$/, "whatsapp"],
  [/(^|\.)telegram\.[a-z.]+$/, "telegram"],
];

/** Android in-app referrers. A tap inside a native app arrives as
 * `android-app://<package>`, NOT as a web host — and on a mobile-first, largely
 * Android user base these are some of the most informative referrers there are,
 * because they name the messenger a link was forwarded through. Left unmapped
 * they would be stored as nonsense hosts like "com.whatsapp". */
const ANDROID_PACKAGES: Record<string, string> = {
  "com.whatsapp": "whatsapp",
  "com.whatsapp.w4b": "whatsapp",
  "org.telegram.messenger": "telegram",
  "com.facebook.katana": "facebook",
  "com.facebook.orca": "messenger",
  "com.linkedin.android": "linkedin",
  "com.google.android.gm": "gmail",
  "com.google.android.googlequicksearchbox": "google",
  "com.openai.chatgpt": "chatgpt",
  "com.instagram.android": "instagram",
};

/** Our own hosts — a hop between them is not a new first touch. */
function isOwnHost(host: string): boolean {
  return host === "sketchcast.app" || host.endsWith(".sketchcast.app") || host === "localhost";
}

/** Resolved host, or a `pkg:` marker for a native-app referrer. */
function hostOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null; // "", or anything unparseable
  }
  if (u.protocol === "android-app:") {
    // The package sits in the HOST position for this scheme; `pathname` is
    // empty. Return it tagged so the caller does not run web rules over it.
    const pkg = (u.hostname || u.pathname.replace(/^\/+/, "")).toLowerCase();
    return pkg ? `pkg:${pkg}` : null;
  }
  // Anything that is not the web (intent:, file:, chrome-extension:, …) tells
  // us nothing about discovery and must not become a stored "source".
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return u.hostname.toLowerCase().replace(/^www\./, "");
}

/** Turn a host (or a `pkg:`-tagged Android package) into a stored source name.
 * The single place naming happens, whether the host came from this browser's
 * own referrer or was forwarded by the landing site. */
function nameHost(host: string): string {
  if (host.startsWith("pkg:")) {
    // A known package resolves to its channel; an unknown one keeps the package
    // name, which is still a real, countable origin.
    const pkg = host.slice(4);
    return ANDROID_PACKAGES[pkg] ?? `app:${pkg.slice(0, 56)}`;
  }
  if (isOwnHost(host)) return "direct";
  for (const [re, name] of KNOWN) if (re.test(host)) return name;
  return host.slice(0, 60);
}

/**
 * Resolve a first-touch source from what the browser can see.
 *
 * Precedence is deliberate — an explicit tag always beats an inferred one:
 *   1. `utm_source` — something we tagged ourselves, so it is authoritative.
 *   2. `ref` — the cross-domain hand-off from the landing site, which is on a
 *      DIFFERENT origin (Cloudflare) and is where most first touches actually
 *      land. Without this the app would record every such visit as
 *      "sketchcast.app" and learn nothing.
 *   3. the referring host, named if we know it, bare domain otherwise.
 *   4. "direct" — no signal. Includes assistants and messenger forwards, which
 *      is exactly why this value must never be read as "typed the URL in".
 *
 * @param referrer `document.referrer` (may be "")
 * @param search   `location.search`
 */
export function firstTouchSource(referrer: string, search: string): string {
  const params = new URLSearchParams(search || "");

  const utm = params.get("utm_source")?.trim();
  if (utm) return `utm:${utm.slice(0, 60).toLowerCase()}`;

  // `ref` is NOT a free-text tag — it is reserved for the landing site's
  // hand-off and carries a referrer HOST (or an `android-app` package), never a
  // full URL. Host-only is deliberate: a whole referring URL can carry someone
  // else's query string, and none of that belongs in our database. It is named
  // here rather than on the landing side so the naming table has ONE home; the
  // landing script stays a dumb forwarder that cannot drift from this list.
  const ref = params.get("ref")?.trim().toLowerCase();
  if (ref) return nameHost(ref.replace(/^www\./, "").slice(0, 64));

  const host = hostOf(referrer || "");
  if (!host) return "direct";
  return nameHost(host);
}

/** Cookie holding the first-touch value. First write wins; ~180 days. */
export const SOURCE_COOKIE = "sc_src";
/** Set once the value has been persisted to a profile, so it is posted once. */
export const STAMPED_COOKIE = "sc_src_stamped";
export const SOURCE_MAX_AGE = 60 * 60 * 24 * 180;

/** Values we will accept back off a cookie — anything else is discarded rather
 * than written to a profile, so a hand-edited cookie cannot inject free text. */
export function isPlausibleSource(v: string | null | undefined): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 70 && /^[a-z0-9.:_-]+$/.test(v);
}
