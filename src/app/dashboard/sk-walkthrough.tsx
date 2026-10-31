"use client";

// SK's first-login walkthrough — the browser half (founder 2026-10-30). The
// rules live in the pure engine (src/sk/shell/client/walkthrough.ts) and the
// stops in src/sk/walkthrough/stops.ts; this file is the wiring the SK
// launcher (sk-launcher.tsx) mounts:
//
//   useSkWalkthrough() — starts a run at once (2026-10-31: "Starting the
//     tour…" in the bubble, stop 1's page opened while the facts load from GET
//     /api/sk/walkthrough; the page she is on is waited for only when stop 1
//     is on it, ≤ 2 s — walkthrough.ts createWalkStarter), prefetches every page of
//     the plan, and plays the stops STRICTLY in sequence (2026-10-30 fix):
//     navigate (router.push, never a full reload) → wait for the page to
//     SETTLE and the anchor to be visible and still (a stop is skipped, with
//     a debug line, only once the page settled without it; cap ~20 s) →
//     scroll it into view → highlight → the caption and the WHOLE line → then
//     the next stop by itself (1 s after the voice finished; reading time
//     without sound; never after a line that was cut off, never while paused
//     or while she types). It keeps the position in sessionStorage so the
//     separate launchers on /present and /sk carry on, pauses when she asks a
//     question or leaves the stop's page, and records completed / skipped in
//     user_tour_progress ONLY for the first-login run.
//   WalkStrip     — the tour INSIDE SK's speech bubble (founder 2026-10-30:
//     the corner avatar replaced the hero card and the docked bar): the
//     caption (or SK's answer to a question asked mid-tour), "Tap for sound"
//     as a chip, compact Pause / Back / Next / Skip and "n of N"; above them,
//     when the stop has them, the sample-question chips (never sent: a tap
//     only fills a text box) and the static Example card.
//   WalkExampleCard — the static demo of an action card. Client-only: no
//     token, no /api/sk/act, Confirm disabled and labelled "Example".
//   WalkSpotlight — a dimmed backdrop with a cut-out ring round the anchor;
//     pointer-events none, so the page stays usable.
//
// A combined stop (stops.ts `parts`, founder 2026-10-30: "combine steps 3 to
// 6 into 1 narration") says ONE tight line (2026-10-31: 1-3 sentences, fewer
// than its parts): its precomposed line, or its found parts' clauses composed.
// The highlight starts on the first part's control and MOVES to each next
// part's control at that part's `{marker}` inside the line: the Shell reports
// each sentence's start (`onSentence`) and, once its audio plays, its known
// length (`onSentencePlay`, from the voice's word marks); the marker's place in
// the sentence is timed by that length, else by its characters at SK's
// speaking rate as measured on the tour's earlier sentences. Without sound,
// each part gets its share of the reading time.
//
// Every stop also reports how it went to SK's voice log (POST
// /api/sk/voice-log → one function-log line per batch; voice-log.ts
// tourEvent): shown and how long its page took, or skipped and why — the
// console debug line alone never reached us ("the tour skipped the readymade
// kits section").
//
// A stop's caption shows with its highlight, once its page has settled; the
// voice waits for her first tap or key (the browser's autoplay rule) and then
// speaks through the Shell's own speech coordinator (sk-shell.tsx,
// `walk.voice`), so the Google, Polly or browser voice applies unchanged; the
// Shell reports back how each line ended (`onVoiceDone`), which is what lets
// the tour move on. No model call, no write.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import type { Dictionary } from "@/i18n/dictionaries";
import { fmt } from "@/i18n/format";
import { SK_INTRO_TOUR } from "@/sk/shell/tour";
import {
  backStop,
  createWalkStarter,
  createWalkStore,
  currentStop,
  findAnchor,
  findParts,
  isActive,
  jumpTo,
  missingStop,
  nextStop,
  cueDelay,
  cueReadingTimes,
  nextSpeakRate,
  partCues,
  partDueAt,
  partsLine,
  SPEAK_MS_PER_CHAR,
  pauseWalk,
  resumeWalk,
  routePath,
  skipWalk,
  startWalk,
  advanceDelay,
  atRoute,
  readingMs,
  SETTLE_CAP_MS,
  waitForSettledAnchor,
  waitForSettledPage,
  waitForStableRect,
  walkCommand,
  stripMarks,
  type LineOutcome,
  type PartCue,
  type PartHit,
  type PlannedStop,
  type SettleProbe,
  type WalkRect,
  type WalkState,
  type WalkStarter,
  type WalkStore,
} from "@/sk/shell/client/walkthrough";
import { splitSentences } from "@/sk/shell/client/speech";
import { beaconVoiceEvents, createVoiceLog, skipOutcome, tourEvent, tourPageState, walkEvent, type TourOutcome, type VoiceLog, type WalkVia } from "@/sk/shell/client/voice-log";
import type { SkTurnWalk, SkWalkAction } from "@/sk/shell/types";
import { CLICK_ONLY_DEMOS, walkRoleFor, type WalkDemo, type WalkFacts, type WalkRole } from "@/sk/walkthrough/stops";

export type WalkCopy = Dictionary["sk"]["walkthrough"];

/** A line for the Shell's voice: a new key speaks `text` ("" = be quiet). */
export type WalkVoice = { key: string; text: string } | null;

/** A start that began no run by now (facts ≤ 8 s + settle ≤ 2 s) is asked once more. */
const START_RETRY_MS = 12_000;

const SOUND_KEY = "sk.walkthrough.sound";

