import { describe, it, expect } from "vitest";
import { firstTouchSource, isPlausibleSource } from "../attribution";

describe("firstTouchSource", () => {
  it("prefers an explicit utm_source over everything else", () => {
    // A tag we applied ourselves outranks an inferred referrer, because it is
    // the only signal that survives a redirect chain intact.
    expect(firstTouchSource("https://www.google.com/", "?utm_source=li_bio")).toBe("utm:li_bio");
  });

  it("takes ?ref as the cross-domain hand-off from the landing site", () => {
    // THE CASE THAT MOTIVATES THE PARAMETER AT ALL: the landing site is on a
    // different origin, so without this the referrer would read as our own
    // domain and every visit through the front door would look like "direct".
    expect(firstTouchSource("https://sketchcast.app/", "?ref=chatgpt.com")).toBe("chatgpt");
  });

  it("normalises a forwarded ref exactly like a first-hand referrer", () => {
    // The landing script forwards a bare HOST and does no naming of its own, so
    // these two routes to the same visitor must agree. If they ever diverge,
    // the same person is two rows depending on which page they landed on first.
    for (const [host, expected] of [
      ["chatgpt.com", "chatgpt"],
      ["www.google.co.in", "google"],
      ["lnkd.in", "linkedin"],
      ["saasbrowser.com", "saasbrowser.com"],
      ["pkg:com.whatsapp", "whatsapp"],
    ] as const) {
      expect(firstTouchSource("", `?ref=${encodeURIComponent(host)}`)).toBe(expected);
      }
  });

  it("never lets a forwarded ref name our own domain as a source", () => {
    expect(firstTouchSource("", "?ref=sketchcast.app")).toBe("direct");
  });

  it("names known referrers rather than storing bare domains", () => {
    expect(firstTouchSource("https://chatgpt.com/c/abc", "")).toBe("chatgpt");
    expect(firstTouchSource("https://chat.openai.com/", "")).toBe("chatgpt");
    expect(firstTouchSource("https://www.perplexity.ai/search", "")).toBe("perplexity");
    expect(firstTouchSource("https://www.google.co.in/", "")).toBe("google");
    expect(firstTouchSource("https://lnkd.in/xyz", "")).toBe("linkedin");
  });

  it("keeps an unrecognised referrer as its bare host", () => {
    expect(firstTouchSource("https://saasbrowser.com/en/saas/1", "")).toBe("saasbrowser.com");
  });

  it("strips www so one referrer cannot become two rows", () => {
    expect(firstTouchSource("https://www.saasbrowser.com/x", "")).toBe("saasbrowser.com");
  });

  it("treats our own hosts as no new first touch", () => {
    // A hop from the landing site or between app subdomains is navigation, not
    // discovery — recording it would overwrite the real origin with ourselves.
    expect(firstTouchSource("https://sketchcast.app/pricing", "")).toBe("direct");
    expect(firstTouchSource("https://app.sketchcast.app/login", "")).toBe("direct");
    expect(firstTouchSource("https://school.sketchcast.app/x", "")).toBe("direct");
  });

  it("names Android in-app referrers instead of storing the raw package", () => {
    // A forward opened from the WhatsApp app arrives like this. It parses as a
    // URL whose "hostname" is the package, so without a branch it would be
    // stored as the nonsense host "com.whatsapp" — and this is one of the few
    // ways a messenger forward is visible at all.
    expect(firstTouchSource("android-app://com.whatsapp", "")).toBe("whatsapp");
    expect(firstTouchSource("android-app://org.telegram.messenger", "")).toBe("telegram");
    expect(firstTouchSource("android-app://com.openai.chatgpt", "")).toBe("chatgpt");
  });

  it("keeps an unknown package as a tagged app origin", () => {
    expect(firstTouchSource("android-app://com.example.reader", "")).toBe("app:com.example.reader");
  });

  it("returns 'direct' for the no-signal cases", () => {
    // Assistants on the web and iOS messenger forwards land here. 'direct'
    // means NO SIGNAL, never "typed the URL in" — the largest measured channel
    // is invisible this way, which is why the onboarding answer stays primary.
    expect(firstTouchSource("", "")).toBe("direct");
    expect(firstTouchSource("not a url", "?a=b")).toBe("direct");
    expect(firstTouchSource("chrome-extension://abc/page.html", "")).toBe("direct");
  });

  it("bounds what it will produce", () => {
    const long = "x".repeat(200);
    expect(firstTouchSource("", `?utm_source=${long}`).length).toBeLessThanOrEqual(64);
    expect(firstTouchSource("", "?utm_source=MiXeD")).toBe("utm:mixed");
  });
});

describe("isPlausibleSource", () => {
  it("accepts the shapes firstTouchSource produces", () => {
    for (const v of ["direct", "chatgpt", "utm:li_bio", "saasbrowser.com", "google"]) {
      expect(isPlausibleSource(v)).toBe(true);
    }
  });

  it("rejects anything a hand-edited cookie could smuggle in", () => {
    // The cookie is client-writable by design, so the server validates it
    // before it reaches a profile column.
    expect(isPlausibleSource("")).toBe(false);
    expect(isPlausibleSource(null)).toBe(false);
    expect(isPlausibleSource("has space")).toBe(false);
    expect(isPlausibleSource("<script>")).toBe(false);
    expect(isPlausibleSource("x".repeat(80))).toBe(false);
  });
});
