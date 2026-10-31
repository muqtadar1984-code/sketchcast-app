"use client";

import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { InkUnderline } from "@/components/ink-mark";
import { useSkReveal } from "@/sk/walkthrough/use-reveal";
import { isActive, TOUR_MARK, type NavTab } from "./header-nav";

// A teacher's phone (founder 2026-10-31, teachers first): the header's tabs
// move to a bar at the bottom, under the thumb — three tabs, SK in the middle,
// and "More" for the rest of her tabs plus the account controls (language,
// Settings, Tour, Sign out) the header hands in as `children`. Below md only;
// the header's own row and hamburger take over from md up. The bar carries
// `data-tabbar`: globals.css keys the rest of the phone layout off it (the
// page's bottom padding, SK standing in the middle slot, the floating widgets
// riding above the bar, the `tabbar:` variant), so only the viewers the header
// gives a bar to are rearranged.
//
// The More sheet is rendered closed rather than not at all, so the SK tour can
// find a control inside it and ask for it to open (useSkReveal).

const ICONS: Record<string, ReactNode> = {
  "/dashboard": <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5M8 7h7" />,
  "/dashboard/kits": <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />,
  "/dashboard/diary": <path d="M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM5 18a2 2 0 0 1 2-2h12M9 8h6" />,
  "/present": <path d="M3 4h18v12H3zM8 20h8M12 16v4" />,
  "/dashboard/analytics": <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  "/dashboard/calendar": <path d="M3 5h18v16H3zM3 10h18M8 3v4M16 3v4" />,
  "/dashboard/my-timetable": <path d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />,
};
const FALLBACK_ICON = <path d="M5 12h14M12 5v14" />;

function Icon({ href }: { href: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[href] ?? FALLBACK_ICON}
    </svg>
  );
}

export default function PhoneTabBar({
  tabs,
  primary,
  more,
  moreLabel,
  closeLabel,
  children,
}: {
  /** Every tab (for the active rule); `primary` + `more` split them. */
  tabs: NavTab[];
  primary: NavTab[];
  more: NavTab[];
  moreLabel: string;
  closeLabel: string;
  /** The account controls, shown at the foot of the More sheet. */
  children?: ReactNode;
}) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const mine = useSkReveal(sheet, setOpen);
  const moreActive = more.some((t) => isActive(t.href, path, tabs));
  const close = () => {
    mine();
    setOpen(false);
  };

  const item = (t: NavTab) => {
    const active = isActive(t.href, path, tabs);
    return (
      <Link
        key={t.href}
        href={t.href}
        data-tour={TOUR_MARK[t.href]}
        aria-current={active ? "page" : undefined}
        className={`flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] ${
          active ? "font-semibold text-[#14181F]" : "font-medium text-[#5B6470]"
        }`}
      >
        <Icon href={t.href} />
        <span className="max-w-full truncate px-1">{t.label}</span>
        <InkUnderline className={`h-1.5 w-7 ${active ? "" : "invisible"}`} />
      </Link>
    );
  };

  return (
    <>
      <nav
        data-tabbar
        className="md:hidden fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-[#E6E8E4] bg-white px-1 pb-[env(safe-area-inset-bottom)] pl-[max(0.25rem,env(safe-area-inset-left))] pr-[max(0.25rem,env(safe-area-inset-right))]"
      >
        {primary.slice(0, 2).map(item)}
        {/* SK's slot: SK stands here (globals.css docks the launcher over it).
            Collapses when SK is not on for this viewer. */}
        <span aria-hidden data-tabbar-sk className="w-16 shrink-0" />
        {primary.slice(2).map(item)}
        <button
          type="button"
          onClick={() => {
            mine();
            setOpen((o) => !o);
          }}
          aria-expanded={open}
          aria-haspopup="dialog"
          className={`flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] ${
            moreActive || open ? "font-semibold text-[#14181F]" : "font-medium text-[#5B6470]"
          }`}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <circle cx="5" cy="12" r="1.4" />
            <circle cx="12" cy="12" r="1.4" />
            <circle cx="19" cy="12" r="1.4" />
          </svg>
          <span className="max-w-full truncate px-1">{moreLabel}</span>
          <InkUnderline className={`h-1.5 w-7 ${moreActive ? "" : "invisible"}`} />
        </button>
      </nav>

      {open && <div aria-hidden className="md:hidden fixed inset-0 z-[44] bg-[#14181F]/40" onClick={close} />}
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-label={moreLabel}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
        className={`${open ? "md:hidden" : "hidden"} fixed inset-x-0 bottom-0 z-[45] max-h-[85dvh] overflow-y-auto overscroll-contain rounded-t-2xl bg-white px-4 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-[0_-12px_40px_-12px_rgba(20,24,31,0.35)]`}
      >
        <div className="flex items-center gap-2">
          <span aria-hidden className="mx-auto my-1 h-1.5 w-10 rounded-full bg-[#D5D9D2]" />
        </div>
        <div className="flex items-center justify-between py-2">
          <p className="font-display text-lg">{moreLabel}</p>
          <button
            type="button"
            onClick={close}
            aria-label={closeLabel}
            className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-[#F5F6F3] text-[#14181F]"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </div>
        {more.length > 0 && (
          <ul className="mb-3 overflow-hidden rounded-xl border border-[#E6E8E4]">
            {more.map((t) => {
              const active = isActive(t.href, path, tabs);
              return (
                <li key={t.href} className="border-b border-[#EEF0EC] last:border-b-0">
                  <Link
                    href={t.href}
                    onClick={close}
                    data-tour={TOUR_MARK[t.href]}
                    aria-current={active ? "page" : undefined}
                    className={`flex min-h-12 items-center gap-3 px-3 text-sm ${active ? "bg-[#F5F6F3] font-medium text-[#14181F]" : "text-[#14181F]"}`}
                  >
                    <span className="text-[#5B6470]">
                      <Icon href={t.href} />
                    </span>
                    {t.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {children && (
          <div
            className="flex flex-wrap items-center gap-3 py-2"
            onClick={(e) => {
              // A link or button closes the sheet like a tab does; the pickers
              // are <select>s and leave it open. The sheet stays mounted, so
              // Sign out's form still submits.
              if ((e.target as Element).closest("a, button")) close();
            }}
          >
            {children}
          </div>
        )}
      </div>
    </>
  );
}
