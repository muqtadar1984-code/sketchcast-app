"use client";

import { useEffect, useRef } from "react";

// Cloudflare Turnstile widget (explicit render). Loads the script once, mounts
// one widget, hands the token up, and hands `null` up when it expires or
// errors so the form disables its submit until a fresh token arrives. The
// server half is utils/turnstile.ts. Render this only when a site key exists —
// the parent decides; this component never guesses.
//
// `onToken` must be referentially stable (useCallback in the parent): it is an
// effect dependency, and a fresh function per render would remount the widget.

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export default function Turnstile({
  siteKey,
  onToken,
  className,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let widgetId: string | null = null;

    const mount = () => {
      if (cancelled || !host.current || !window.turnstile) return;
      widgetId = window.turnstile.render(host.current, {
        sitekey: siteKey,
        callback: (token: string) => onToken(token),
        "expired-callback": () => onToken(null),
        "error-callback": () => onToken(null),
      });
    };

    if (window.turnstile) {
      mount();
    } else {
      const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
      if (existing) {
        existing.addEventListener("load", mount, { once: true });
      } else {
        const s = document.createElement("script");
        s.src = SCRIPT_SRC;
        s.async = true;
        s.addEventListener("load", mount, { once: true });
        document.head.appendChild(s);
      }
    }

    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          // already gone
        }
      }
    };
  }, [siteKey, onToken]);

  return <div ref={host} className={className} />;
}
