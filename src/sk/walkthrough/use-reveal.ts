"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { onSkReveal } from "./bus";

// A container that starts closed (a teacher's More sheet, a chapter's action
// sheet) follows the SK tour (bus.ts): when the tour names a control inside
// it, it opens — or, already open, stays open; when the tour moves on to a
// control anywhere else, or pauses or ends, it closes again, but only if it
// was the TOUR that opened it. Returns `mine`, to call when the teacher opens
// or closes it herself, so a sheet she opened is never shut under her.
export function useSkReveal(box: RefObject<HTMLElement | null>, open: boolean, setOpen: (open: boolean) => void): () => void {
  const byTour = useRef(false);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(
    () =>
      onSkReveal((d) => {
        const el = box.current;
        const holds = !!d.els && !d.claimed && !!el && d.els.some((x) => el.contains(x));
        if (holds) {
          d.claimed = true;
          if (!openRef.current) {
            byTour.current = true;
            openRef.current = true;
            setOpen(true);
          }
          return;
        }
        if (byTour.current) {
          byTour.current = false;
          openRef.current = false;
          setOpen(false);
        }
      }),
    [box, setOpen],
  );
  return useCallback(() => {
    byTour.current = false;
  }, []);
}
