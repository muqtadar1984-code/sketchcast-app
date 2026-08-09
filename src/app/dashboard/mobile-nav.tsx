"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { isActive, type NavTab } from "./header-nav";

// Narrow-width nav: the desktop tabs used to be `hidden sm:flex`, which left
// phones with NO route to My children / Test Papers / Timetable / School
// (Khaja's report). This hamburger sits at the far left of the header and
// opens the same role-derived tabs as a dropdown panel. Rendered for every
// role — teacher, student, parent, and all school hats — because it receives
// the exact tabs the desktop nav shows.
//
// `className` is the mirror of the tab row's: the header hands each of them
// the same breakpoint from opposite sides, so exactly one is ever on screen.
// It is no longer a fixed `sm` — a principal carries seven tabs plus two
// dropdowns and needs far more room before the inline row is honest, while a
// student with two tabs needs much less.
//
// The tab labels arrive already translated (the header builds them from the
// request's dictionary); the two words this component owns — the button's
// accessible name in each state — come in as props for the same reason.
//
// `tone` exists because the staff console wears a dark band and had the SAME
// bug this component was written to fix — its tabs were `hidden sm:flex` with
// no fallback, so a founder on a phone had no route to Issues / Users /
// Schools / Content / Feedback / Audit at all. Reusing this rather than
// writing a second menu means a fix to the behaviour (backdrop, aria, active
// rule) lands on both surfaces at once. The light values are the originals, so
// the dashboard renders byte-identically to before.
//
// `panelTop` is separate from `tone` because it tracks the HEADER's height, not
// its colour: the dashboard bar is h-16 and the console's is h-14. The panel is
// absolutely positioned, so whichever header mounts this must be `relative` or
// the menu will anchor to the page instead of the bar.
const TONES = {
  light: {
    button: "border-[#E6E8E4] bg-white text-[#14181F]",
    panel: "border-[#E6E8E4] bg-white",
    divider: "border-[#F1F2EF]",
    active: "text-[#14181F] font-medium bg-[#F5F6F3]",
    idle: "text-[#5B6470]",
  },
  dark: {
    button: "border-[#2A3140] bg-[#1B212B] text-white",
    panel: "border-[#2A3140] bg-[#14181F]",
    divider: "border-[#2A3140]",
    active: "text-white font-medium bg-[#1B212B]",
    idle: "text-[#98A0A9]",
  },
} as const;

export default function MobileNav({
  tabs,
  openLabel,
  closeLabel,
  className = "sm:hidden",
  tone = "light",
  panelTop = "top-16",
}: {
  tabs: NavTab[];
  openLabel: string;
  closeLabel: string;
  className?: string;
  tone?: keyof typeof TONES;
  panelTop?: string;
}) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  const c = TONES[tone];

  return (
    <div className={`${className} shrink-0`}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? closeLabel : openLabel}
        className={`h-9 w-9 inline-flex items-center justify-center rounded-lg border ${c.button}`}
      >
        {open ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M2 4h12M2 8h12M2 12h12" />
          </svg>
        )}
      </button>

      {open && (
        <>
          {/* Backdrop: tap anywhere else to close. */}
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden />
          <nav className={`absolute start-0 end-0 ${panelTop} z-30 border-b shadow-lg ${c.panel}`}>
            {tabs.map((t) => {
              const active = isActive(t.href, path, tabs);
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  onClick={() => setOpen(false)}
                  aria-current={active ? "page" : undefined}
                  className={`block px-5 py-3 text-sm border-b last:border-b-0 ${c.divider} ${
                    active ? c.active : c.idle
                  }`}
                >
                  {t.label}
                </Link>
              );
            })}
          </nav>
        </>
      )}
    </div>
  );
}