function uid(): string {
  const c = typeof crypto !== "undefined" ? (crypto as { randomUUID?: () => string }) : undefined;
  return c?.randomUUID ? c.randomUUID() : `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function debug(msg: string) {
  // The script: a stop whose anchor never appears is skipped SILENTLY, with a debug note.
  if (typeof console !== "undefined") console.debug(`[sk-walk] ${msg}`);
}

/** The seen row for the first-login run (same pair the v1 intro posted). */
export function postWalkSeen(status: "completed" | "skipped") {
  try {
    const body = JSON.stringify({ tourKey: SK_INTRO_TOUR.key, version: SK_INTRO_TOUR.version, status });
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon("/api/tour/seen", new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch("/api/tour/seen", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true });
  } catch {
    /* best-effort: the worst case is the tour offers itself once more */
  }
}

/** The words of a line key for a role ("" when the dictionary lacks it). */
export function walkLine(copy: WalkCopy, role: WalkRole, key: string): string {
  const table = copy[role] as Record<string, string> | undefined;
  return table?.[key] ?? "";
}

/** "Label: value" rows of an Example card (split on the FIRST ": "). */
export function exampleRows(rows: string): Array<[string, string]> {
  return rows
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const i = r.indexOf(": ");
      return i > 0 ? [r.slice(0, i).trim(), r.slice(i + 2).trim()] : ["", r];
    });
}

// ── the static Example card ─────────────────────────────────────────────────

/** A demo of an action card. Purely presentational: no handler, no request,
 *  no token. The Confirm button is disabled and says "Example". */
export function WalkExampleCard({ demo, copy }: { demo: WalkDemo; copy: WalkCopy }) {
  const d = copy.demo[demo];
  const clickOnly = CLICK_ONLY_DEMOS.has(demo);
  return (
    <div className="rounded-xl border border-dashed border-[#F3D9A4] bg-[#FFF9EC] px-3 py-2.5 text-sm" data-sk="walk-example" data-sk-demo={demo} role="group" aria-label={`${copy.ui.example}: ${d.title}`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-medium text-[#14181F]">{d.title}</div>
        <span className="shrink-0 rounded-full bg-white px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#8A5A00]">{copy.ui.example}</span>
      </div>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {exampleRows(d.rows).map(([k, v], i) => (
          <Fragment key={i}>
            <dt className="text-[#98A0A9]">{k}</dt>
            <dd className="text-[#14181F] break-words">{v}</dd>
          </Fragment>
        ))}
      </dl>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" disabled aria-disabled="true" className="btn-primary h-7 px-3 text-xs opacity-50 cursor-not-allowed" data-sk="walk-example-confirm">
          {copy.ui.example}
        </button>
        {clickOnly && (
          <span className="text-[10px] text-[#8A5A00]" data-sk="walk-example-click-only">
            {copy.ui.needsClick}
          </span>
        )}
        <span className="text-[10px] text-[#5B6470] ms-auto">{copy.ui.exampleNote}</span>
      </div>
    </div>
  );
}

// ── the strip (inside the speech bubble) ───────────────────────────────────

export type WalkStripProps = {
  copy: WalkCopy;
  walk: WalkState;
  line: string;
  /** SK's reply to a question she asked mid-tour: shown instead of the stop's caption. */
  answer?: string | null;
  soundOn: boolean;
  onSound: () => void;
  onPause: () => void;
  onResume: () => void;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  onChip: (text: string) => void;
};

export function WalkStrip(p: WalkStripProps) {
  const { copy, walk } = p;
  const ui = copy.ui;
  const stop: PlannedStop | null = currentStop(walk);
  if (!stop) return null;
  const total = walk.stops.length;
  const n = walk.index + 1;
  const last = walk.index >= total - 1;
  const paused = walk.status === "paused";
  const btn = "h-7 px-2 rounded-md border border-[#E6E8E4] text-[11px] font-medium text-[#14181F] bg-white hover:bg-[#F4F6F3] disabled:opacity-40 disabled:cursor-not-allowed";
  return (
    <div className="space-y-2 text-start" data-sk="walk" data-sk-walk-mode="bubble" data-sk-walk-stop={stop.id} data-sk-walk-status={walk.status}>
      {/* Above the caption (the bubble grows upward from the avatar): the
          stop's Example card and sample chips. */}
      {stop.demo && <WalkExampleCard demo={stop.demo} copy={copy} />}
      {stop.chips?.length ? (
        <div className="flex flex-wrap items-center gap-1.5" data-sk="walk-chips" title={ui.chipHint}>
          <span className="text-[10px] text-slate-500">{ui.tryAsking}:</span>
          {stop.chips.map((c) => (
            <button key={c} type="button" onClick={() => p.onChip(copy.chips[c])} className="rounded-full border border-[#E3DAF3] bg-[#F8F5FD] px-2 py-0.5 text-[11px] text-[#4A3B78]" data-sk="walk-chip" data-sk-chip={c}>
              {copy.chips[c]}
            </button>
          ))}
        </div>
      ) : null}

      <p className="max-h-20 overflow-y-auto text-sm leading-5 text-slate-800 whitespace-pre-wrap" data-sk="caption" data-sk-answer={p.answer ? "true" : undefined} aria-live="polite">
        {p.answer || p.line}
      </p>

      {!p.soundOn && (
        <button type="button" onClick={p.onSound} className="inline-flex items-center gap-1 rounded-full border border-[#CFE9E4] bg-[#F1FBF9] px-2.5 py-0.5 text-[11px] font-medium text-[#0C8175]" data-sk="walk-sound">
          <span aria-hidden>🔊</span> {ui.tapForSound}
        </button>
      )}

      {paused && walk.pausedBy !== "user" && (
        <button type="button" onClick={p.onResume} className="btn-primary h-7 px-3 text-xs text-white" data-sk="walk-continue">
          {ui.continueTour}
        </button>
      )}

      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={ui.controls} data-sk="walk-controls">
        {paused ? (
          <button type="button" onClick={p.onResume} className={btn} data-sk="walk-resume" title={ui.resume}>
            ▶ {ui.resume}
          </button>
        ) : (
          <button type="button" onClick={p.onPause} className={btn} data-sk="walk-pause" title={ui.pause}>
            ❚❚ {ui.pause}
          </button>
        )}
        <button type="button" onClick={p.onBack} disabled={walk.index === 0} className={btn} data-sk="walk-back" aria-label={ui.back} title={ui.back}>
          <span aria-hidden className="inline-block rtl:rotate-180">‹</span>
        </button>
        <button type="button" onClick={p.onNext} className={`${btn} border-[#0C8175] text-[#0C8175]`} data-sk="walk-next">
          {last ? ui.finish : ui.next} <span aria-hidden className="inline-block rtl:rotate-180">›</span>
        </button>
        <button type="button" onClick={p.onSkip} className="h-7 px-1.5 text-[11px] font-medium text-[#5B6470] underline" data-sk="walk-skip">
          {ui.skip}
        </button>
        <span className="ms-auto text-[11px] text-slate-500 tabular-nums" data-sk="walk-progress">
          {fmt(ui.progress, { n, total })}
        </span>
      </div>
    </div>
  );
}

