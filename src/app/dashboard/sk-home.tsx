"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

// SK as the first thing a signed-in user sees (founder, 2026-10-30): the SK
// Shell INLINE at the top of each role's landing page — /dashboard (teacher,
// parent, student), /dashboard/children (a parent's hat home) and
// /dashboard/school (the leaders') — as a hero card, not only behind the
// floating launcher.
//
// WHO sees it is still decided once, server-side, by the dashboard layout's
// skShellEnabledFor() (`skOn`) — the same gate as the launcher; this module
// adds none. The layout hands the decision down through SkHomeProvider; a page
// drops <SkHomeHero /> where the hero belongs, which renders nothing unless
// the layout said SK is on, and otherwise only a PLACE: the layout's launcher
// (sk-launcher.tsx) portals its one Shell there as `variant="hero"`. One
// engine, one conversation — moving between pages moves the same Shell
// between the hero and the floating panel instead of starting another.

const SK_ON = process.env.NEXT_PUBLIC_FEATURE_SK === "true";

type SkHomeState = { on: boolean; slot: HTMLElement | null };

const SkHomeContext = createContext<SkHomeState | null>(null);
/** The slot's setter on its own (stable) context: the hero hands it to React
 *  as a callback ref and never reads it during render. */
const SkSlotSetter = createContext<((el: HTMLElement | null) => void) | null>(null);

/** Whether the hero renders: the layout's gate AND the client build flag
 *  (the launcher's own pair — a deployment that never opted in stays dark). */
export function skHeroVisible(on: boolean | null | undefined, featureOn: boolean = SK_ON): boolean {
  return !!on && featureOn;
}

/** `on` is the dashboard layout's skShellEnabledFor() result. */
export function SkHomeProvider({ on, children }: { on: boolean; children?: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ on, slot }), [on, slot]);
  return (
    <SkSlotSetter.Provider value={setSlot}>
      <SkHomeContext.Provider value={value}>{children}</SkHomeContext.Provider>
    </SkSlotSetter.Provider>
  );
}

/** The hero's place on the current page, or null (no hero here, or SK off). */
export function useSkHeroSlot(): HTMLElement | null {
  const ctx = useContext(SkHomeContext);
  return ctx && skHeroVisible(ctx.on) ? ctx.slot : null;
}

/** Where the hero goes. Renders nothing unless SK is on for this user;
 *  `className` is the page's spacing around it (no empty gap when off). */
export function SkHomeHero({ className }: { className?: string }) {
  const on = useContext(SkHomeContext)?.on;
  const setSlot = useContext(SkSlotSetter);
  if (!setSlot || !skHeroVisible(on)) return null;
  return <div ref={setSlot} className={className} data-sk="home-hero" />;
}
