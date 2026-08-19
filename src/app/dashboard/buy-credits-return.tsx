"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

// The last mile of the credit-pack purchase: getting the balance on screen when
// the buyer comes back.
//
// THE GAP THIS CLOSES. A pack is bound by claimLsPurchases(), which is called
// from dashboard/layout.tsx — and Next.js deliberately does NOT re-execute a
// shared layout on client-side navigation. The buy chips open the LS hosted
// checkout with target="_blank", so the app tab stays alive as an SPA the whole
// time: the buyer pays in the other tab, the webhook parks the row, they close
// it, and clicking around the dashboard never re-runs the claim. The meter keeps
// showing the pre-purchase balance and a generate attempt is still quota-blocked
// until they happen to press F5 — the exact "I paid and nothing happened" moment
// the claim exists to prevent, on the only in-app purchase surface there is.
//
// router.refresh() is the fix because it re-fetches the WHOLE current route from
// the server, layouts included, so the claim runs and the re-rendered meter
// shows the credits. Client state is preserved, so a refresh the buyer did not
// need costs them nothing visible.
//
// ARMED BY A CLICK, never speculative: refreshing on every focus would re-render
// the dashboard each time the user alt-tabs. The listener is attached to the
// container rather than via an onClick prop so the chips stay plain server-
// rendered anchors (and so no interactive handler lands on a non-interactive
// element).
//
// THE SECOND PASS is for the webhook, not the user. LS delivers order_created
// asynchronously; a buyer who closes the checkout tab the instant the receipt
// appears can return before the row exists, and the first refresh would then
// bind nothing. One delayed retry covers that lag — one, because past that the
// honest answer is that the purchase has not arrived and a refresh loop would
// only hide it.
const WEBHOOK_LAG_MS = 5000;

export default function BuyCreditsReturn({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);
  const armed = useRef(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const arm = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest("a[href]")) armed.current = true;
    };
    const settle = () => {
      // Fires on focus AND on visibilitychange because mobile browsers deliver
      // one or the other when a tab comes back; the flag makes the pair idempotent.
      if (!armed.current || document.visibilityState !== "visible") return;
      armed.current = false;
      router.refresh();
      retry = setTimeout(() => router.refresh(), WEBHOOK_LAG_MS);
    };

    el.addEventListener("click", arm);
    window.addEventListener("focus", settle);
    document.addEventListener("visibilitychange", settle);
    return () => {
      el.removeEventListener("click", arm);
      window.removeEventListener("focus", settle);
      document.removeEventListener("visibilitychange", settle);
      if (retry) clearTimeout(retry);
    };
  }, [router]);

  return (
    <div ref={box} className={className}>
      {children}
    </div>
  );
}