/** The bubble the moment a start is asked for (no run yet): "Starting the
 *  tour…", and Skip, which gives the start up. */
export function WalkStarting({ copy, onSkip }: { copy: WalkCopy; onSkip: () => void }) {
  return (
    <div className="space-y-2 text-start" data-sk="walk" data-sk-walk-status="starting">
      <p className="text-sm leading-5 text-slate-800" data-sk="caption" aria-live="polite">
        {copy.ui.starting}
      </p>
      <button type="button" onClick={onSkip} className="h-7 px-1.5 text-[11px] font-medium text-[#5B6470] underline" data-sk="walk-skip">
        {copy.ui.skip}
      </button>
    </div>
  );
}

// ── the spotlight ───────────────────────────────────────────────────────────

/** A dim with a cut-out ring round `el`, following it on scroll and resize.
 *  pointer-events none: the page under it stays usable. */
export function WalkSpotlight({ el }: { el: Element }) {
  const [box, setBox] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!el.isConnected) return setBox(null);
        const r = el.getBoundingClientRect();
        const pad = 6;
        setBox({ top: r.top - pad, left: r.left - pad, width: r.width + pad * 2, height: r.height + pad * 2 });
      });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [el]);
  if (!box || typeof document === "undefined") return null;
  return createPortal(
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[46]" data-sk="walk-spotlight">
      <div
        className="absolute rounded-xl ring-2 ring-[#0C8175] motion-safe:transition-all motion-safe:duration-200"
        style={{ top: box.top, left: box.left, width: box.width, height: box.height, boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.28)" }}
      />
    </div>,
    document.body,
  );
}

/// ── the page probe (browser) ────────────────────────────────────────────────

/** SK's own UI: its changes and its listening pulse are not the page loading. */
const SK_UI = '[data-sk="launcher"], [data-sk="shell"], [data-sk="walk-spotlight"]';
/** Loading UI: aria-busy (the navigation veil sets it on <body>, loading.tsx's
 *  ring carries it), [data-loading], [data-sk-loading] (the route loading.tsx
 *  fallbacks) and skeletons (.animate-pulse — a tiny pulsing dot is not one). */
const LOADING_SEL = '[aria-busy="true"], [data-loading]:not([data-loading="false"]), [data-sk-loading], .animate-pulse';

/** Which loading UI is on screen ("aria-busy", "data-loading",
 *  "data-sk-loading", "animate-pulse"), or null — named for the tour log. */
function loadingSignal(): string | null {
  for (const el of Array.from(document.querySelectorAll(LOADING_SEL))) {
    if (el.closest(SK_UI) || el.getClientRects().length === 0) continue;
    if (el.classList.contains("animate-pulse")) {
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 8) continue;
      return "animate-pulse";
    }
    if (el.getAttribute("aria-busy") === "true") return "aria-busy";
    if (el.hasAttribute("data-sk-loading")) return "data-sk-loading";
    return "data-loading";
  }
  return null;
}

const loadingVisible = (): boolean => loadingSignal() !== null;

function rectOf(el: Element): WalkRect | null {
  if (!el.isConnected) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/** DOM changes outside SK's own UI. */
function observePage(onChange: () => void): () => void {
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      const t = r.target instanceof Element ? r.target : r.target.parentElement;
      if (t?.closest(SK_UI)) continue;
      onChange();
      return;
    }
  });
  mo.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open", "aria-busy", "data-loading", "data-sk-loading"] });
  return () => mo.disconnect();
}

/** On `path` (null = wherever we are), loaded, no loading UI visible. */
function settleProbe(path: string | null): SettleProbe {
  return {
    pathOk: () => path === null || window.location.pathname === path,
    ready: () => document.readyState === "complete",
    loading: loadingVisible,
  };
}

// ── the hook ────────────────────────────────────────────────────────────────

