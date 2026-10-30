"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { SkBoardBridge } from "@/app/present/sk-board-bridge";
import type { SkTutorBridge } from "@/sk/shell/client/tutor-bridge";
import { onSkWalkthroughRequest } from "@/sk/walkthrough/bus";
import { WALK_STORE_KEY } from "@/sk/shell/client/walkthrough";
import SkShell, { type SkShellCopy } from "./sk-shell";
import { isSkHomePath } from "./sk-home";
import { useSkWalkthrough, type WalkCopy } from "./sk-walkthrough";

// SK in the corner (founder 2026-10-30: "get rid of this boxed approach for
// sk … just keep the avatar to the bottom right"). ONE Shell, always mounted
// where the launcher is: a round avatar fixed at the bottom-end corner
// (bottom-4 end-4 z-40, where the "SK" pill was) with a speech bubble beside
// it; the conversation opens from the avatar's menu as a compact non-modal
// sheet (sk-shell.tsx). No hero card on the landing pages any more, and no
// floating dialog. The AI Teaching Assistant's launcher shares this corner —
// the server layout renders exactly ONE of the two, handing the Assistant
// `hidden` whenever SK is on.
//
// Two gates render it: the server layout only mounts it when
// skShellEnabledFor() passed (FEATURE_SK + SK_ROLES + tenant opt-in / allow
// list), and the build-time NEXT_PUBLIC_FEATURE_SK keeps the client bundle
// dark on a deployment that has not opted in at all. The /api/sk/shell/*
// routes are the authoritative gate.
//
// Corners:
//   - the Board (/present, mounted by present-client WITH a bridge): bottom-
//     START — the Stage's corner video owns bottom-end there (360×202, inset 16);
//   - the leaders' School pages (/dashboard/school*): bottom-end, RAISED above
//     the School-briefing bot's launcher (bottom-4 end-4, 44 px tall), so both
//     stay usable — SK (and its tour) now works there like everywhere else;
//   - everywhere else: bottom-end.
//
// The first-login WALKTHROUGH (sk-walkthrough.tsx) runs in SK's speech bubble
// on every page. It starts by itself from a home page (sk-home.tsx
// SK_HOME_PATHS) when the sk-intro version is due; the launchers on /present
// and /sk pick a run up from sessionStorage.
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
  /** S1: set by /present only — the Board bridge the Shell drives. With it the
   *  avatar sits bottom-START (the Stage's corner video owns bottom-end). */
  board?: SkBoardBridge | null;
  /** S3 slice D: set by the /sk layout — the kit player bridge the Shell drives. */
  tutor?: SkTutorBridge | null;
}) {
  // Flipped the moment the first-login run ends (completed or skipped), so a
  // replay in the same session never writes the seen row again while the
  // server still holds the old one.
  const [introPending, setIntroPending] = useState(introDue);
  const pathname = usePathname();
  // A landing page (never the Board or the kit player, which bring their own
  // bridges): the greeting shows once per session and the first-login tour
  // starts from here.
  const home = !board && !tutor && isSkHomePath(pathname);
  const tour = useSkWalkthrough({ role, hat, copy: walkCopy, introPending, onIntroDone: () => setIntroPending(false) });

  // "Take the tour": the header's 🧭 (TourProvider, for SK users), SK's menu
  // and "Show me around" reach the ONE runner here. A replay never records.
  const { start, active: tourActive } = tour;
  useEffect(() => onSkWalkthroughRequest(() => start()), [start]);

  // First login (founder decision 2): it starts by itself, from a home page.
  const [autoTried, setAutoTried] = useState(false);
  useEffect(() => {
    if (!SK_ON || autoTried || !introPending || !home || tourActive) return;
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
  }, [autoTried, introPending, home, tourActive, start]);

  if (!SK_ON) return null;
  // The Board (/present) is not under the dashboard layout; it mounts this
  // launcher itself WITH a bridge, so a launcher reaching /present without
  // one is the layout's and hides.
  if (pathname?.startsWith("/present") && !board) return null;
  const school = !board && !!pathname?.startsWith("/dashboard/school");

  return (
    <>
      <SkShell
        copy={copy}
        role={role}
        hat={hat}
        board={board ?? null}
        tutor={tutor ?? null}
        side={board ? "start" : "end"}
        raised={school}
        autoListen={!board}
        greet={home}
        // A question mid-tour: the tour pauses and SK answers it normally.
        onEngaged={tour.onQuestion}
        walk={
          tourActive
            ? {
                strip: tour.strip,
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
        onTakeTour={() => start()}
        takeTourLabel={walkCopy.ui.takeTour}
      />
      {tour.spotlight}
    </>
  );
}
