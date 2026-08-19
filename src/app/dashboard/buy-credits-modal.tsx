"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fmt } from "@/i18n/format";

// The credit-pack chooser — the founder-visible half of "make buying credits
// obvious" (2026-08-19). It replaces the <details><summary>Buy credits</summary>
// disclosure that used to hide the packs on the fair-use meter: a disclosure
// reads as a footnote, and the founder's complaint was precisely that nobody
// finds it. Now a real button sits on the card and this dialog does the
// choosing.
//
// WHY THIS IS A CLIENT COMPONENT AND WHY IT TAKES STRINGS AS PROPS.
// fair-use-meter.tsx is a Server Component and imports the dictionary;
// src/i18n/dictionaries.ts starts with `import "server-only"`, so importing it
// from a "use client" module is a build error ON PURPOSE (ten translation files
// must never reach the browser bundle). Everything this dialog says therefore
// arrives as the `t` prop — a flat, serialisable slice of dict.fairUse, not the
// dictionary itself.
//
// ═══ THE INVARIANT THIS FILE MOST EASILY BREAKS ═══
// BuyCreditsReturn (read its header) is what makes a purchased pack APPEAR
// without a hard reload: it attaches a NATIVE click listener to its own
// container <div> and arms only when the click landed inside `a[href]`; on the
// next focus/visibilitychange it calls router.refresh(), which re-runs the
// dashboard layout's claimLsPurchases(). That listener sees a click only if the
// clicked anchor is a DOM DESCENDANT of that container.
//
// So this dialog is rendered INLINE — no createPortal, not appended to
// document.body, no <dialog> element hoisted into the top layer. `position:
// fixed; inset: 0` takes the panel out of FLOW, which is all the overlay needs;
// it does not move the node in the DOM TREE. The meter renders
// <BuyCreditsReturn><BuyCreditsModal …/></BuyCreditsReturn>, so every pack
// anchor below is still a descendant of the armed container and a click on one
// still bubbles through it. A portal would silently break the arming — the
// buyer would pay and the balance would sit stale until they pressed F5, which
// is the exact failure BuyCreditsReturn exists to prevent. If this ever does
// need a portal, BuyCreditsReturn's listener has to move with it.
//
// SECOND CONSEQUENCE OF THE SAME INVARIANT: the pack anchors carry NO React
// onClick — in particular this dialog does NOT close itself when a pack is
// clicked. Two reasons, and the first is the load-bearing one:
//   1. the container's native listener is then the only thing observing the
//      click, so arming never depends on the ordering between a native listener
//      on this subtree and React's root-delegated synthetic handler;
//   2. checkout opens in a NEW tab, so the buyer comes back to this app tab
//      with the dialog still open — and because router.refresh() re-renders the
//      server tree, the `purchased` line below re-renders with the fresh
//      balance. The purchase confirms itself in place instead of vanishing.
// Escape, the backdrop and the Close button are the ways out.
//
// TOUCH: nothing here is hover-only. This codebase has already shipped controls
// that `opacity-0 group-hover:` deleted outright on touch devices; the hover
// styles on the pack rows are decoration over an already-visible bordered row.

/** One buyable pack. Deliberately a LOCAL shape, not an import of CreditPack:
 *  @/utils/credit-packs reaches the billing catalogue (env-resolved checkout
 *  URLs), which has no business being importable from a client module. */
export type ModalPack = {
  key: string;
  credits: number;
  priceUsd: number;
  kits: number;
  /** null = the Lemon Squeezy product does not exist yet. Filtered out below. */
  checkoutUrl: string | null;
};

/** The flat string slice this dialog needs — keys of dict.fairUse, by value. */
export type BuyCreditsCopy = {
  buyTitle: string;
  buyHint: string;
  buyNewTab: string;
  buyClose: string;
  packCredits: string;
  packPrice: string;
  packKitsOne: string;
  packKitsMany: string;
  packLabel: string;
  purchased: string;
};