export type SkWalkthrough = {
  /** A run is on (running or paused). */
  active: boolean;
  /** A start is under way (no run yet): the bubble says "Starting the tour…". */
  starting: boolean;
  walk: WalkState | null;
  /** The tour inside the speech bubble (null when no run); `answer` = SK's
   *  reply to a question asked mid-tour, shown instead of the caption. */
  strip: (answer?: string | null) => ReactNode;
  spotlight: ReactNode;
  voice: WalkVoice;
  /** A chip was tapped: the Shell puts this in its text box (never sends it). */
  fill: WalkVoice;
  /** Paused by her question: the bubble shows SK's answer and "Continue the tour". */
  showAnswers: boolean;
  /** A tour command typed or said; true = handled (no turn). */
  command: (text: string) => boolean;
  /** She asked SK something: the tour pauses and SK answers normally. */
  onQuestion: () => void;
  /** Start from stop 1. `record` only for the first-login run. */
  /** `via`: who asked (the voice log's "walk" events). */
  start: (opts?: { record?: boolean; via?: WalkVia }) => void;
  /** The Shell reports how a `voice` line ended: the tour moves on by itself
   *  only after it was FULLY spoken. */
  onVoiceDone: (key: string, outcome: LineOutcome) => void;
  /** The Shell starts sentence `index` (0-based) of the `voice` line `key`: a
   *  combined stop times its highlight moves inside that sentence. */
  onSentence: (key: string, index: number) => void;
  /** Sentence `index` of line `key` starts PLAYING, `ms` long when the voice
   *  knows (word marks), else null: the in-sentence moves are re-timed. */
  onSentencePlay: (key: string, index: number, ms: number | null) => void;
  /** A tour action the server decided (natural phrasing it caught). */
  act: (action: SkWalkAction) => void;
  /** She is typing: no auto-advance under her. */
  hold: () => void;
  /** Where the tour is, for the turn request (null when no run). */
  state: SkTurnWalk | null;
  /** The browser refused SK's voice (autoplay): show "Tap for sound" again. */
  soundBlocked: () => void;
};

/** What the current stop shows: its control (the spotlight's), and for a
 *  combined stop every part's control and line key, the part highlighted now,
 *  its words (markers stripped), where each part starts in them, and (no
 *  sound) the ms each one starts at. */
type WalkMatch = {
  el: Element | null;
  line?: string;
  key: string;
  parts?: Array<{ el: Element; id: string; line: string }>;
  part?: number;
  text?: string;
  cues?: PartCue[];
  times?: number[];
};

/** The stop key: one run, one position, one plan (a missing stop changes it). */
const goKeyOf = (w: WalkState | null): string | null => {
  const s = w && w.status === "running" ? currentStop(w) : null;
  return w && s ? `${w.runId}:${w.index}:${w.stops.length}:${s.id}` : null;
};

