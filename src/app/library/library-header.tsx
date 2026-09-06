"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoMark } from "../dashboard/icons";
import MobileNav from "../dashboard/mobile-nav";

// Portal tabs. Phase 1 (taxonomy) ships Topics, Curricula, Candidates, Harvest;
// later phases add Articles queue, Kits queue, Blueprints, Publish.
const TABS = [
  { href: "/library", label: "Overview" },
  { href: "/library/topics", label: "Topics" },
  { href: "/library/curricula", label: "Curricula" },
  { href: "/library/candidates", label: "Candidates" },
  { href: "/library/harvest", label: "Harvest" },
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
  return (
    <header className="relative border-b border-[#1F3A31] bg-[#14241E] text-white">
      <div className="px-6 h-14 flex items-center justify-between gap-6">
        <span className="flex items-center gap-3 shrink-0">
          <MobileNav
            tabs={TABS}
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
          {TABS.map((t) => (
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
