"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { InkUnderline } from "@/components/ink-mark";

export type NavTab = { href: string; label: string };

// A tab is active on its own route, but NOT when a more specific sibling tab also
// matches (so "School" doesn't underline while you're on "/dashboard/school/admin").
function isActive(href: string, path: string, tabs: NavTab[]): boolean {
  if (href === "/dashboard") return path === "/dashboard";
  if (path !== href && !path.startsWith(href + "/")) return false;
  return !tabs.some(
    (o) => o.href !== href && o.href.startsWith(href + "/") && (path === o.href || path.startsWith(o.href + "/")),
  );
}

// Dashboard nav. The active tab gets the ink-underline motif (drawn on) — the one
// place the signature appears in the app chrome. Tabs are role-derived upstream.
export default function HeaderNav({ tabs }: { tabs: NavTab[] }) {
  const path = usePathname();
  return (
    <nav className="hidden sm:flex items-center gap-6 text-sm">
      {tabs.map((t) => {
        const active = isActive(t.href, path, tabs);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`relative ${active ? "text-[#14181F] font-medium" : "text-[#5B6470] hover:text-[#14181F]"}`}
          >
            {t.label}
            {active && <InkUnderline className="absolute -bottom-2 left-0 h-2 w-full" />}
          </Link>
        );
      })}
    </nav>
  );
}