export function useSkWalkthrough({
  role,
  hat,
  copy,
  introPending,
  onIntroDone,
}: {
  role: string | null;
  hat: string | null;
  copy: WalkCopy | null | undefined;
  /** Server-decided: this user has not seen the current SK_INTRO_TOUR version. */
  introPending: boolean;
  onIntroDone?: () => void;
}): SkWalkthrough {
  const router = useRouter();
  const pathname = usePathname();
  const [walk, setWalk] = useState<WalkState | null>(null);
  const [match, setMatch] = useState<WalkMatch | null>(null);
  const [soundOn, setSoundOn] = useState(false);
  const [voice, setVoice] = useState<WalkVoice>(null);
  const [fill, setFill] = useState<WalkVoice>(null);
  /** The pending auto-advance: after `ms`, if the tour is still on THAT entry of THAT stop. */
  const [advance, setAdvance] = useState<{ goKey: string; entry: number; ms: number } | null>(null);
  const storeRef = useRef<WalkStore | null>(null);
  const walkRef = useRef<WalkState | null>(null);
  const matchRef = useRef(match);
  const soundRef = useRef(false);
  const navigatingRef = useRef(false);
  const startingRef = useRef(false);
  const endedRef = useRef(new Set<string>());
  const introRef = useRef(introPending);
  const onIntroDoneRef = useRef(onIntroDone);
  /** Bumped each time a stop is (re)entered: an advance or a voice from an
   *  earlier visit to the same stop never moves this one. */
  const entryRef = useRef(0);
  /** The line being voiced now, and for which stop entry. */
  const spokenRef = useRef<{ key: string; goKey: string; entry: number; text: string } | null>(null);
  /** The entry she held (typing): it does not move on by itself. */
  const heldRef = useRef(-1);
  /** When the current stop was highlighted (for the "away" event). */
  const shownAtRef = useRef<{ goKey: string; at: number } | null>(null);
  /** The tour's own voice-log instance (the Shell's may not be mounted). */
  const logRef = useRef<VoiceLog | null>(null);
  useEffect(() => {
    const log = createVoiceLog({ send: beaconVoiceEvents });
    logRef.current = log;
    const onPageHide = () => log.flush();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      log.dispose();
      if (logRef.current === log) logRef.current = null;
    };
  }, []);
  /** One "tour" event to the function log (no text). */
  const logStop = useCallback((stop: string, route: string, outcome: TourOutcome, ms: number, page: string) => {
    logRef.current?.push(tourEvent({ stop, route, outcome, ms, page }));
  }, []);
  useEffect(() => {
    walkRef.current = walk;
    matchRef.current = match;
    soundRef.current = soundOn;
    introRef.current = introPending;
    onIntroDoneRef.current = onIntroDone;
  });

  const lineOf = useCallback((w: WalkState | null, m: { line?: string; text?: string; parts?: Array<{ id: string; line: string }> } | null): string => {
    const stop = w ? currentStop(w) : null;
    if (!stop || !copy) return "";
    // A combined stop: its ONE line, markers stripped.
    if (m?.parts?.length) return m.text ?? stripMarks(partsLine(stop, m.parts, (k) => walkLine(copy, w!.role, k), copy.ui.partJoin));
    return walkLine(copy, w!.role, m?.line ?? stop.line) || walkLine(copy, w!.role, stop.line);
  }, [copy]);
  // The stop effect reads the words through a ref: a new `copy` object (a
  // layout re-render) must not re-run it, which restarted the line mid-word.
  const lineOfRef = useRef(lineOf);
  useEffect(() => {
    lineOfRef.current = lineOf;
  }, [lineOf]);
  /** A combined stop's marked line for the parts found (stops.ts `parts`). */
  const marked = useCallback(
    (w: WalkState, stop: PlannedStop, parts: Array<{ id: string; line: string }>) =>
      copy ? partsLine(stop, parts, (k) => walkLine(copy, w.role, k), copy.ui.partJoin) : "",
    [copy],
  );
  const markedRef = useRef(marked);
  useEffect(() => {
    markedRef.current = marked;
  }, [marked]);

  // ── a combined stop's highlight, part by part ──
  /** The reading-time clock moving a combined stop's highlight (no sound). */
  const partTimersRef = useRef<number[]>([]);
  const clearPartClock = useCallback(() => {
    for (const t of partTimersRef.current) window.clearTimeout(t);
    partTimersRef.current = [];
  }, []);
  useEffect(() => clearPartClock, [clearPartClock]);

  /** Move the highlight to part `k` of the combined stop `gk` (scrolled into
   *  view only when it is off screen). */
  const showPart = useCallback((gk: string, k: number) => {
    const m = matchRef.current;
    const p = m?.parts?.[k];
    if (!m || !p || m.key !== gk || m.part === k) return;
    matchRef.current = { ...m, el: p.el, part: k };
    try {
      const r = p.el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) {
        const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        p.el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
      }
    } catch {
      /* old browsers */
    }
    setMatch((cur) => (cur && cur.key === gk && cur.parts ? { ...cur, el: p.el, part: k } : cur));
  }, []);

  /** Without sound: each part's highlight at its share of the reading time. */
  const startPartClock = useCallback(
    (gk: string) => {
      clearPartClock();
      const times = matchRef.current?.key === gk ? matchRef.current.times : undefined;
      if (!times) return;
      times.forEach((ms, k) => {
        if (k === 0) return;
        partTimersRef.current.push(
          window.setTimeout(() => {
            if (goKeyOf(walkRef.current) === gk) showPart(gk, k);
          }, ms),
        );
      });
    },
    [clearPartClock, showPart],
  );

  const quiet = useCallback(() => {
    spokenRef.current = null;
    clearPartClock();
    setVoice({ key: uid(), text: "" });
  }, [clearPartClock]);

  /** Say this stop's line now; the tour moves on once it has been spoken. A
   *  combined stop's highlight then follows the voice, sentence by sentence. */
  const speakStop = useCallback((goKey: string, entry: number, text: string) => {
    const key = uid();
    spokenRef.current = { key, goKey, entry, text };
    clearPartClock();
    setAdvance(null);
    setVoice({ key, text });
  }, [clearPartClock]);

  // Restore a run this tab already has (page move, or another layout's launcher).
  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = window.sessionStorage;
    } catch {
      storage = null;
    }
    storeRef.current = createWalkStore(storage);
    const t = window.setTimeout(() => {
      const saved = storeRef.current?.load() ?? null;
      if (saved) setWalk(saved);
      let wanted = false;
      try {
        wanted = storage?.getItem(SOUND_KEY) === "on";
      } catch {
        wanted = false;
      }
      const ua = (navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } }).userActivation;
      if (saved && wanted && ua?.hasBeenActive) setSoundOn(true);
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  // Persist every change; an ended run is recorded (first-login only) and
  // dropped from sessionStorage.
  useEffect(() => {
    if (!walk) return;
    storeRef.current?.save(walk);
    if (walk.status === "done" || walk.status === "skipped") {
      if (walk.record && !endedRef.current.has(walk.runId)) {
        endedRef.current.add(walk.runId);
        postWalkSeen(walk.status === "done" ? "completed" : "skipped");
        onIntroDoneRef.current?.();
      }
      // An ended run renders as nothing (isActive is false): the strip, the
      // bubble's tour and the spotlight go, and the Shell silences the tour's voice.
    }
  }, [walk]);

  // Warm EVERY page of the planned tour once per run (not just the next
  // stop's), so each hop lands on a render already under way.
  const runId = walk?.runId ?? null;
  useEffect(() => {
    const w = walkRef.current;
    if (!runId || !w || !isActive(w)) return;
    const here = window.location.pathname + window.location.search;
    for (const route of new Set(w.stops.map((s) => s.route))) {
      if (route === here) continue;
      try {
        router.prefetch(route);
      } catch {
        /* a hint only */
      }
    }
  }, [runId, router]);

  // ── the start (2026-10-31: "SK show me around still didn't start the
  // tour"): the bubble says "Starting the tour…" at once, stop 1's page opens
  // at once while the facts load, and the page she is on is waited for only
  // when stop 1 is on it (≤ 2 s). One start at a time (walkthrough.ts
  // createWalkStarter): a second "Take the tour" while starting joins it.
  const [starting, setStarting] = useState(false);
  const roleRef = useRef({ role, hat });
  useEffect(() => {
    roleRef.current = { role, hat };
  });
  const starterRef = useRef<WalkStarter<{ record: boolean }> | null>(null);
  /** Who asked for the start under way (the "walk" events' provider). */
  const viaRef = useRef<WalkVia>("menu");
  /** Bumped by every run that begins: a retry checks a run began since it was armed. */
  const readySeqRef = useRef(0);
  useEffect(() => {
    const starter = createWalkStarter<{ record: boolean }>({
      roleGuess: () => walkRoleFor(roleRef.current.role, roleRef.current.hat),
      here: () => window.location.pathname + window.location.search,
      navigate: (route) => router.push(route),
      loadFacts: async (signal) => {
        const res = await fetch("/api/sk/walkthrough", { cache: "no-store", signal });
        return res.ok ? ((await res.json()) as { role?: string; facts?: WalkFacts }) : null;
      },
      // The page she is on only when stop 1 is on it, capped (≤ 2 s).
      settle: (capMs, signal) => waitForSettledPage({ probe: settleProbe(null), observe: observePage, signal, capMs }),
      onStarting: (on) => {
        startingRef.current = on;
        setStarting(on);
      },
      onReady: (tour, stops, ctx) => {
        readySeqRef.current += 1;
        setMatch(null);
        setAdvance(null);
        setWalk(startWalk(tour, stops, { record: ctx.record, runId: uid() }));
      },
      onEvent: (e) => logRef.current?.push(walkEvent({ via: viaRef.current, why: e.what, ms: e.ms, stops: e.stops, error: e.error })),
    });
    starterRef.current = starter;
    return () => {
      starter.cancel();
      if (starterRef.current === starter) starterRef.current = null;
    };
  }, [router]);
  // 2026-10-31 (founder: "Hi SK, show me around" by microphone started
  // nothing; the logs had the server's start and then silence): each start
  // says who asked and how it ended (voice-log.ts walkEvent), and a start that
  // began NO run by START_RETRY_MS is asked once more — unless she said Skip
  // or moved the tour in between.
  const retryRef = useRef<number | null>(null);
  const dropRetry = useCallback(() => {
    if (retryRef.current !== null) window.clearTimeout(retryRef.current);
    retryRef.current = null;
  }, []);
  useEffect(() => dropRetry, [dropRetry]);
  const start = useCallback(
    (opts?: { record?: boolean; via?: WalkVia }) => {
      const record = !!opts?.record || introRef.current;
      viaRef.current = opts?.via ?? "menu";
      logRef.current?.push(walkEvent({ via: viaRef.current, why: "asked", error: `run:${walkRef.current?.status ?? "none"}` }));
      if (!starterRef.current) logRef.current?.push(walkEvent({ via: viaRef.current, why: "failed", error: "no starter" }));
      starterRef.current?.start({ record });
      dropRetry();
      const seq = readySeqRef.current;
      retryRef.current = window.setTimeout(() => {
        retryRef.current = null;
        // A run began (whatever became of it), or one is still starting: nothing
        // to do. A tour from BEFORE the ask (paused at stop 3) does not count.
        if (readySeqRef.current !== seq || startingRef.current) return;
        viaRef.current = "retry";
        logRef.current?.push(walkEvent({ via: "retry", why: "retry", error: `run:${walkRef.current?.status ?? "none"}` }));
        if (!starterRef.current?.start({ record })) logRef.current?.push(walkEvent({ via: "retry", why: "no-run" }));
      }, START_RETRY_MS);
    },
    [dropRetry],
  );
  const cancelStart = useCallback(() => {
    dropRetry();
    starterRef.current?.cancel();
  }, [dropRetry]);

  // ── one stop, strictly in order: navigate → settle → highlight → speak ──
  const goKey = goKeyOf(walk);
  useEffect(() => {
    if (!goKey) return;
    const w = walkRef.current;
    const s = w ? currentStop(w) : null;
    if (!w || !s) return;
    const entry = ++entryRef.current;
    const ac = new AbortController();
    /** The stop was decided (shown or skipped); else its cut-off is logged. */
    let decided = false;
    const t0 = Date.now();
    const target = routePath(s.route);
    const here = window.location.pathname + window.location.search;
    const mustMove = !atRoute(s.route, here);
    if (mustMove) {
      navigatingRef.current = true;
      router.push(s.route);
    }
    const dom = {
      query: (sel: string) => document.querySelector(sel),
      queryAll: (sel: string) => Array.from(document.querySelectorAll(sel)),
      visible: (el: Element) => el.getClientRects().length > 0,
    };
    const none = { el: null as Element | null, index: 0 };
    void (async () => {
      // Found = visible and holding still; missing = only once the page has
      // SETTLED without it (never a clock counted from the navigation). A
      // combined stop is found with its parts: complete (every part's own
      // control) at once, else whatever is there once the page has settled.
      const hit = await waitForSettledAnchor<{ el: Element | null; line?: string; index: number; parts?: Array<PartHit<Element>> }>({
        find: () => (s.parts?.length ? findParts(s.parts, dom) : s.anchors.length ? findAnchor(s.anchors, dom) : none),
        rect: (h) => (h.el ? rectOf(h.el) : null),
        same: (a, b) => a.el === b.el,
        // A fallback anchor (not the stop's own control) only once the page
        // has settled without the control: a late-streaming control wins.
        provisional: (h) => h.index > 0,
        probe: settleProbe(target),
        observe: observePage,
        signal: ac.signal,
      });
      if (ac.signal.aborted) return;
      navigatingRef.current = false;
      if (!hit) {
        const waited = Date.now() - t0;
        const outcome = skipOutcome(waited, SETTLE_CAP_MS);
        const page = tourPageState({ pathOk: window.location.pathname === target, ready: document.readyState === "complete", loading: loadingSignal() }, outcome);
        debug(
          outcome === "cap"
            ? `stop "${s.id}" (${s.route}) skipped: no ${s.anchors.map((a) => a.sel).join(", ")} after ${waited} ms, page ${page}`
            : `stop "${s.id}" (${s.route}) skipped: the page settled without ${s.anchors.map((a) => a.sel).join(", ")}`,
        );
        decided = true;
        logStop(s.id, s.route, outcome, waited, page);
        setWalk((cur) => (cur && cur.runId === w.runId && cur.index === w.index ? missingStop(cur) : cur));
        return;
      }
      const el = hit.el;
      if (el) {
        // Into view, and only once the scroll has finished is it highlighted.
        const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        try {
          // "start" for a big section (the Library list at the TOP of the
          // screen, founder 2026-10-30); "center" for one control.
          el.scrollIntoView({ block: s.scroll ?? "center", behavior: reduce ? "auto" : "smooth" });
        } catch {
          /* old browsers */
        }
        await waitForStableRect({ rect: () => rectOf(el), signal: ac.signal });
        if (ac.signal.aborted) return;
      }
      const m: WalkMatch = { el, line: hit.line, key: goKey };
      if (hit.parts?.length) {
        // A combined stop: one line, the highlight on its first part for now,
        // moving at each part's marker inside the line.
        m.parts = hit.parts.map((p) => ({ el: p.el, id: p.id, line: p.line }));
        m.part = 0;
        const { text, cues } = partCues(markedRef.current(w, s, m.parts), m.parts.map((p) => p.id));
        m.text = text;
        m.cues = cues;
        m.times = cueReadingTimes(text, cues);
      }
      matchRef.current = m;
      setMatch(m);
      shownAtRef.current = { goKey, at: Date.now() };
      const busy = loadingSignal();
      decided = true;
      logStop(s.id, s.route, "shown", Date.now() - t0, busy ? `still-loading:${busy}` : "settled");
      // Only now the line: the caption shows with the highlight, and the voice
      // (or, without sound, the reading time) decides when the tour moves on.
      const text = lineOfRef.current(w, m);
      if (soundRef.current) speakStop(goKey, entry, text);
      else {
        setAdvance({ goKey, entry, ms: advanceDelay({ status: "running", soundOn: false, text }) ?? readingMs(text) });
        startPartClock(goKey);
      }
    })();
    return () => {
      ac.abort();
      clearPartClock();
      // 2026-10-31: cut off while still waiting (a pause, a move, a new run, the
      // launcher going away) — before, such a stop left no trace at all.
      if (!decided) logStop(s.id, s.route, "abandoned", Date.now() - t0, "cut-off");
    };
  }, [goKey, router, speakStop, logStop, startPartClock, clearPartClock]);

  // The auto-advance itself: only for the stop entry it was set for, only
  // while that stop is still the one running. A pause, a question, her typing
  // or a move cancels it (goKey changes, or `advance` is cleared).
  useEffect(() => {
    if (!advance || !goKey || advance.goKey !== goKey) return;
    if (advance.entry !== entryRef.current || heldRef.current === advance.entry) return;
    const t = window.setTimeout(() => {
      setAdvance(null);
      setMatch(null);
      setWalk((cur) => (cur && goKeyOf(cur) === advance.goKey ? nextStop(cur) : cur));
    }, advance.ms);
    return () => window.clearTimeout(t);
  }, [advance, goKey]);

  // -- SK's speaking rate, measured on the tour's own sentences --
  /** ms a character, smoothed over the sentences spoken so far. */
  const rateRef = useRef(SPEAK_MS_PER_CHAR);
  /** The sentence being spoken: its line, index, start and length. */
  const sentRef = useRef<{ key: string; index: number; at: number; chars: number } | null>(null);
  /** The sentence before has ended (the next one starts, or the line ends). */
  const measure = useCallback((key: string) => {
    const cur = sentRef.current;
    if (cur && cur.key === key) rateRef.current = nextSpeakRate(rateRef.current, Date.now() - cur.at, cur.chars);
    sentRef.current = null;
  }, []);

  /** Move a combined stop's highlight within sentence `index`, timed from now. */
  const timeParts = useCallback(
    (goKey: string, index: number, durationMs: number | null) => {
      const m = matchRef.current;
      if (!m?.parts || !m.cues || m.key !== goKey) return;
      clearPartClock();
      const due = partDueAt(m.cues, index);
      if (due !== null) showPart(goKey, due);
      for (const c of m.cues) {
        if (c.sentence !== index || c.at === 0) continue;
        partTimersRef.current.push(
          window.setTimeout(() => {
            if (goKeyOf(walkRef.current) === goKey) showPart(goKey, c.part);
          }, cueDelay(c, { durationMs, msPerChar: rateRef.current })),
        );
      }
    },
    [clearPartClock, showPart],
  );

  const onVoiceDone = useCallback(
    (key: string, outcome: LineOutcome) => {
      if (outcome === "spoken") measure(key);
      else if (sentRef.current?.key === key) sentRef.current = null;
      const sp = spokenRef.current;
      if (!sp || sp.key !== key) return; // an older line
      const w = walkRef.current;
      if (!w || goKeyOf(w) !== sp.goKey || sp.entry !== entryRef.current || heldRef.current === sp.entry) return;
      // Cut off (barge-in, Stop, an error): wait for Next or Resume.
      const ms = advanceDelay({ status: w.status, soundOn: true, outcome, text: sp.text });
      if (ms !== null) setAdvance({ goKey: sp.goKey, entry: sp.entry, ms });
      // Nothing was said (read-aloud off): a combined stop's highlight moves by reading time.
      if (outcome === "silent") startPartClock(sp.goKey);
    },
    [startPartClock, measure],
  );

  /** SK starts sentence `index` of the line `key`: the rate is measured on the
   *  sentence before, and a combined stop times its moves inside this one. */
  const onSentence = useCallback(
    (key: string, index: number) => {
      const sp = spokenRef.current;
      if (!sp || sp.key !== key) return;
      measure(key);
      sentRef.current = { key, index, at: Date.now(), chars: [...(splitSentences(sp.text)[index] ?? "")].length };
      if (goKeyOf(walkRef.current) !== sp.goKey || sp.entry !== entryRef.current) return;
      timeParts(sp.goKey, index, null);
    },
    [measure, timeParts],
  );

  /** Sentence `index` starts PLAYING (its audio is ready), `ms` long when the
   *  voice knows: the start and the in-sentence moves are taken from now. */
  const onSentencePlay = useCallback(
    (key: string, index: number, ms: number | null) => {
      const sp = spokenRef.current;
      if (!sp || sp.key !== key) return;
      const cur = sentRef.current;
      if (cur && cur.key === key && cur.index === index) cur.at = Date.now();
      if (goKeyOf(walkRef.current) !== sp.goKey || sp.entry !== entryRef.current) return;
      timeParts(sp.goKey, index, ms);
    },
    [timeParts],
  );

  // She left the stop's page herself (a link, the back button): hold the tour.
  useEffect(() => {
    const w = walkRef.current;
    const s = w ? currentStop(w) : null;
    if (!w || !s || w.status !== "running" || navigatingRef.current || !matchRef.current) return;
    if (pathname && pathname !== routePath(s.route)) {
      const shownAt = shownAtRef.current;
      const gk = goKeyOf(w);
      logStop(s.id, s.route, "away", shownAt && shownAt.goKey === gk ? Date.now() - shownAt.at : 0, `left-for:${pathname}`);
      setWalk((cur) => (cur ? pauseWalk(cur, "away") : cur));
      setMatch(null);
    }
  }, [pathname, logStop]);

  // The voice waits for her first tap or key anywhere (autoplay rule).
  const active = isActive(walk);
  const unlock = useCallback(() => {
    if (soundRef.current) return;
    soundRef.current = true;
    setSoundOn(true);
    try {
      window.sessionStorage.setItem(SOUND_KEY, "on");
    } catch {
      /* private mode */
    }
    // A stop already on screen: its line is said now, and the reading timer
    // gives way to the voice (the tour moves on once the line is spoken).
    const w = walkRef.current;
    const m = matchRef.current;
    const gk = goKeyOf(w);
    if (w && gk && m?.key === gk) speakStop(gk, entryRef.current, lineOfRef.current(w, m));
  }, [speakStop]);
  useEffect(() => {
    if (!active || soundOn) return;
    const onGesture = () => unlock();
    document.addEventListener("pointerdown", onGesture, true);
    document.addEventListener("keydown", onGesture, true);
    return () => {
      document.removeEventListener("pointerdown", onGesture, true);
      document.removeEventListener("keydown", onGesture, true);
    };
  }, [active, soundOn, unlock]);

  /** The browser refused to play (autoplay): back to "Tap for sound", so her
   *  next tap or key unlocks the voice again instead of the tour going silent. */
  const soundBlocked = useCallback(() => {
    if (!soundRef.current) return;
    soundRef.current = false;
    setSoundOn(false);
    try {
      window.sessionStorage.removeItem(SOUND_KEY);
    } catch {
      /* private mode */
    }
  }, []);

  const move = useCallback(
    (f: (w: WalkState) => WalkState) => {
      dropRetry();
      quiet();
      setAdvance(null);
      setMatch(null);
      setWalk((cur) => (cur ? f(cur) : cur));
    },
    [quiet, dropRetry],
  );
  const controls = useMemo(
    () => ({
      next: () => move(nextStop),
      back: () => move(backStop),
      skip: () => move(skipWalk),
      jump: (i: number) => move((w) => jumpTo(w, i)),
      resume: () => move(resumeWalk),
      pause: () => {
        dropRetry();
        quiet();
        setAdvance(null);
        setWalk((cur) => (cur ? pauseWalk(cur, "user") : cur));
      },
    }),
    [move, quiet, dropRetry],
  );

  const act = useCallback(
    (a: SkWalkAction) => {
      // She moved the tour herself: no retry of a start under her.
      dropRetry();
      // Starting (no run yet): only "skip" means something — it gives up the start.
      if (!isActive(walkRef.current)) {
        if (a === "skip" && startingRef.current) cancelStart();
        return;
      }
      if (a === "next") controls.next();
      else if (a === "back") controls.back();
      else if (a === "skip") controls.skip();
      else if (a === "pause") controls.pause();
      else if (a === "resume") controls.resume();
    },
    [controls, cancelStart, dropRetry],
  );

  const command = useCallback(
    (text: string) => {
      if (!isActive(walkRef.current) && !startingRef.current) return false;
      const c = walkCommand(text);
      if (!c) return false;
      act(c);
      return true;
    },
    [act],
  );

  const onQuestion = useCallback(() => {
    setAdvance(null);
    setWalk((cur) => (cur?.status === "running" ? pauseWalk(cur, "question") : cur));
  }, []);

  const hold = useCallback(() => {
    if (!isActive(walkRef.current)) return;
    heldRef.current = entryRef.current;
    setAdvance(null);
  }, []);

  // The caption shows WITH the highlight (not before the page has settled);
  // a paused stop keeps its words.
  const shown = walk?.status === "paused" || (!!match && match.key === goKey);
  const line = shown ? lineOf(walk, match) : "";
  const strip = useCallback(
    (answer?: string | null) =>
      !active && starting && copy ? (
        <WalkStarting copy={copy} onSkip={cancelStart} />
      ) : walk && active && copy ? (
        <WalkStrip
          copy={copy}
          walk={walk}
          line={line}
          answer={answer}
          soundOn={soundOn}
          onSound={unlock}
          onPause={controls.pause}
          onResume={controls.resume}
          onBack={controls.back}
          onNext={controls.next}
          onSkip={controls.skip}
          onChip={(text) => setFill({ key: uid(), text })}
        />
      ) : null,
    [walk, active, starting, cancelStart, copy, line, soundOn, unlock, controls],
  );

  const cur = walk ? currentStop(walk) : null;
  const state = useMemo<SkTurnWalk | null>(
    () => (walk && active && cur ? { active: true, paused: walk.status === "paused", role: walk.role, stop: cur.id, index: walk.index, total: walk.stops.length } : null),
    [walk, active, cur],
  );

  const showSpot = !!match?.el && active && (walk?.status === "running" || walk?.pausedBy === "user");
  return {
    active,
    starting,
    walk,
    strip,
    spotlight: showSpot && match?.el ? <WalkSpotlight el={match.el} /> : null,
    voice,
    fill,
    showAnswers: walk?.status === "paused" && walk.pausedBy === "question",
    command,
    onQuestion,
    start,
    onVoiceDone,
    onSentence,
    onSentencePlay,
    act,
    hold,
    state,
    soundBlocked,
  };
}
