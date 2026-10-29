// The Shell's job tray — the client's rules (S2: "lesson prep lands in the
// job tray"). PURE: the panel (sk-shell.tsx) does the fetching and the DOM.
//
// - Poll every 15 s ONLY while a kit is still being made, the panel is open
//   and the tab is visible — the same `visibilityState === "visible"` test the
//   §2.6 mic gate uses (mic-gate.ts). A hidden tab stops polling; coming back
//   reads once and the rule decides again.
// - The tray hides itself when it has nothing to show.
// - One line per kit: "Being made" / "2 of 7 pieces ready" / "Ready" /
//   "Didn't finish", from the dictionary's sk.shell.tray.

import type { TrayKit } from "../kit-tray";

export type { TrayKit };
export const TRAY_POLL_MS = 15_000;

export const trayInProgress = (kits: readonly Pick<TrayKit, "state">[]): boolean => kits.some((k) => k.state === "making" || k.state === "partial");

/** Whether the panel should keep polling the tray. */
export function shouldPollTray(input: { open: boolean; visibility: string | null | undefined; kits: readonly Pick<TrayKit, "state">[] }): boolean {
  return input.open && input.visibility === "visible" && trayInProgress(input.kits);
}

export const trayVisible = (kits: readonly unknown[]): boolean => kits.length > 0;

export type TrayCopy = { making: string; partial: string; ready: string; failed: string };

/** The state words for one kit ("2 of 7 pieces ready" fills {n}/{m}). */
export function trayStateText(k: Pick<TrayKit, "state" | "ready" | "total">, copy: TrayCopy): string {
  if (k.state === "partial") return copy.partial.replace("{n}", String(k.ready)).replace("{m}", String(k.total));
  return copy[k.state];
}

/** The route's reply → kits, defensively (anything malformed is dropped). */
export function parseTray(body: unknown): TrayKit[] {
  const list = body && typeof body === "object" && Array.isArray((body as { kits?: unknown }).kits) ? ((body as { kits: unknown[] }).kits) : [];
  const out: TrayKit[] = [];
  for (const raw of list.slice(0, 3)) {
    if (!raw || typeof raw !== "object") continue;
    const k = raw as Record<string, unknown>;
    const state = k.state;
    if (typeof k.id !== "string" || typeof k.title !== "string") continue;
    if (state !== "making" && state !== "partial" && state !== "ready" && state !== "failed") continue;
    out.push({
      id: k.id,
      title: k.title,
      state,
      ready: typeof k.ready === "number" ? k.ready : 0,
      total: typeof k.total === "number" ? k.total : 0,
      href: typeof k.href === "string" && k.href.startsWith("/") && !k.href.startsWith("//") ? k.href : null,
    });
  }
  return out;
}
