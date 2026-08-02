// How wide the dashboard bar has to be before its tab row can sit INLINE
// rather than behind the hamburger.
//
// This used to be a flat `sm` for everyone, which was never true: a student
// carries two tabs and a principal seven, and both compete with the same
// right-hand cluster of controls. Once the language picker joined that cluster
// (+189px measured) a principal's row at 1536px no longer fit its centred box
// and painted 35px over the brand on one side and the hat switcher on the
// other. Estimating the width per viewer is what stops that recurring as tabs
// and controls come and go.
//
// The constants are measured from the rendered header (English, 2026-08-02).
// The per-tab figure is rounded up from the ~75px English average because
// Malay and Arabic labels run longer ("Timetable" is "Jadual Waktu"). This
// only has to be close enough to pick a breakpoint: the row is independently
// clip-safe (see header-nav), so an underestimate degrades to a scrollable
// strip rather than back to an overlap.

/** Bar chrome that is always present: scrollbar, padding, brand, gaps (273) +
 *  the bell, Tour and Sign out every viewer carries with their gaps (217). */
const BASE = 490;
const LANGUAGE_PICKER = 189;
const HAT_SWITCHER = 175;
const PER_TAB = 88;

/** Tailwind's default screens, smallest first. */
const TIERS = [
  { px: 640, show: "hidden sm:flex", hide: "sm:hidden" },
  { px: 768, show: "hidden md:flex", hide: "md:hidden" },
  { px: 1024, show: "hidden lg:flex", hide: "lg:hidden" },
  { px: 1280, show: "hidden xl:flex", hide: "xl:hidden" },
  { px: 1536, show: "hidden 2xl:flex", hide: "2xl:hidden" },
] as const;

export type HeaderFit = {
  /** px the bar needs at this viewer's combination of tabs and controls. */
  needed: number;
  /** Class for the inline tab row — literal, so Tailwind can see and emit it. */
  navShow: string;
  /** Its mirror for the hamburger: exactly one of the two is ever on screen. */
  navHide: string;
};

export function headerFit({
  tabs,
  hatSwitcher,
  languagePicker,
}: {
  tabs: number;
  hatSwitcher: boolean;
  languagePicker: boolean;
}): HeaderFit {
  const needed =
    BASE + (languagePicker ? LANGUAGE_PICKER : 0) + (hatSwitcher ? HAT_SWITCHER : 0) + tabs * PER_TAB;
  // The smallest tier that clears it; the widest if nothing does.
  const tier = TIERS.find((t) => t.px >= needed) ?? TIERS[TIERS.length - 1];
  return { needed, navShow: tier.show, navHide: tier.hide };
}
