"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoMark } from "../dashboard/icons";
import MobileNav from "../dashboard/mobile-nav";
import { libraryAllows, type LibraryRole } from "@/utils/library-routing";

// Portal tabs. Phase 1 (taxonomy) ships Topics, Curricula, Candidates, Harvest;
// Phase 3 adds Blueprints (the composer's presets — a topic's question bank
// lives under its topic page, not as a tab); later phases add Publish. Since
// 2026-10-17 Topics opens the review inbox (the topic page, layout D) on the
// newest kit awaiting a reviewer; the list is one click away inside it.
// Since 2026-10-18 Translations (every topic x every lesson language) sits
// beside it, for every member. Since 2026-10-21 Fixes (the Fix Agent's cases,
// 0151) sits beside Translations for platform admins only — the page and its
// route are admin-only too.
const TABS: { href: string; label: string; adminOnly?: boolean }[] = [
  { href: "/library", label: "Overview" },
  { href: "/library/topics", label: "Topics" },
  { href: "/library/translations", label: "Translations" },
  { href: "/library/fixes", label: "Fixes", adminOnly: true },
  { href: "/library/curricula", label: "Curricula" },
  { href: "/library/candidates", label: "Candidates" },
  { href: "/library/harvest", label: "Harvest" },
  { href: "/library/blueprints", label: "Blueprints" },
  { href: "/library/demos", label: "Demos" },
];

function isActive(href: string, path: string): boolean {
  if (href === "/library") return path === "/library";
  return path === href || path.startsWith(href + "/");
}

// Portal chrome — a deep green band, distinct from the console's dark navy and
// the teacher app's light header, so a member with several tabs open never
// mistakes which world they are acting in.
export default function LibraryHeader({ email, role }: { email: string; role: string }) {
  const path = usePathname();
  const tabs = TABS.filter((t) => !t.adminOnly || libraryAllows(role as LibraryRole, "publish")).map(({ href, label }) => ({ href, label }));
  return (
    <header className="relative border-b border-[#1F3A31] bg-[#14241E] text-white">
      <div className="px-6 h-14 flex items-center justify-between gap-6">
        <span className="flex items-center gap-3 shrink-0">
          <MobileNav
            tabs={tabs}
            openLabel="Open menu"
            closeLabel="Close menu"
            className="sm:hidden"
            tone="dark"
            panelTop="top-14"
          />
          <Link href="/library" className="flex items-center gap-2.5 text-lg font-display text-white">
            <LogoMark size={26} />
            Library
          </Link>
        </span>
        <nav className="hidden sm:flex flex-1 items-center justify-center gap-5 text-sm min-w-0">
          {tabs.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              aria-current={isActive(t.href, path) ? "page" : undefined}
              className={
                (isActive(t.href, path)
                  ? "text-white font-medium border-b-2 border-[#7FD8A8] pb-0.5"
                  : "text-[#9DB3A9] hover:text-white") + " whitespace-nowrap"
              }
            >
              {t.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-4 text-sm shrink-0">
          <span className="text-[#9DB3A9] hidden md:inline">
            {email} · {role}
          </span>
          <form action="/auth/signout" method="post">
            <button className="text-[#9DB3A9] hover:text-white">Sign out</button>
          </form>
        </div>
      </div>
    </header>
  );
}
