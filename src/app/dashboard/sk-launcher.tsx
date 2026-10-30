"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { SkBoardBridge } from "@/app/present/sk-board-bridge";
import type { SkTutorBridge } from "@/sk/shell/client/tutor-bridge";
import { useRigChoice } from "@/sk/board/use-rig-choice";
import { onSkWalkthroughRequest } from "@/sk/walkthrough/bus";
import { WALK_STORE_KEY } from "@/sk/shell/client/walkthrough";
import SkShell, { type SkShellCopy } from "./sk-shell";
import { useSkHeroSlot } from "./sk-home";
import { useSkWalkthrough, type WalkCopy } from "./sk-walkthrough";

// Floating launcher for the SK Shell (Final Plan 2026-10-28 §2.1, S0). Same
// corner, baseline and treatment as the AI Teaching Assistant's launcher
// (bottom-4 end-4 z-40, collapsed to its mark, expanding on hover/focus) —
// the server layout renders exactly ONE of the two, handing the Assistant
// `hidden` whenever the Shell is on, so they never share the slot.
//
// Two gates render it: the server layout only mounts it when
// skShellEnabledFor() passed (FEATURE_SK + SK_ROLES + tenant opt-in / allow
// list), and the build-time NEXT_PUBLIC_FEATURE_SK keeps the client bundle
// dark on a deployment that has not opted in at all. The /api/sk/shell/*
// routes are the authoritative gate. Lazy: the panel mounts when opened.
//
// 2026-10-30 (founder: SK first, and moving between pages is seamless): on a
// landing page that shows the SK hero slot (sk-home.tsx) this launcher keeps
// ONE Shell and portals it into the slot as the hero, with no pill. Leaving
// that page moves the SAME Shell — transcript, memory, a turn still streaming
// — into the floating panel, open, when she has been talking to it; coming
// back moves it into the hero again. The Shell element sits at one place in
// this tree so React keeps its state through every move.
//
// 2026-10-30 (founder): the first-login WALKTHROUGH runs here too
// (sk-walkthrough.tsx). It starts by itself from the home hero when the
// sk-intro version is due, inside the hero card; on every other page the same
// Shell becomes the docked bar (`variant="dock"`) — including the leaders'
// School pages, where the floating launcher otherwise stays hidden. The
// launchers on /present and /sk pick a run up from sessionStorage.
const SK_ON = process.env.NEXT_PUBLIC_FEATURE_SK === "true";

