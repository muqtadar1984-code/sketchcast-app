"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { InkUnderline } from "@/components/ink-mark";

export type NavTab = { href: string; label: string };

// data-tour markers on specific nav destinations (for role tours that point at
// where to go rather than an on-screen element).
const TOUR_MARK: Record<string, string | undefined> = {
  "/dashboard/school": "school-nav",
  "/dashboard/test-papers": "test-papers-nav",
};

// A tab is active on its own route, but NOT when a more specific sibling tab also
// matches (so "School" doesn't underline while you're on "/dashboard/school/admin").
// Exported for the mobile menu (mobile-nav.tsx) — same rule, different chrome.
export function isActive(href: string, path: string, tabs: NavTab[]): boolean {
  if (href === "/dashboard") return path === "/dashboard";
  if (path !== href && !path.startsWith(href + "/")) return false;
  return !tabs.some(
    (o) => o.href !== href && o.href.startsWith(href + "/") && (path === o.href || path.startsWith(o.href + "/")),
  );
}

// Dashboard nav. The active tab gets the ink-underline motif (drawn on) — the one
// place the signature appears in the app chrome. Tabs are role-derived upstream.
//
// `className` carries the width at which this row is allowed to show at all;
// the header picks it from how crowded THIS viewer's bar is (see app-header).
//
// The row is clip-safe on purpose. It sits in a centred `flex-1 min-w-0` box,
// so if it is ever wider than that box it would otherwise paint straight over
// the brand and the controls either side of it — which is what a principal saw
// once the language picker joined the bar. `max-w-full` + `overflow-x-auto`
// caps it at its box and lets the surplus scroll instead of escaping. That
// guarantee has to hold in ten languages, where no breakpoint tuned against
// English labels can be trusted ("Timetable" is "Jadual Waktu" in Malay).
//
// Two details make the cap behave: the links must NOT shrink (a flex item
// shrinks to its min-content before a container scrolls, which would wrap
// two-word labels instead), and the row needs vertical padding — the ink
// underline hangs 8px BELOW its link, and an overflow-x container clips its
// y-axis too, so without that padding the signature would be shaved off.
export default function HeaderNav({ tabs, className = "hidden sm:flex" }: { tabs: NavTab[]; className?: string }) {
  const path = usePathname();
  return (
    <nav className={`${className} items-center gap-6 text-sm max-w-full overflow-x-auto no-scrollbar py-2.5`}>
      {tabs.map((t) => {
        const active = isActive(t.href, path, tabs);
        return (
          <Link
            key={t.href}
            href={t.href}
            data-tour={TOUR_MARK[t.href]}
            aria-current={active ? "page" : undefined}
            className={`relative shrink-0 whitespace-nowrap ${active ? "text-[#14181F] font-medium" : "text-[#5B6470] hover:text-[#14181F]"}`}
          >
            {t.label}
            {active && <InkUnderline className="absolute -bottom-2 start-0 h-2 w-full" />}
          </Link>
        );
      })}
    </nav>
  );
}
