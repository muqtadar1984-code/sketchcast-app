import { NoticeAckButton } from "./notice-banner";
import type { Notice } from "@/utils/notices";

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

export default function NoticesCard({ notices }: { notices: Notice[] }) {
  // Empty is the normal state for most schools most weeks. One muted line says
  // so without spending a whole card on nothing.
  if (!notices.length) {
    return <p className="text-sm text-[#98A0A9] mb-8">No school notices right now.</p>;
  }

  return (
    <section className="mb-8">
      <h2 className="text-xl mb-1">School notices</h2>
      <p className="text-sm text-[#5B6470] mb-3">What&apos;s coming up, soonest first.</p>
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
                    aria-label={`${n.linkLabel} — opens in a new tab`}
                    title={n.linkLabel}
                    className="ms-1.5 font-medium text-[#0C8175] hover:underline"
                  >
                    ↗
                  </a>
                )}
              </div>
              <div className="text-xs text-[#5B6470]">
                {n.when} · {n.audienceLabel}
                {n.important ? " · important" : ""}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span
                title={n.when}
                className={`chip ${n.countdown.urgent ? "bg-[#FFF1D6] text-[#9A6400]" : "bg-[#EEF0EC] text-[#5B6470]"}`}
              >
                {n.countdown.label}
              </span>
              {n.seeksAck && <NoticeAckButton noticeId={n.id} acked={n.acked} />}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