/** This month's allowance, already composed by the server in the meter's own
 *  words — the label ("Generations") and the figure ("4 of 24"). NOT part of
 *  BuyCreditsCopy: that type is a verbatim slice of dict.fairUse, and mixing a
 *  computed sentence into it would make "these are catalogue strings" untrue. */
export type UsageLine = { label: string; value: string };

export default function BuyCreditsModal({
  packs,
  purchased,
  usage,
  t,
}: {
  packs: ModalPack[];
  /** Purchased-credit balance, for the "you already hold N" line. 0 hides it. */
  purchased: number;
  /** null on the pre-0059 two-pool DB shape, where no single figure exists. */
  usage: UsageLine | null;
  t: BuyCreditsCopy;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  // ALL THREE ways out go through close(), never through setOpen(false).
  // close() is the ONLY place focus is handed back to the trigger, and Escape
  // used to bypass it: the panel unmounted while it still held focus, the
  // browser reset activeElement to <body>, and the keyboard user's next Tab
  // restarted at the very top of the document — the app header, the hat
  // switcher and the whole book table before the meter came round again. The
  // bug was invisible to anyone testing with a mouse, because the backdrop and
  // the Close button were already routed correctly. Hence one exit path, not
  // three, and a comment that no longer promises what the code skips.
  //
  // useCallback so the identity is stable: the keydown effect names `close` as
  // a dependency (it is a real one), and a fresh function each render would
  // re-bind the listener on every state change for no reason.
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  // The page is NOT focus-trapped. aria-modal below tells assistive tech the
  // rest of the page is inert, but Tab can still walk out to the controls
  // behind the backdrop — the same trade junk-gate-dialog, generate-kit-button
  // and regenerate-button all make here. Stated plainly rather than implied,
  // because a half-built trap that leaks is worse than none, and because the
  // next reader should not have to discover the gap by testing for it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  // A button to nowhere must never render — purchasablePacks' rule, restated on
  // this side of the boundary so a future caller cannot forget to apply it.
  const buyable = packs.filter((p): p is ModalPack & { checkoutUrl: string } => !!p.checkoutUrl);
  if (!buyable.length) return null;

  const kitsLabel = (kits: number) =>
    kits === 1 ? fmt(t.packKitsOne, { n: kits }) : fmt(t.packKitsMany, { n: kits });

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        // min-height, not height: a fixed h-9 turns any label too wide for the
        // pill into two 20px lines inside a 36px box, painting outside its own
        // background. "Buy credits" is short in English and fits everywhere
        // measured — but the meter's other button proved the failure mode, and
        // a floor costs nothing.
        className="btn-primary min-h-[2.25rem] px-4 py-1.5 text-sm"
      >
        {t.buyTitle}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-[#14181F]/40" onClick={close} aria-hidden />
          {/* max-h + overflow, copied from feedback-questionnaire.tsx, which is
              this same shell built right. Without the pair the panel is a
              fixed-position box with no scroll container anywhere on the page:
              at 812×375 (a phone held sideways) the heading sits above the fold
              and half the Close button below it, and NOTHING can scroll to
              either — fixed children contribute nothing to the document's
              scrollable height, so the overflow is unreachable by any means.
              Text-resize to 200%, which WCAG 1.4.4 requires, puts the heading,
              the hint and Close all off-screen at once. dvh not vh: this
              codebase has already learned that the layout viewport is not the
              visible one on mobile. overscroll-contain so a drag inside the
              dialog does not scroll the page behind it. */}
          <div
            ref={panel}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={t.buyTitle}
            className="relative card w-full max-w-md p-6 space-y-3 max-h-[90dvh] overflow-y-auto overscroll-contain"
          >
            <h2 className="font-display text-base font-medium">{t.buyTitle}</h2>
            <p className="text-sm text-[#5B6470]">{t.buyHint}</p>
            {/* The number that decides WHICH pack. The backdrop dims the meter
                that was showing it, so without this line the buyer chooses
                between 6, 18 and 36 credits with the deciding figure hidden
                behind the overlay. Costs no new translatable string — it is the
                meter's own label and usage sentence, composed server-side — and
                it re-renders with the fresh balance on the buyer's return,
                exactly as the purchased line below does. */}
            {usage && (
              <p className="flex items-center justify-between gap-3 text-xs text-[#5B6470]">
                <bdi>{usage.label}</bdi>
                <bdi className="tabular">{usage.value}</bdi>
              </p>
            )}
            {purchased > 0 && (
              <p className="text-xs text-[#0C8175]">{fmt(t.purchased, { n: purchased })}</p>
            )}

            {/* One row per pack, each its own anchor to its own hosted checkout.
                The VISIBLE text is split into credits / kits / price so the three
                packs can be compared down a column; the accessible NAME stays the
                existing one-line packLabel, which is already translated in ten
                locales — so a screen reader hears one whole sentence rather than
                three fragments, and this redesign adds no translatable string it
                does not genuinely need. */}
            <div className="space-y-2">
              {buyable.map((p) => (
                <a
                  key={p.key}
                  href={p.checkoutUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={fmt(t.packLabel, {
                    credits: p.credits,
                    price: p.priceUsd,
                    kits: kitsLabel(p.kits),
                  })}
                  // The fill is PERMANENT, not a hover state. These rows are the
                  // only controls in the dialog, and on touch the hover tint
                  // never arrives — which would leave a 1px #E6E8E4 hairline
                  // (1.23:1 on white) as the sole signal that a row is
                  // tappable. A resting fill gives every row a visible extent
                  // no pointer is required to reveal; hover then deepens it.
                  className="flex items-center justify-between gap-3 rounded-lg border border-[#E6E8E4] bg-[#F5F6F3] px-4 py-3 transition-colors hover:border-[#0C8175] hover:bg-[#F1FBF9]"
                >
                  {/* <bdi> on every substituted run — the doctrine this repo
                      already writes down in utils/part-label.ts and applies in
                      lesson-card.tsx. "6 credits" is a digit (EN) followed by a
                      Latin word (L); dropped raw into a dir="rtl" paragraph the
                      bidi algorithm resolves the space between them to the
                      paragraph direction and the reader sees "credits 6", with
                      the count detached from its unit and thrown to the far
                      side of the row — worse than merely untranslated, because
                      the price sits at the opposite edge and the row becomes two
                      bare numbers at two ends. packCredits and packPrice ship
                      English-only this round (see PENDING_TRANSLATION), so this
                      is live today; <bdi> resolves direction from the first
                      strong character, so it is right both now and after the
                      Arabic and Jawi strings land. */}
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-[#14181F]">
                      <bdi>{fmt(t.packCredits, { credits: p.credits })}</bdi>
                    </span>
                    <span className="block text-xs text-[#5B6470]">
                      <bdi>{kitsLabel(p.kits)}</bdi>
                    </span>
                  </span>
                  <span className="tabular shrink-0 text-base font-medium text-[#0C8175]">
                    <bdi>{fmt(t.packPrice, { price: p.priceUsd })}</bdi>
                  </span>
                </a>
              ))}
            </div>

            {/* text-xs #5B6470 (6.0:1), not the 10px #98A0A9 hint token
                (2.65:1, under the 4.5:1 AA floor and nowhere near the
                large-text exception). #98A0A9 is the design system's colour for
                DECORATION — the resets date, the kit-free note — and this line
                is not decoration: it is the only place the buyer is told the
                tab will switch and that they must come back, which is the very
                behaviour BuyCreditsReturn depends on them performing.
                <bdi> for the same reason as the rows above: English prose
                inside a dir="rtl" dialog puts its own full stop at the wrong
                end of the sentence. */}
            <p className="text-xs text-[#5B6470]">
              <bdi>{t.buyNewTab}</bdi>
            </p>

            <div className="flex justify-end pt-1">
              <button type="button" onClick={close} className="btn-ghost h-9 px-3 text-sm">
                <bdi>{t.buyClose}</bdi>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
