"use client";

// SK in the corner (founder 2026-10-30: "get rid of this boxed approach for
// sk … just keep the avatar to the bottom right … the text box [hidden by
// default] … show the thought bubble on what the avatar is saying"). The
// PRESENTATIONAL pieces the Shell (sk-shell.tsx) wires:
//
//   SkAvatar      — the round portrait (cropped to the face), ~64 px (56 px on
//                   a phone). A soft ring pulses while SK speaks (opacity only;
//                   still under prefers-reduced-motion) and a small red dot
//                   says the mic is listening. A click opens the menu.
//   SkBubble      — the speech bubble beside the avatar, opening toward the
//                   page, max ~320 px (the viewport minus 88 px on a phone),
//                   four lines then scrollable, with a tail pointing at the
//                   avatar. It fades out (opacity) rather than jumping away.
//   SkCornerMenu  — the avatar's compact popover menu: a real ARIA menu
//                   (arrow keys, Home / End, Escape, Tab closes), with toggles
//                   as menuitemcheckbox and a one-of-N choice (SK's
//                   character) as a group of menuitemradio.
//
// No state of their own beyond focus: every decision is the Shell's.

import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import Image from "next/image";

/** Which corner: "end" (bottom-right in LTR) or "start" (the Board's). */
export type CornerSide = "end" | "start";

export function SkAvatar({
  look,
  speaking,
  listening,
  label,
  expanded,
  onClick,
  buttonRef,
}: {
  look: "A" | "B";
  speaking: boolean;
  listening: boolean;
  label: string;
  expanded: boolean;
  onClick: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={expanded}
      data-sk="avatar"
      data-sk-look={look}
      data-sk-speaking={speaking ? "true" : "false"}
      data-tour="sk-launcher"
      className="pointer-events-auto relative h-28 sm:h-36 shrink-0 rounded-xl focus:outline-none focus-visible:ring-4 focus-visible:ring-[#0C8175]/40"
    >
      {/* The FULL figure (founder 2026-10-30: "keep the full size avatar
          instead of just the head"), standing in the corner — the rig's layers
          flattened and trimmed by scripts/sk-portraits.mjs. Speaking: a soft
          teal glow around the figure that pulses (opacity only; still under
          reduced motion). */}
      <span
        aria-hidden
        data-sk="speaking-ring"
        className={`pointer-events-none absolute inset-x-1 bottom-0 top-2 rounded-[45%] bg-[#0C8175]/20 blur-xl transition-opacity duration-300 motion-reduce:transition-none ${speaking ? "opacity-100 motion-safe:animate-pulse" : "opacity-0"}`}
      />
      <Image
        src={look === "A" ? "/sk/portrait/sk-a-full.webp" : "/sk/portrait/sk-b-full.webp"}
        alt=""
        width={look === "A" ? 333 : 317}
        height={480}
        unoptimized
        priority
        className="relative h-full w-auto object-contain object-bottom drop-shadow-lg"
      />
      {listening && <span aria-hidden data-sk="listening-dot" className="absolute top-1 end-1 h-3.5 w-3.5 rounded-full bg-[#B42318] ring-2 ring-white" />}
    </button>
  );
}

export function SkBubble({
  open,
  side,
  kind,
  onHold,
  onClose,
  closeLabel,
  children,
  wide,
}: {
  open: boolean;
  side: CornerSide;
  kind: string;
  /** Hover / focus on the bubble holds it open (true), leaving lets it fade. */
  onHold: (on: boolean) => void;
  /** × — omitted while a tour pins the bubble (the tour has Skip). */
  onClose?: () => void;
  closeLabel: string;
  children: ReactNode;
  /** The tour's controls need a little more room (still within the phone limit). */
  wide?: boolean;
}) {
  // A THOUGHT bubble (founder: "show the thought bubble here on what the
  // avatar is saying"): two small trailing circles toward the avatar's head,
  // on the avatar's side (logical start/end, so RTL mirrors it).
  const near = side === "end" ? "-end-3" : "-start-3";
  const far = side === "end" ? "-end-[22px]" : "-start-[22px]";
  return (
    <div
      data-sk="bubble"
      data-sk-kind={kind}
      data-sk-open={open ? "true" : "false"}
      aria-hidden={!open}
      // Fading or faded: out of the tab order and the accessibility tree.
      inert={!open}
      onMouseEnter={() => onHold(true)}
      onMouseLeave={() => onHold(false)}
      onFocus={() => onHold(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onHold(false);
      }}
      className={`relative mb-2 rounded-2xl border border-[#E6E8E4] bg-white px-3 py-2 text-sm text-slate-900 shadow-lg [color-scheme:light] transition-opacity duration-300 motion-reduce:transition-none ${
        wide ? "w-[min(340px,calc(100vw-88px))]" : "w-max max-w-[min(320px,calc(100vw-88px))]"
      } ${open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
    >
      <span aria-hidden data-sk="bubble-tail" className={`absolute top-5 ${near} h-3 w-3 rounded-full border border-[#E6E8E4] bg-white shadow-sm`} />
      <span aria-hidden className={`absolute top-9 ${far} h-2 w-2 rounded-full border border-[#E6E8E4] bg-white shadow-sm`} />
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          title={closeLabel}
          data-sk="bubble-close"
          className="float-end -me-1 -mt-0.5 ms-2 h-5 w-5 rounded-full text-base leading-none text-slate-400 hover:text-slate-700"
        >
          ×
        </button>
      )}
      {children}
    </div>
  );
}

