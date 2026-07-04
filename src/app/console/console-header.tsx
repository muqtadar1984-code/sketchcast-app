"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoMark } from "../dashboard/icons";

const TABS = [
  { href: "/console", label: "Overview" },
  { href: "/console/issues", label: "Issues" },
  { href: "/console/users", label: "Users" },
  { href: "/console/schools", label: "Schools" },
  { href: "/console/feedback", label: "Feedback" },
  { href: "/console/audit", label: "Audit" },
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
    <header className="border-b border-[#2A3140] bg-[#14181F] text-white">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <span className="flex items-center gap-6">
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
          <Link href="/dashboard" className="text-[#98A0A9] hover:text-white">
            ← App
          </Link>
        </div>
      </div>
    </header>
  );
}
