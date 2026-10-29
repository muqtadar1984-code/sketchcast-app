"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "", label: "Overview" },
  { href: "/chapters", label: "Chapters" },
  { href: "/gaps", label: "Gaps" },
  { href: "/changes", label: "Changes" },
  { href: "/findings", label: "Findings" },
  { href: "/files", label: "Files" },
  { href: "/costs", label: "Costs" },
  { href: "/runs", label: "Pipeline" },
];

export default function BookTabs({ slug }: { slug: string }) {
  const path = usePathname();
  const base = `/books/${slug}`;
  return (
    <nav className="flex gap-5 overflow-x-auto text-sm -mb-px">
      {TABS.map((t) => {
        const href = base + t.href;
        const active = t.href === "" ? path === base : path === href || path.startsWith(href + "/");
        return (
          <Link
            key={t.href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={(active ? "border-[#B8862F] text-[#1F2A24] font-medium" : "border-transparent text-[#7A7363] hover:text-[#1F2A24]") + " border-b-2 pb-2 whitespace-nowrap"}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
