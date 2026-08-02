"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fmt } from "@/i18n/format";
import type { Dictionary } from "@/i18n/dictionaries";
import type { Notice } from "@/utils/notices";

// The notices reader's CLIENT half: the rotating featured banner, and the one
// interactive control the (server) Next-10 card needs — NoticeAckButton — which
// keeps notices-card.tsx a server component instead of pulling the whole list
// into the browser for the sake of one button. Both are rendered through their
// server shells (./notice-banner.tsx, ./notices-card.tsx), which is where the
// words come from: the dictionary is server-only, so the strings cross the
// boundary and the file never does.
//
// Three notices can't all shout at once, so they rotate on a slow crossfade —
// which pauses the moment the reader engages: hover for pointer users, and
// focus for keyboard ones (React's onFocus/onBlur are focusin/focusout, so they
// bubble and give us focus-WITHIN without a CSS-only :focus-within trick that
// JS can't observe). Those two are INCIDENTAL pauses though — they end the
// moment the pointer leaves — so there is also an explicit Pause/Play toggle
// that stays put (WCAG 2.2.2: moving content needs a mechanism to stop it, not
// a knack for hovering). Swaps are announced politely rather than assertively:
// this is ambient, and it must never cut across what a screen reader is saying.
// Under prefers-reduced-motion nothing moves at all: every pinned notice
// renders as a plain static stack, which is also the more complete surface —
// the animation is a space-saving device, never the content.
//
// Dismissals are per notice and last the SESSION (sessionStorage, not local):
// tomorrow's fee deadline should meet the reader again tomorrow.

/** Every word the banner renders. Typed from the English dictionary, but the
 * import is type-only — the server-only module is erased here and no
 * translation file reaches the browser bundle. */
export type NoticeBannerMessages = Dictionary["comms"]["notices"]["banner"];
export type NoticeAckMessages = Dictionary["comms"]["notices"]["ack"];

const DISMISS_KEY = "sc-notices-dismissed";
const ROTATE_MS = 7000;

