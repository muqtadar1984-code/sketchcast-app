"use client";

// The tour runtime: given the user's role + server-provided seen-state, it
// auto-starts the right tour on the right screen (deferred until they're there),
// skips missing targets, emits analytics, and records completion. Everything
// library-specific lives in engine.ts; content lives in definitions.ts. Behind
// NEXT_PUBLIC_FEATURE_TOUR so it can be dark-launched.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Role, TourSeen } from "./types";
import { tourForRole } from "./definitions";
import { resolveSteps, shouldAutoStart } from "./logic";
import { createDriverEngine, type TourEngine } from "./engine";
import { emitTourEvent } from "./analytics";

const TOUR_ON = process.env.NEXT_PUBLIC_FEATURE_TOUR === "true";

type TourContextValue = {
  /** A tour exists for this role AND the feature flag is on. */
  available: boolean;
  isRunning: boolean;
  start: (opts?: { force?: boolean }) => void;
  /** Re-run the role's tour on demand (navigates to its home screen first). */
  replay: () => void;
};

const TourContext = createContext<TourContextValue>({
  available: false,
  isRunning: false,
  start: () => {},
  replay: () => {},
});

export function useTour(): TourContextValue {
  return useContext(TourContext);
}

function postSeen(tourKey: string, version: number, status: "completed" | "skipped") {
  try {
    const body = JSON.stringify({ tourKey, version, status });
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon("/api/tour/seen", new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch("/api/tour/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    });
  } catch {
    /* best-effort */
  }
}

export default function TourProvider({
  role,
  seen,
  children,
}: {
  role: string | null;
  seen: TourSeen | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  // Memoized so `def`/`start`/the auto-start effect keep a stable identity across
  // renders (tourForRole returns a fresh object each call) — otherwise the effect
  // re-runs every commit and can cancel the scheduled start.
  const def = useMemo(() => tourForRole(role), [role]);
  const available = TOUR_ON && !!def;

  const engineRef = useRef<TourEngine | null>(null);
  const seenRef = useRef<TourSeen | null>(seen); // local mirror; updated on finish so it won't re-nag this session
  const autoStartedRef = useRef(false);
  const pendingReplayRef = useRef(false);
  const [isRunning, setIsRunning] = useState(false);

  const start = useCallback(
    (opts?: { force?: boolean }) => {
      if (!available || !def || engineRef.current) return;
      const tag = { tourKey: def.key, role: def.role as Role, version: def.version };

      // A target must be VISIBLE, not merely present: `hidden sm:flex` nav
      // tabs exist in the DOM on phones but render nothing, and driver.js
      // dumps the popover at the top-left corner when highlighting a
      // zero-rect element (Khaja's mobile screenshot). getClientRects() is
      // empty for display:none and detached elements.
      const { valid, missing } = resolveSteps(def.steps, (t) => {
        const el = document.querySelector(t);
        return !!el && el.getClientRects().length > 0;
      });
      for (const m of missing) {
        emitTourEvent({ ...tag, event: "tour_step_target_missing", meta: { step_id: m.id } });
      }
      if (!valid.length) return; // nothing on screen to show → never spotlight empty space

      const reduce =
        typeof window !== "undefined" &&
        !!window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      const engine = createDriverEngine();
      engineRef.current = engine;
      setIsRunning(true);
      emitTourEvent({ ...tag, event: "tour_started", meta: { steps: valid.length, forced: !!opts?.force } });

      const finish = () => {
        engineRef.current = null;
        setIsRunning(false);
      };
      try {
        engine.run(
          valid,
          {
            onStepView: (index) => emitTourEvent({ ...tag, event: "tour_step_viewed", meta: { index } }),
            onSkip: (index) => {
              emitTourEvent({ ...tag, event: "tour_skipped", meta: { at_step: index } });
              seenRef.current = { version: def.version, status: "skipped" };
              postSeen(def.key, def.version, "skipped");
              finish();
            },
            onComplete: () => {
              emitTourEvent({ ...tag, event: "tour_completed" });
              seenRef.current = { version: def.version, status: "completed" };
              postSeen(def.key, def.version, "completed");
              finish();
            },
          },
          { animate: !reduce },
        );
      } catch {
        // A driver.js init / DOM failure must degrade to no-tour, never surface —
        // and must not leave engineRef stuck (which would no-op every later start).
        finish();
      }
    },
    [available, def],
  );

  const replay = useCallback(() => {
    if (!available || !def) return;
    if (pathname === def.homePath) {
      start({ force: true });
    } else {
      pendingReplayRef.current = true;
      router.push(def.homePath);
    }
  }, [available, def, pathname, router, start]);

  // Auto-start (or complete a pending replay) once the user is on the tour's home
  // screen — deferred if they landed elsewhere (Section 7).
  useEffect(() => {
    if (!available || !def || pathname !== def.homePath) return;
    const replaying = pendingReplayRef.current;
    if (!replaying && (autoStartedRef.current || !shouldAutoStart(seenRef.current, def.version))) return;
    // Flip the guard INSIDE the timer, not here: if this effect re-runs before the
    // timer fires (React Strict Mode's mount double-invoke, or any re-render), the
    // cleanup clears the timer and we must RESCHEDULE — flipping the guard early
    // would make the re-run bail and permanently cancel the start.
    const t = setTimeout(() => {
      if (replaying) pendingReplayRef.current = false;
      else autoStartedRef.current = true;
      start({ force: replaying });
    }, replaying ? 400 : 600); // let targets mount / hydration settle
    return () => clearTimeout(t);
  }, [available, def, pathname, start]);

  useEffect(
    () => () => {
      engineRef.current?.stop();
      engineRef.current = null;
    },
    [],
  );

  return (
    <TourContext.Provider value={{ available, isRunning, start, replay }}>{children}</TourContext.Provider>
  );
}
