"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { onSkReveal } from "./bus";

// A container that starts closed (a teacher's More sheet, a chapter's action
// sheet) answers the tour's reveal requests (bus.ts): it opens when it holds
// the hidden control the tour is looking for, and on the tour's "close" it
// closes again — but only if it was the TOUR that opened it. Returns `mine`,
// to call when the teacher opens or closes it herself, so a sheet she opened
// is never shut under her.
export function useSkReveal(box: RefObject<HTMLElement | null>, setOpen: (open: boolean) => void): () => void {
  const byTour = useRef(false);
  useEffect(
    () =>
      onSkReveal((d) => {
        if (d.els === null) {
          if (byTour.current) {
            byTour.current = false;
            setOpen(false);
          }
          return;
        }
        const el = box.current;
        if (d.claimed || !el || !d.els.some((x) => el.contains(x))) return;
        d.claimed = true;
        byTour.current = true;
        setOpen(true);
      }),
    [box, setOpen],
  );
  return useCallback(() => {
    byTour.current = false;
  }, []);
}