export default function SkLauncher({
  copy,
  walkCopy,
  role,
  hat,
  introDue,
  board,
  tutor,
}: {
  copy: SkShellCopy;
  /** sk.walkthrough — the tour's words for this request's language. */
  walkCopy: WalkCopy;
  role: string | null;
  hat: string | null;
  /** Server-decided from user_tour_progress("sk-intro") vs SK_INTRO_TOUR.version:
   *  the first-login walkthrough starts by itself (and records its end). */
  introDue: boolean;
  /** S1: set by /present only — the Board bridge the panel drives. With it the
   *  launcher mounts on the Board (bottom-START corner: the Stage's corner
   *  video owns bottom-end there, 360×202 at inset 16). */
  board?: SkBoardBridge | null;
  /** S3 slice D: set by the /sk layout — the kit player bridge the panel drives. */
  tutor?: SkTutorBridge | null;
}) {
  const [open, setOpen] = useState(false);
  // Flipped the moment the first-login run ends (completed or skipped), so a
  // replay in the same session never writes the seen row again while the
  // server still holds the old one.
  const [introPending, setIntroPending] = useState(introDue);
  const pathname = usePathname();
  const [rig] = useRigChoice();
  // The hero's place on this page, when the page has one (never on the Board
  // or the kit player, which bring their own bridges).
  const slot = useSkHeroSlot();
  const heroHere = !!slot && !board && !tutor;
  // She has talked to SK since the panel was last closed: leaving the hero's
  // page carries the conversation on in the panel, open.
  const [engaged, setEngaged] = useState(false);
  const [wasHero, setWasHero] = useState(heroHere);
  if (wasHero !== heroHere) {
    setWasHero(heroHere);
    if (wasHero) setOpen(engaged);
  }
  const tour = useSkWalkthrough({ role, hat, copy: walkCopy, introPending, onIntroDone: () => setIntroPending(false) });
  const [wasTour, setWasTour] = useState(tour.active);
  if (wasTour !== tour.active) {
    setWasTour(tour.active);
    // The tour ended away from the hero: the conversation she had during it
    // carries on in the panel, open; otherwise the dock simply goes.
    if (wasTour && !heroHere) setOpen(engaged);
  }

  // The Board's "Ask SK about this" chip opens the panel; the panel itself
  // takes the ask and sends it (sk-shell.tsx).
  useEffect(() => board?.asks()?.subscribe(() => setOpen(true)), [board]);

  // "Take the tour": the header's 🧭 (TourProvider, for SK users) and SK's
  // "Show me around" reach the ONE runner here. A replay never records.
  const { start, active: tourActive } = tour;
  useEffect(() => onSkWalkthroughRequest(() => start()), [start]);

  // First login (founder decision 2): it starts by itself, from the home hero.
  const [autoTried, setAutoTried] = useState(false);
  useEffect(() => {
    if (!SK_ON || autoTried || !introPending || !heroHere || tourActive) return;
    // Deferred like TourProvider: Strict Mode's double mount, and the page's
    // anchors settling, must not cost the first stop. A run this tab already
    // carries (restored from sessionStorage) wins over a new one.
    const t = window.setTimeout(() => {
      setAutoTried(true);
      let carried = false;
      try {
        carried = !!window.sessionStorage.getItem(WALK_STORE_KEY);
      } catch {
        carried = false;
      }
      if (!carried) start({ record: true });
    }, 700);
    return () => window.clearTimeout(t);
  }, [autoTried, introPending, heroHere, tourActive, start]);

  if (!SK_ON) return null;
  // The leadership School pages keep their own bottom-right launcher (the
  // School-briefing bot) until S5 retires it — but their hero, when they show
  // one, is the Shell, and the walkthrough's dock works there too (founder
  // decision 5). The Board (/present) is not under the dashboard layout; it
  // mounts this launcher itself WITH a bridge, so a launcher reaching /present
  // without one is the layout's and hides.
  const hiddenHere = pathname?.startsWith("/dashboard/school") || (pathname?.startsWith("/present") && !board);
  if (hiddenHere && !heroHere && !tourActive) return null;
  const docked = tourActive && !heroHere;
  const shellOn = heroHere || open || docked;

  return (
    <>
      {!heroHere && !docked && (
        <div className={board ? "fixed bottom-4 start-4 z-40" : "fixed bottom-4 end-4 z-40"} data-sk="launcher" data-sk-board={board ? "true" : undefined}>
          <button
            data-tour="sk-launcher"
            onClick={() => setOpen(true)}
            className="group btn-primary h-11 px-3 hover:px-4 focus-visible:px-4 text-sm text-white rounded-full shadow-lg flex items-center transition-all"
            title={copy.open}
            aria-label={copy.open}
          >
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/20 text-[11px] font-semibold shrink-0" aria-hidden>
              SK
            </span>
            <span className="max-w-0 group-hover:max-w-[8rem] group-focus-visible:max-w-[8rem] ms-0 group-hover:ms-2 group-focus-visible:ms-2 overflow-hidden whitespace-nowrap transition-all duration-200">
              {copy.open}
            </span>
          </button>
        </div>
      )}
      {shellOn && (
        <SkShell
          variant={heroHere ? "hero" : docked ? "dock" : "panel"}
          portalTo={heroHere ? slot : null}
          copy={copy}
          role={role}
          hat={hat}
          onClose={() => {
            setOpen(false);
            setEngaged(false);
          }}
          onEngaged={() => {
            setEngaged(true);
            // A question mid-tour: the tour pauses and SK answers it normally.
            tour.onQuestion();
          }}
          board={board ?? null}
          tutor={tutor ?? null}
          walk={
            tourActive
              ? {
                  strip: tour.strip(heroHere ? "hero" : "dock", rig),
                  voice: tour.voice,
                  fill: tour.fill,
                  showAnswers: tour.showAnswers,
                  command: tour.command,
                  onVoiceDone: tour.onVoiceDone,
                  act: tour.act,
                  hold: tour.hold,
                  state: tour.state ?? undefined,
                  narrating: tour.walk?.status === "running",
                  soundBlocked: tour.soundBlocked,
                }
              : null
          }
          onTakeTour={() => {
            setOpen(false);
            start();
          }}
          takeTourLabel={walkCopy.ui.takeTour}
        />
      )}
      {tour.spotlight}
    </>
  );
}
