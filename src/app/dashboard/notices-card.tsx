import { NoticeAckButton } from "./notice-banner-client";
import type { Notice } from "@/utils/notices";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { fmt } from "@/i18n/format";

// "Next 10" — the quiet half of the notices pair. The banner interrupts; this
// just lists what is coming, soonest first, on every dashboard so a parent, a
// teacher and a student all read the same board (each through their own RLS
// slice — see utils/notices.ts, which is also where the is_notice filter lives:
// an ordinary school-wide calendar entry is not an announcement and never
// reaches this list).
//
// A row is deliberately one line of information: how long is left, what it is,
// who it went to, and — only where THIS viewer owes one — the signature. Who is
// asked is decided upstream (staff sign staff notices, parents sign important
// Everyone ones, students sign nothing), so this file just honours seeksAck.
// The countdown chip turns amber inside two days; nothing here ever goes red,
// because red means something broke.
//
// Stays a SERVER component: only the receipt button needs the browser, and it
// is handed its words from here (resolveLocale is React-cached per request, so
// asking costs nothing beyond what the layout already paid).

export default async function NoticesCard({ notices }: { notices: Notice[] }) {
  const dict = await getDictionary(await resolveLocale());
  const t = dict.comms.notices.card;

  // Empty is the normal state for most schools most weeks. One muted line says
  // so without spending a whole card on nothing.
  if (!notices.length) {
    return <p className="text-sm text-[#98A0A9] mb-8">{t.empty}</p>;
  }

  return (
    <section className="mb-8">
      <h2 className="text-xl mb-1">{t.title}</h2>
      <p className="text-sm text-[#5B6470] mb-3">{t.subtitle}</p>
      <div className="card divide-y divide-[#EEF0EC]">
        {notices.map((n) => (
          <div key={n.id} className="px-5 py-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-[#14181F] [overflow-wrap:anywhere]">
                {n.title}
                {n.linkUrl && (
                  <a
                    href={n.linkUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    // The label is the accessible name — "↗" alone tells a
                    // screen-reader user nothing about where it goes.
                    aria-label={fmt(t.opensInNewTab, { label: n.linkLabel })}
                    title={n.linkLabel}
                    className="ms-1.5 font-medium text-[#0C8175] hover:underline"
                  >
                    ↗
                  </a>
                )}
              </div>
              <div className="text-xs text-[#5B6470]">
                {n.when} · {n.audienceLabel}
                {n.important ? ` · ${t.important}` : ""}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span
                title={n.when}
                className={`chip ${n.countdown.urgent ? "bg-[#FFF1D6] text-[#9A6400]" : "bg-[#EEF0EC] text-[#5B6470]"}`}
              >
                {n.countdown.label}
              </span>
              {n.seeksAck && <NoticeAckButton noticeId={n.id} acked={n.acked} t={dict.comms.notices.ack} />}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
