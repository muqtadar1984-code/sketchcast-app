"use client";

import { createContext, useContext, type ReactNode } from "react";

// SK on the landing pages (founder 2026-10-30).
//
// First as a hero card at the top of each role's landing page; then, the same
// day ("get rid of this boxed approach for sk … just keep the avatar to the
// bottom right … the current approach takes up a lot of space on the
// dashboard"), as the corner avatar with a speech bubble on EVERY page
// (sk-launcher.tsx, sk-shell.tsx). The landing pages no longer reserve a
// place for SK; what is left here is:
//
//   - the layout's decision, unchanged: WHO sees SK is decided once,
//     server-side, by the dashboard layout's skShellEnabledFor() (`skOn`), and
//     handed down through SkHomeProvider; the launcher is only mounted when it
//     passed. useSkOn() reads it (false outside the layout, or with the build
//     flag off).
//   - the HOME pages — /dashboard (teacher, parent, student), /dashboard/children
//     (a parent's hat home) and /dashboard/school (the leaders') — where SK's
//     greeting shows in the bubble once per tab session and the first-login
//     walkthrough starts by itself.

const SK_ON = process.env.NEXT_PUBLIC_FEATURE_SK === "true";

/** Each role's landing page. */
export const SK_HOME_PATHS: readonly string[] = ["/dashboard", "/dashboard/children", "/dashboard/school"];

/** A landing page (exact path; a trailing slash is the same page). */
export function isSkHomePath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return SK_HOME_PATHS.includes(p);
}

const SkHomeContext = createContext<boolean | null>(null);

/** Whether SK shows: the layout's gate AND the client build flag (the
 *  launcher's own pair — a deployment that never opted in stays dark). */
export function skHeroVisible(on: boolean | null | undefined, featureOn: boolean = SK_ON): boolean {
  return !!on && featureOn;
}

/** `on` is the dashboard layout's skShellEnabledFor() result. */
export function SkHomeProvider({ on, children }: { on: boolean; children?: ReactNode }) {
  return <SkHomeContext.Provider value={on}>{children}</SkHomeContext.Provider>;
}

/** The layout's SK decision for this user (false outside the dashboard layout). */
export function useSkOn(): boolean {
  return skHeroVisible(useContext(SkHomeContext));
}