export default function NoticeBannerRotator({ notices, t }: { notices: Notice[]; t: NoticeBannerMessages }) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [still, setStill] = useState(false); // reduced motion → static stack
  const [engaged, setEngaged] = useState(false); // hover/focus — ends on its own
  const [held, setHeld] = useState(false); // the explicit toggle — stays put
  const [active, setActive] = useState(0);

  // The motion preference and the session dismissals are read AFTER mount:
  // either one in a state initializer would make the server and the client
  // render different markup. Deferred a tick (the beta-banner idiom) so the
  // first paint isn't a setState cascade.
  useEffect(() => {
    const timer = setTimeout(() => {
      setStill(!!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
      try {
        const ids: unknown = JSON.parse(sessionStorage.getItem(DISMISS_KEY) ?? "null");
        if (Array.isArray(ids)) setDismissed(ids.filter((i): i is string => typeof i === "string"));
      } catch {
        /* private mode — nothing was dismissed */
      }
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const visible = notices.filter((n) => !dismissed.includes(n.id));
  // `active` only ever grows (a dismissal must not skip a card); the modulo
  // here is what turns it into a position.
  const idx = visible.length ? active % visible.length : 0;

  useEffect(() => {
    if (still || engaged || held || visible.length < 2) return;
    const t = setInterval(() => setActive((i) => i + 1), ROTATE_MS);
    return () => clearInterval(t);
  }, [still, engaged, held, visible.length]);

  if (!visible.length) return null;

  function dismiss(id: string) {
    const next = [...dismissed, id];
    setDismissed(next);
    try {
      sessionStorage.setItem(DISMISS_KEY, JSON.stringify(next));
    } catch {
      /* best-effort — it just comes back on the next page load */
    }
  }

  return (
    <section
      aria-label={t.sectionLabel}
      // Marker/amber, the palette's urgency tone — red is reserved for errors.
      className="mb-6 rounded-xl border border-[#F0DCA8] bg-[#FFF1D6] px-4 py-3"
      onMouseEnter={() => setEngaged(true)}
      onMouseLeave={() => setEngaged(false)}
      onFocus={() => setEngaged(true)}
      onBlur={() => setEngaged(false)}
    >
      {still ? (
        <div className="divide-y divide-[#F0DCA8]">
          {visible.map((n) => (
            <div key={n.id} className="py-2 first:pt-0 last:pb-0">
              <NoticeLine notice={n} onDismiss={() => dismiss(n.id)} t={t} />
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* One grid cell, every notice in it: the container keeps the height
              of the tallest card, so a crossfade never makes the page jump.
              aria-live announces the swap for anyone who isn't watching the
              fade — polite, so it waits its turn. */}
          <div className="grid" aria-live="polite">
            {visible.map((n, i) => (
              <div
                key={n.id}
                className={`[grid-area:1/1] transition-opacity duration-500 ${
                  i === idx ? "opacity-100" : "opacity-0 pointer-events-none"
                }`}
                aria-hidden={i !== idx}
                // Faded-out cards keep their space but leave the tab order —
                // without this, Tab lands on an invisible "Open" button.
                inert={i !== idx}
              >
                <NoticeLine notice={n} onDismiss={() => dismiss(n.id)} t={t} />
              </div>
            ))}
          </div>
          {visible.length > 1 && (
            // The dots are the ONLY way to reach notices 2 and 3, so each one
            // gets a 24px target (WCAG 2.5.8) — the button is the target, the
            // span inside is the dot you see. -ms-1.5 pulls the row back level
            // with the text now that every dot carries its own padding.
            <div className="mt-1.5 -ms-1.5 flex items-center gap-0.5">
              {visible.map((n, i) => (
                <button
                  key={n.id}
                  onClick={() => setActive(i)}
                  aria-label={fmt(t.showNotice, { n: i + 1, total: visible.length })}
                  aria-current={i === idx}
                  className="flex h-6 w-6 items-center justify-center"
                >
                  <span
                    className={`block h-1.5 rounded-full transition-all ${
                      i === idx ? "w-5 bg-[#9A6400]" : "w-1.5 bg-[#9A6400]/40 hover:bg-[#9A6400]/70"
                    }`}
                  />
                </button>
              ))}
              {/* A toggle whose LABEL is the action, not the state — the
                  plain-button media pattern, so no aria-pressed to contradict
                  it. Present whenever anything rotates, which is the point:
                  hover isn't a mechanism a keyboard or a tremor can rely on. */}
              <button
                onClick={() => setHeld((h) => !h)}
                title={held ? t.resumeRotating : t.stopRotating}
                className="ms-1 h-6 px-1.5 text-xs text-[#9A6400] hover:text-[#14181F] hover:underline"
              >
                {held ? t.play : t.pause}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** One pinned notice, identical in the rotator and the reduced-motion stack. */
function NoticeLine({
  notice: n,
  onDismiss,
  t,
}: {
  notice: Notice;
  onDismiss: () => void;
  t: NoticeBannerMessages;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5 mb-1">
          <span className="chip bg-white text-[#9A6400]">{n.countdown.label}</span>
          {n.important && (
            <span className="chip font-sans normal-case tracking-normal bg-white text-[#9A6400]">{t.important}</span>
          )}
          {/* `when` leads with the action label while the deadline clock is the
              one running ("Register by Fri, 8 Aug"), and is the plain event
              date once it has flipped. */}
          <span className="text-xs text-[#9A6400]">
            {n.when} · {n.audienceLabel}
          </span>
        </div>
        <p className="font-display font-medium text-[#14181F] [overflow-wrap:anywhere]">{n.title}</p>
        {n.detail && (
          <p className="text-sm text-[#5B6470] mt-0.5 line-clamp-2 [overflow-wrap:anywhere]">{n.detail}</p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {n.linkUrl && (
          <a
            href={n.linkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary h-9 px-3.5 text-sm"
          >
            {n.linkLabel} ↗
          </a>
        )}
        <button
          onClick={onDismiss}
          aria-label={fmt(t.dismiss, { title: n.title })}
          title={t.dismissTitle}
          className="text-[#9A6400] hover:text-[#14181F] text-lg leading-none"
        >
          ×
        </button>
      </div>
    </div>
  );
}

/**
 * "I have read this" — one receipt per person (0068's notice_acks), never a
 * toggle, so the confirmed state is terminal. Rendered by the (server) Next-10
 * card only where THIS viewer owes a signature — staff sign staff notices,
 * parents sign important Everyone ones, students sign nothing (the rule lives
 * in utils/notices.ts's seeksAck, which is viewer-aware).
 */
export function NoticeAckButton({
  noticeId,
  acked,
  t,
}: {
  noticeId: string;
  acked: boolean;
  t: NoticeAckMessages;
}) {
  const router = useRouter();
  const [done, setDone] = useState(acked);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/notices/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: noticeId }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? t.failed);
      return;
    }
    setDone(true);
    router.refresh();
  }

  if (done) {
    return (
      <span className="chip font-sans normal-case tracking-normal bg-[#E2F4F1] text-[#0C8175]">{t.confirmed} ✓</span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-xs text-red-600">{error}</span>}
      <button onClick={confirm} disabled={busy} className="btn-ghost h-8 px-3 text-sm">
        {busy ? t.confirming : t.acknowledge}
      </button>
    </span>
  );
}
