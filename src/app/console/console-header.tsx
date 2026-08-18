"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoMark } from "../dashboard/icons";
import MobileNav from "../dashboard/mobile-nav";

const TABS = [
  { href: "/console", label: "Overview" },
  { href: "/console/issues", label: "Issues" },
  { href: "/console/users", label: "Users" },
  { href: "/console/schools", label: "Schools" },
  { href: "/console/content", label: "Content" },
  { href: "/console/feedback", label: "Feedback" },
  { href: "/console/financials", label: "Financials" },
];

function isActive(href: string, path: string): boolean {
  if (href === "/console") return path === "/console";
  return path === href || path.startsWith(href + "/");
}

// Staff chrome — deliberately distinct from AppHeader (dark band) so a founder
// with two tabs open never mistakes which world they're acting in.
export default function ConsoleHeader({ email }: { email: string }) {
  const path = usePathname();
  return (
    // `relative` so the mobile menu panel anchors to this bar rather than the page.
    <header className="relative border-b border-[#2A3140] bg-[#14181F] text-white">
      {/* Full-bleed like the landing header (founder, 2026-08-18): the brand
          sits at the true left edge and the account cluster at the true right,
          instead of floating inside a centered max-w-7xl column. */}
      <div className="px-6 h-14 flex items-center justify-between">
        <span className="flex items-center gap-3 sm:gap-6">
          {/* The tab row below is `hidden sm:flex`, which left a phone with NO
              route to Issues / Users / Schools / Content / Feedback / Audit —
              the founder could reach the console and then not navigate it. Same
              defect, and the same fix, as the teacher header (see mobile-nav's
              header comment: "Khaja's report"). Reused rather than rewritten so
              the two menus cannot drift. Staff chrome is English by design (see
              console/layout.tsx), so the labels are literals here, unlike the
              dashboard's which arrive translated. */}
          <MobileNav
            tabs={TABS}
            openLabel="Open menu"
            closeLabel="Close menu"
            className="sm:hidden"
            tone="dark"
            panelTop="top-14"
          />
          <Link href="/console" className="flex items-center gap-2.5 text-lg font-display text-white">
            <LogoMark size={26} />
            Console
          </Link>
          <nav className="hidden sm:flex items-center gap-5 text-sm">
            {TABS.map((t) => (
              <Link
                key={t.href}
                href={t.href}
                aria-current={isActive(t.href, path) ? "page" : undefined}
                className={
                  isActive(t.href, path)
                    ? "text-white font-medium border-b-2 border-[#1FB8A6] pb-0.5"
                    : "text-[#98A0A9] hover:text-white"
                }
              >
                {t.label}
              </Link>
            ))}
          </nav>
        </span>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-[#98A0A9] hidden md:inline">{email} · staff</span>
          {/* On the dedicated console subdomain the teacher app is a different
              host (and @sketchcast.app has no teacher side), so drop the cross-link
              there and rely on a real sign-out. In legacy mode "← App" still helps. */}
          {!process.env.NEXT_PUBLIC_CONSOLE_HOST && (
            <Link href="/dashboard" className="text-[#98A0A9] hover:text-white">
              <span className="rtl-flip">←</span> App
            </Link>
          )}
          <form action="/auth/signout" method="post">
            <button className="text-[#98A0A9] hover:text-white">Sign out</button>
          </form>
        </div>
      </div>
    </header>
  );
}