/** One option of a "choice" row: a small round thumbnail and its label. */
export type CornerMenuOption = { value: string; label: string; image?: string };

export type CornerMenuItem =
  | { kind: "action"; id: string; label: string; onSelect: () => void; disabled?: boolean; icon?: string }
  | { kind: "toggle"; id: string; label: string; checked: boolean; onSelect: () => void; disabled?: boolean; icon?: string }
  /** A one-of-N choice (SK's character): a labelled group of menuitemradio;
   *  each option is its own stop for the arrow keys. Picking one keeps the
   *  menu open, like the toggles. */
  | { kind: "choice"; id: string; label: string; options: CornerMenuOption[]; value: string; onSelect: (value: string) => void; disabled?: boolean; icon?: string };

/** The avatar's menu. Focus moves into it on open; Escape (or Tab, or a click
 *  outside) closes it and the Shell hands focus back to the avatar. */
export function SkCornerMenu({ label, items, onClose, side }: { label: string; items: CornerMenuItem[]; onClose: (refocus: boolean) => void; side: CornerSide }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])');
    first?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (ref.current && t && !ref.current.contains(t) && !(t instanceof Element && t.closest('[data-sk="avatar"]'))) onClose(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? []);
    const at = all.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => all[(i + all.length) % all.length]?.focus();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      go(at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      go(at - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      go(0);
    } else if (e.key === "End") {
      e.preventDefault();
      go(all.length - 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose(true);
    } else if (e.key === "Tab") {
      onClose(false);
    }
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      data-sk="menu"
      onKeyDown={onKey}
      className={`pointer-events-auto absolute bottom-full mb-2 w-56 rounded-xl border border-[#E6E8E4] bg-white py-1 text-sm text-slate-900 shadow-xl [color-scheme:light] ${side === "end" ? "end-0" : "start-0"}`}
    >
      {items.map((it) =>
        it.kind === "choice" ? (
          <div key={it.id} role="group" aria-labelledby={`sk-menu-${it.id}`} data-sk="menu-choice" data-sk-item={it.id} className="border-y border-[#EEF0EC] py-1 my-1">
            <div id={`sk-menu-${it.id}`} className="flex items-center gap-2 px-3 pt-1 pb-0.5 text-xs font-medium text-slate-500">
              {it.icon && (
                <span aria-hidden className="w-4 shrink-0 text-center">
                  {it.icon}
                </span>
              )}
              <span className="truncate">{it.label}</span>
            </div>
            {it.options.map((o) => {
              const on = o.value === it.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  disabled={it.disabled}
                  onClick={() => it.onSelect(o.value)}
                  data-sk="menu-item"
                  data-sk-item={`${it.id}-${o.value}`}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-start hover:bg-[#F4F6F3] focus:bg-[#F4F6F3] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {o.image && (
                    <Image
                      src={o.image}
                      alt=""
                      width={28}
                      height={28}
                      unoptimized
                      className={`h-7 w-7 shrink-0 rounded-full object-cover ring-2 ${on ? "ring-[#0C8175]" : "ring-transparent"}`}
                    />
                  )}
                  <span className={`min-w-0 flex-1 truncate ${on ? "font-medium" : ""}`}>{o.label}</span>
                  <span aria-hidden className={`w-4 shrink-0 text-center text-[#0C8175] ${on ? "" : "invisible"}`}>
                    ✓
                  </span>
                </button>
              );
            })}
          </div>
        ) : it.kind === "toggle" ? (
          <button
            key={it.id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={it.checked}
            disabled={it.disabled}
            onClick={it.onSelect}
            data-sk="menu-item"
            data-sk-item={it.id}
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-start hover:bg-[#F4F6F3] focus:bg-[#F4F6F3] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span className="flex min-w-0 items-center gap-2">
              {it.icon && (
                <span aria-hidden className="w-4 shrink-0 text-center">
                  {it.icon}
                </span>
              )}
              <span className="truncate">{it.label}</span>
            </span>
            <span aria-hidden className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${it.checked ? "border-[#0C8175] bg-[#0C8175]" : "border-slate-300 bg-slate-200"}`}>
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${it.checked ? "translate-x-4 rtl:-translate-x-4" : "translate-x-0.5 rtl:-translate-x-0.5"}`} />
            </span>
          </button>
        ) : (
          <button
            key={it.id}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={it.onSelect}
            data-sk="menu-item"
            data-sk-item={it.id}
            className="flex w-full items-center gap-2 px-3 py-2 text-start hover:bg-[#F4F6F3] focus:bg-[#F4F6F3] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
          >
            {it.icon && (
              <span aria-hidden className="w-4 shrink-0 text-center">
                {it.icon}
              </span>
            )}
            <span className="truncate">{it.label}</span>
          </button>
        ),
      )}
    </div>
  );
}
