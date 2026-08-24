"use client";

import { useEffect } from "react";
import {
  firstTouchSource,
  isPlausibleSource,
  SOURCE_COOKIE,
  STAMPED_COOKIE,
  SOURCE_MAX_AGE,
} from "@/utils/attribution";

// Renders nothing. Mounted once in the root layout, it does two things exactly
// once per browser:
//
//   1. On the FIRST page of the first visit, works out where the visitor came
//      from and parks it in a cookie. This has to happen on arrival, not at
//      signup: `document.referrer` is gone the moment they navigate, and the
//      Google OAuth round-trip destroys it outright — which matters because
//      OAuth is how most real accounts here are created.
//
//   2. Once a session exists, hands that value to the server to be written onto
//      the profile, then marks it done so it is posted once and never again.
//
// Deliberately NOT middleware. Middleware sees the `Referer` HEADER, which is
// absent or useless for the two channels that actually matter (assistants,
// messenger forwards), and it would run on every request forever to catch a
// value that is only ever interesting on the first one.

function readCookie(name: string): string | null {
  const hit = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

function writeCookie(name: string, value: string, maxAge: number) {
  // Lax, not None: this is read by our own server on same-site navigations
  // only, and None would need Secure plus a third-party-cookie exemption that
  // browsers are actively removing.
  document.cookie =
    `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax` +
    (location.protocol === "https:" ? "; Secure" : "");
}

export default function SourceCapture() {
  useEffect(() => {
    // ── 1. first touch wins, forever ──
    let src = readCookie(SOURCE_COOKIE);
    if (!isPlausibleSource(src)) {
      src = firstTouchSource(document.referrer, location.search);
      writeCookie(SOURCE_COOKIE, src, SOURCE_MAX_AGE);
    }

    // ── 2. stamp it onto the profile, once ──
    // The route 401s harmlessly for a signed-out visitor and we simply try
    // again on a later page; the marker is only written on a real success, so a
    // visitor who signs up on their fifth visit still gets their first source.
    if (readCookie(STAMPED_COOKIE)) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/attribution", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: src }),
        });
        if (!cancelled && res.ok) writeCookie(STAMPED_COOKIE, "1", SOURCE_MAX_AGE);
      } catch {
        // Offline, blocked by an extension, navigated away mid-flight. This is
        // bookkeeping — it must never surface to the user or break a page.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
