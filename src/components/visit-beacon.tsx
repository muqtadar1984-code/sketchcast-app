"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

// The app's half of the visit counter (/api/public/visit, migration 0118).
// One beacon per navigation, sent with sendBeacon so it survives a tab
// closing; nothing is stored in the browser and nothing is awaited. Renders
// nothing. The marketing site has the same thing in assets/visit.js.
export default function VisitBeacon() {
  const pathname = usePathname();
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!pathname || last.current === pathname) return;
    last.current = pathname;
    try {
      const body = JSON.stringify({ p: pathname, r: document.referrer || "" });
      const blob = new Blob([body], { type: "text/plain" });
      if (!navigator.sendBeacon?.("/api/public/visit", blob)) {
        void fetch("/api/public/visit", { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(() => undefined);
      }
    } catch {
      /* never break a page for bookkeeping */
    }
  }, [pathname]);
  return null;
}
