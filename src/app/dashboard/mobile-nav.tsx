"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { isActive, type NavTab } from "./header-nav";

// Phone-width nav: the desktop tabs are `hidden sm:flex`, which left phones
// with NO route to My children / Test Papers / Timetable / School (Khaja's
// report). This hamburger sits at the far left of the header and opens the
// same role-derived tabs as a dropdown panel. Rendered for every role —
// teacher, student, parent, and all school hats — because it receives the
// exact tabs the desktop nav shows.
export default function MobileNav({ tabs }: { tabs: NavTab[] }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();

  return (
    <div className="sm:hidden shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? "Close menu" : "Open menu"}
        className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-[#E6E8E4] bg-white text-[#14181F]"
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
          <nav className="absolute left-0 right-0 top-16 z-30 border-b border-[#E6E8E4] bg-white shadow-lg">
            {tabs.map((t) => {
              const active = isActive(t.href, path, tabs);
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  onClick={() => setOpen(false)}
                  aria-current={active ? "page" : undefined}
                  className={`block px-5 py-3 text-sm border-b border-[#F1F2EF] last:border-b-0 ${
                    active ? "text-[#14181F] font-medium bg-[#F5F6F3]" : "text-[#5B6470]"
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
