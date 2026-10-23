import Link from "next/link";
import { InkUnderline } from "@/components/ink-mark";
import type { AgentSettings, PinStatus, Tone } from "@/utils/catalogue/pinterest";
import { STATUS_LABEL, STATUS_TONE } from "@/utils/catalogue/pinterest";

// The Pinterest tab's shared chrome (Pinterest Pin Engine, 0154): the
// heading, the three views and the small chips. No "use client", no
// server-only imports, so pages and client panels can both render these.

const VIEWS = [
  { key: "review", href: "/library/pinterest", label: "Review" },
  { key: "posting", href: "/library/pinterest/posting", label: "Scheduled & posted" },
  { key: "boards", href: "/library/pinterest/boards", label: "Boards" },
] as const;

export function PinterestHeading({ settings }: { settings?: AgentSettings | null }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-3xl font-display mb-1">Pinterest</h1>
        <InkUnderline className="block h-3 w-24 mb-3" color="#7FD8A8" />
      </div>
      {settings ? <ModeChip settings={settings} /> : null}
    </div>
  );
}

export function PinterestNav({ active, counts }: { active: (typeof VIEWS)[number]["key"]; counts?: Record<string, number> }) {
  const badge: Record<string, number | undefined> = {
    review: counts?.in_review,
    posting: (counts?.approved ?? 0) + (counts?.scheduled ?? 0) + (counts?.posting ?? 0) || undefined,
  };
  return (
    <nav aria-label="Pinterest views" className="flex flex-wrap gap-1 mb-5 text-sm">
      {VIEWS.map((v) => (
        <Link
          key={v.key}
          href={v.href}
          aria-current={v.key === active ? "page" : undefined}
          className={
            v.key === active
              ? "rounded-full px-3 py-1 bg-[#14241E] text-white font-medium"
              : "rounded-full px-3 py-1 text-[#5B6470] hover:text-[#14181F] hover:bg-[#EEF0EC]"
          }
        >
          {v.label}
          {badge[v.key] ? <span className="ml-1.5 tabular-nums opacity-80">{badge[v.key]}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

const TONE: Record<Tone, string> = {
  neutral: "bg-[#EEF0EC] text-[#5B6470]",
  info: "bg-[#E8F0FE] text-[#1F4FB8]",
  good: "bg-[#E6F6F2] text-[#0F7A68]",
  warn: "bg-[#FFF1D6] text-[#9A6400]",
  bad: "bg-[#FFE9E3] text-[#B3401F]",
};

export function PinStatusChip({ status }: { status: PinStatus }) {
  return <span className={`chip ${TONE[STATUS_TONE[status]]}`}>{STATUS_LABEL[status]}</span>;
}

/** Where the agent stands, in one chip: off, dry run, paused, breaker, live. */
export function ModeChip({ settings }: { settings: AgentSettings }) {
  const [label, tone]: [string, Tone] = !settings.enabled
    ? ["Agent off", "neutral"]
    : settings.breaker?.tripped
      ? ["Breaker tripped", "bad"]
      : settings.paused
        ? ["Paused", "warn"]
        : settings.dry_run !== false
          ? ["Dry run — nothing reaches Pinterest", "warn"]
          : ["Live", "good"];
  return <span className={`chip ${TONE[tone]}`}>{label}</span>;
}

export function MissingPinterestBanner() {
  return (
    <p className="text-sm text-[#9A6400] bg-[#FFF9EE] rounded-lg px-4 py-3">
      The Pinterest tables are not in this database yet. Apply <span className="font-medium">0154_pinterest_pin_engine.sql</span>, then reload.
    </p>
  );
}

export const LANGUAGE_NAME: Record<string, string> = {
  en: "English", ar: "Arabic", ms: "Malay", "ms-arab": "Jawi", hi: "Hindi", mr: "Marathi",
  te: "Telugu", ur: "Urdu", fr: "French", es: "Spanish", pt: "Portuguese",
};
export const languageName = (code: string) => LANGUAGE_NAME[code] ?? code;
