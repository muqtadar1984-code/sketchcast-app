// SK's first-login walkthrough — the PURE engine (founder 2026-10-30).
//
//   planWalk()      — the role's stops (src/sk/walkthrough/stops.ts) against
//                     the user's facts: which stops play, on which concrete
//                     route, with which line and anchors (a combined stop:
//                     which of its parts play).
//   findParts() / joinParts() / partSentenceStarts() / partAtSentence() /
//   partReadingStarts() — a combined stop (one narration over several
//                     controls): its parts on the page, its ONE line, and
//                     which part the highlight is on as SK speaks (or, without
//                     sound, as the reading time passes).
//   start/next/back/jump/pause/resume/skip/missing — the state machine:
//                     idle → running ⇄ paused → done | skipped. Every function
//                     returns a NEW state and never throws on a bad move (back
//                     at the first stop stays there; next at the last is done).
//   createWalkStore() — the position in sessionStorage, so it survives page
//                     moves AND the separate launchers on /present and /sk.
//   findAnchor() / waitForSettledAnchor() — the first VISIBLE anchor, and the
//                     wait for it on a SETTLED page (2026-10-30 fix: no fixed
//                     clock — "missing" is decided only once the page has
//                     loaded and gone quiet, capped at ~20 s), with the DOM,
//                     the clock and the page probe injected so node tests
//                     drive them. waitForSettledPage() holds the tour's start.
//   advanceDelay()  — strict sequence: navigate → settle → highlight → the
//                     WHOLE line → only then may the tour move on by itself.
//   walkCommand()   — "next" / "back" / "pause" / "skip" / "continue" typed or
//                     said while the tour is on, also in natural phrasing
//                     ("Hi, continue with the tour?") — no turn, no model.
//
// The tour writes nothing but the seen row at the end (see sk-launcher.tsx),
// makes no model call, and never sends a sample question.

import { INTENT_FILLER_WORDS, intentWords } from "@/sk/shell/intent-normalize";
import { WALK_STOPS, type WalkAnchor, type WalkChip, type WalkDemo, type WalkFacts, type WalkNeedSpec, type WalkPartDef, type WalkRole, type WalkScroll, type WalkStopDef } from "@/sk/walkthrough/stops";

export type WalkStatus = "idle" | "running" | "paused" | "done" | "skipped";

/** One stop as planned for THIS user: concrete route, its line, its anchors. */
export type PlannedStop = {
  id: string;
  /** The URL to be on (path + optional query). */
  route: string;
  /** sk.walkthrough.<role>.<line>. */
  line: string;
  anchors: Array<{ sel: string; line?: string }>;
  /** How the anchor is scrolled into view (default "center"; "start" puts a
   *  big section at the top instead of showing its middle). */
  scroll?: WalkScroll;
  demo?: WalkDemo;
  chips?: WalkChip[];
  /** A combined stop (founder 2026-10-30: one narration over several
   *  controls on one screen): the parts that play for this user, in order.
   *  `anchors` is then every part's anchors (for the log), and `line` the
   *  first part's. */
  parts?: PlannedPart[];
};

/** One part of a combined stop as planned for this user. */
export type PlannedPart = {
  id: string;
  /** sk.walkthrough.<role>.<line>. */
  line: string;
  anchors: Array<{ sel: string; line?: string }>;
};

export type WalkState = {
  v: 1;
  role: WalkRole;
  stops: PlannedStop[];
  index: number;
  status: WalkStatus;
  /** Why it is paused: her Pause, a question she asked, or she left the stop's page. */
  pausedBy?: "user" | "question" | "away";
  /** The direction of the last move, so a stop whose anchor never appears is
   *  passed over the same way (back skips back). */
  dir: 1 | -1;
  /** True for the first-login run (or a run started while it was still due):
   *  its end writes the user_tour_progress row. Replays never do. */
  record: boolean;
  runId: string;
};

// ── the plan ────────────────────────────────────────────────────────────────

/** Does one need hold? Unknown facts count as present, except the ones a
 *  stop cannot exist without (a route value or a count). */
export function needHolds(spec: WalkNeedSpec, f: WalkFacts): boolean {
  const neg = spec.startsWith("!");
  const need = (neg ? spec.slice(1) : spec) as Exclude<WalkNeedSpec, `!${string}`>;
  let v: boolean;
  switch (need) {
    case "class":
      v = !!f.classId;
      break;
    case "tutor":
      v = !!f.tutorPath;
      break;
    case "children":
      v = (f.children ?? 0) > 0;
      break;
    case "verified":
      v = (f.verifiedChildren ?? 0) > 0;
      break;
    case "schoolParent":
      v = f.schoolParent === true;
      break;
    default:
      v = f[need] !== false;
  }
  return neg ? !v : v;
}

const TOKEN_RE = /\{(classId|tutorPath|bookId)\}/g;

/** Fill `{classId}` / `{tutorPath}` / `{bookId}`. A missing value in the query
 *  drops that parameter; in the path it makes the route unusable (null). */
export function resolveRoute(route: string, f: WalkFacts): string | null {
  const values: Record<string, string | null | undefined> = { classId: f.classId, tutorPath: f.tutorPath, bookId: f.bookId };
  const [path, query] = route.split("?", 2) as [string, string | undefined];
  let missing = false;
  const p = path.replace(TOKEN_RE, (_m, k: string) => {
    const v = values[k];
    if (!v) missing = true;
    return v ?? "";
  });
  if (missing || !p.startsWith("/")) return null;
  if (!query) return p;
  const kept: string[] = [];
  for (const pair of query.split("&")) {
    let gone = false;
    const filled = pair.replace(TOKEN_RE, (_m, k: string) => {
      const v = values[k];
      if (!v) gone = true;
      return encodeURIComponent(v ?? "");
    });
    if (!gone) kept.push(filled);
  }
  return kept.length ? `${p}?${kept.join("&")}` : p;
}

const anchorOf = (a: WalkAnchor) => (typeof a === "string" ? { sel: a } : { sel: a.sel, line: a.line });

/** A stop's or a part's needs and fallback against the facts: its line and
 *  anchors, or null when it does not play. */
function planLine(def: WalkStopDef | WalkPartDef, f: WalkFacts): { line: string; anchors: WalkAnchor[] } | null {
  if (def.needs && !def.needs.every((n) => needHolds(n, f))) return null;
  let line = def.line ?? def.id;
  let anchors = def.anchors;
  const fb = def.fallback?.find((x) => !needHolds(x.unless, f));
  if (fb) {
    if (fb.skip) return null;
    if (fb.line) line = fb.line;
    if (fb.anchors) anchors = fb.anchors;
  }
  return { line, anchors };
}

/** One stop against the facts: null when it does not play for this user. A
 *  combined stop plays the parts whose facts hold, and none = no stop. */
export function planStop(def: WalkStopDef, f: WalkFacts): PlannedStop | null {
  const own = planLine(def, f);
  if (!own) return null;
  let { line, anchors } = own;
  let parts: PlannedPart[] | undefined;
  if (def.parts) {
    parts = [];
    for (const p of def.parts) {
      const pl = planLine(p, f);
      if (pl) parts.push({ id: p.id, line: pl.line, anchors: pl.anchors.map(anchorOf) });
    }
    if (!parts.length) return null;
    line = parts[0]!.line;
    anchors = [];
  }
  const route = resolveRoute(def.route, f);
  if (!route) return null;
  return {
    id: def.id,
    route,
    line,
    anchors: parts ? parts.flatMap((p) => p.anchors) : anchors.map(anchorOf),
    ...(def.scroll && def.scroll !== "center" ? { scroll: def.scroll } : {}),
    ...(def.demo ? { demo: def.demo } : {}),
    ...(def.chips?.length ? { chips: [...def.chips] } : {}),
    ...(parts ? { parts } : {}),
  };
}

export function planWalk(role: WalkRole, facts: WalkFacts, defs: readonly WalkStopDef[] = WALK_STOPS[role]): PlannedStop[] {
  const out: PlannedStop[] = [];
  for (const d of defs) {
    const s = planStop(d, facts);
    if (s) out.push(s);
  }
  return out;
}

// ── the state machine ───────────────────────────────────────────────────────

export function idleWalk(role: WalkRole): WalkState {
  return { v: 1, role, stops: [], index: 0, status: "idle", dir: 1, record: false, runId: "" };
}

/** Start (or restart) from stop 1. An empty plan is done at once. */
export function startWalk(role: WalkRole, stops: PlannedStop[], opts: { record: boolean; runId: string }): WalkState {
  return { v: 1, role, stops, index: 0, status: stops.length ? "running" : "done", dir: 1, record: opts.record, runId: opts.runId };
}

const live = (s: WalkState) => s.status === "running" || s.status === "paused";

export function nextStop(s: WalkState): WalkState {
  if (!live(s)) return s;
  if (s.index >= s.stops.length - 1) return { ...s, status: "done", pausedBy: undefined };
  return { ...s, index: s.index + 1, status: "running", pausedBy: undefined, dir: 1 };
}

export function backStop(s: WalkState): WalkState {
  if (!live(s)) return s;
  return { ...s, index: Math.max(0, s.index - 1), status: "running", pausedBy: undefined, dir: -1 };
}

export function jumpTo(s: WalkState, index: number): WalkState {
  if (!live(s) || !s.stops.length) return s;
  const i = Math.min(Math.max(0, Math.trunc(index)), s.stops.length - 1);
  return { ...s, index: i, status: "running", pausedBy: undefined, dir: i < s.index ? -1 : 1 };
}

export function pauseWalk(s: WalkState, by: "user" | "question" | "away" = "user"): WalkState {
  if (s.status !== "running") return s;
  return { ...s, status: "paused", pausedBy: by };
}

export function resumeWalk(s: WalkState): WalkState {
  if (s.status !== "paused") return s;
  return { ...s, status: "running", pausedBy: undefined };
}

export function skipWalk(s: WalkState): WalkState {
  if (!live(s)) return s;
  return { ...s, status: "skipped", pausedBy: undefined };
}

/** The current stop's anchor never appeared: pass over it in the direction of
 *  travel. Going back past stop 1 lands on the first stop that still exists
 *  rather than ending the tour; going forward past the last one finishes. */
export function missingStop(s: WalkState): WalkState {
  if (s.status !== "running") return s;
  const stops = s.stops.filter((_, i) => i !== s.index);
  if (!stops.length) return { ...s, stops, index: 0, status: "done" };
  if (s.dir === -1) {
    const i = Math.max(0, s.index - 1);
    return { ...s, stops, index: i, dir: s.index === 0 ? 1 : -1 };
  }
  if (s.index >= stops.length) return { ...s, stops, index: stops.length - 1, status: "done" };
  return { ...s, stops, index: s.index };
}

export function currentStop(s: WalkState): PlannedStop | null {
  return live(s) ? (s.stops[s.index] ?? null) : null;
}

export function isActive(s: WalkState | null | undefined): boolean {
  return !!s && live(s);
}

// ── persistence (sessionStorage) ────────────────────────────────────────────

export const WALK_STORE_KEY = "sk.walkthrough";

export type WalkStore = {
  load: () => WalkState | null;
  save: (s: WalkState) => void;
  clear: () => void;
};

const validAnchors = (a: unknown) => Array.isArray(a) && a.every((x) => x && typeof x.sel === "string");

function validStop(x: unknown): x is PlannedStop {
  const s = x as PlannedStop;
  return (
    !!s &&
    typeof s.id === "string" &&
    typeof s.route === "string" &&
    s.route.startsWith("/") &&
    typeof s.line === "string" &&
    Array.isArray(s.anchors) &&
    s.anchors.every((a) => a && typeof a.sel === "string") &&
    (s.scroll === undefined || s.scroll === "start" || s.scroll === "center") &&
    (s.parts === undefined || (Array.isArray(s.parts) && s.parts.length > 0 && s.parts.every((p) => p && typeof p.id === "string" && typeof p.line === "string" && validAnchors(p.anchors))))
  );
}

/** A store over sessionStorage (or nothing: private mode, a node test). Only a
 *  live run (running / paused) is kept; anything unreadable reads as none. */
export function createWalkStore(storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined): WalkStore {
  return {
    load() {
      if (!storage) return null;
      try {
        const raw = storage.getItem(WALK_STORE_KEY);
        if (!raw) return null;
        const s = JSON.parse(raw) as WalkState;
        if (s?.v !== 1 || !WALK_STOPS[s.role] || !Array.isArray(s.stops) || !s.stops.every(validStop)) return null;
        if (s.status !== "running" && s.status !== "paused") return null;
        if (!Number.isInteger(s.index) || s.index < 0 || s.index >= s.stops.length) return null;
        return { ...s, dir: s.dir === -1 ? -1 : 1, record: s.record === true, runId: String(s.runId ?? "") };
      } catch {
        return null;
      }
    },
    save(s) {
      if (!storage) return;
      try {
        if (live(s)) storage.setItem(WALK_STORE_KEY, JSON.stringify(s));
        else storage.removeItem(WALK_STORE_KEY);
      } catch {
        /* full or blocked: the tour still runs on this page */
      }
    },
    clear() {
      try {
        storage?.removeItem(WALK_STORE_KEY);
      } catch {
        /* ignore */
      }
    },
  };
}

// ── anchors ─────────────────────────────────────────────────────────────────

/** The DOM the anchor search needs (a node test passes a fake). */
export type AnchorDom<E> = {
  query: (sel: string) => E | null;
  /** Every match, in document order (querySelectorAll). When given, the first
   *  VISIBLE match of a selector wins — a hidden first match (a collapsed
   *  book, a phone-hidden tab) no longer hides a visible later one. */
  queryAll?: (sel: string) => E[];
  /** Rendered with a box (getClientRects().length > 0): a `hidden sm:flex`
   *  tab is in the DOM on a phone but shows nothing. */
  visible: (el: E) => boolean;
};

/** `index` is the anchor's place in the stop's list: 0 is the stop's own
 *  control, anything later is a fallback (the settled wait accepts a fallback
 *  only once the page has settled, so a control that streams in late still
 *  wins over it). */
export type AnchorMatch<E> = { el: E; sel: string; line?: string; index: number };

/** The first visible anchor, in the stop's order. An invalid selector is
 *  passed over rather than thrown. */
export function findAnchor<E>(anchors: PlannedStop["anchors"], dom: AnchorDom<E>): AnchorMatch<E> | null {
  for (let index = 0; index < anchors.length; index++) {
    const a = anchors[index]!;
    let el: E | null = null;
    try {
      el = dom.queryAll ? (dom.queryAll(a.sel).find((x) => dom.visible(x)) ?? null) : dom.query(a.sel);
    } catch {
      el = null;
    }
    if (el && dom.visible(el)) return { el, sel: a.sel, ...(a.line ? { line: a.line } : {}), index };
  }
  return null;
}

// ── combined stops: one narration, the highlight moving part by part ───────

/** One part of a combined stop as found on the page: its control (or a
 *  fallback, with that anchor's line) and the line key to say. */
export type PartHit<E> = { id: string; el: E; line: string; index: number };

/** A combined stop as found: the first part's control is where the highlight
 *  starts. `index` is 0 only when EVERY planned part found its own control,
 *  so the settled wait takes fallbacks (or a part left out) only once the page
 *  has settled — exactly like a single stop's fallback anchor. */
export type PartsMatch<E> = { el: E; index: number; parts: Array<PartHit<E>> };

/** Each part's first visible anchor; a part with none is left out. Null when
 *  no part is on the page. */
export function findParts<E>(parts: PlannedPart[], dom: AnchorDom<E>): PartsMatch<E> | null {
  const hits: Array<PartHit<E>> = [];
  let complete = true;
  for (const p of parts) {
    const m = findAnchor(p.anchors, dom);
    if (!m) {
      complete = false;
      continue;
    }
    if (m.index > 0) complete = false;
    hits.push({ id: p.id, el: m.el, line: m.line ?? p.line, index: m.index });
  }
  if (!hits.length) return null;
  return { el: hits[0]!.el, index: complete ? 0 : 1, parts: hits };
}

/** The ONE line a combined stop says: its parts' words, in order. A part's
 *  words that do not end a sentence get a full stop, so the next part starts
 *  a sentence of its own (the highlight moves on sentence starts). */
export function joinParts(texts: string[]): string {
  return texts
    .map((t) => String(t ?? "").trim())
    .filter(Boolean)
    .map((t) => (/[.!?؟।]["'”’»)]*$/u.test(t) ? t : `${t}.`))
    .join(" ");
}

/** The sentence each part starts at, when the joined line is spoken sentence
 *  by sentence (`split` = the speech coordinator's splitSentences). */
export function partSentenceStarts(texts: string[], split: (t: string) => string[]): number[] {
  const starts: number[] = [];
  let n = 0;
  for (const t of texts) {
    starts.push(n);
    // A part with no words says nothing: it shares the next part's start.
    n += split(joinParts([t])).length;
  }
  return starts;
}

/** Which part sentence `i` (0-based, in speaking order) belongs to. */
export function partAtSentence(starts: number[], i: number): number {
  let k = 0;
  for (let j = 0; j < starts.length; j++) if (starts[j]! <= i) k = j;
  return k;
}

/** Without sound: when each part's highlight starts (ms after the stop is
 *  shown), sharing the whole line's reading time by the parts' lengths. */
export function partReadingStarts(texts: string[]): number[] {
  const lens = texts.map((t) => [...String(t ?? "")].length);
  const total = lens.reduce((a, b) => a + b, 0);
  const ms = readingMs(joinParts(texts));
  const out: number[] = [];
  let before = 0;
  for (const l of lens) {
    out.push(total ? Math.round((before / total) * ms) : 0);
    before += l;
  }
  return out;
}

/** A box on screen (getBoundingClientRect's numbers). */
export type WalkRect = { top: number; left: number; width: number; height: number };

const sameRect = (a: WalkRect | null, b: WalkRect | null) =>
  !!a && !!b && Math.round(a.top) === Math.round(b.top) && Math.round(a.left) === Math.round(b.left) && Math.round(a.width) === Math.round(b.width) && Math.round(a.height) === Math.round(b.height);

/** The page is settled when nothing has changed for this long (and it is loaded). */
export const SETTLE_QUIET_MS = 800;
/** An anchor counts once its box is the same on two checks this far apart. */
export const ANCHOR_STABLE_MS = 200;
/** The longest a stop waits for its page before it is passed over (a hard cap). */
export const SETTLE_CAP_MS = 20_000;

/** What the settled-page wait reads off the page (a browser probe, or a test fake). */
export type SettleProbe = {
  /** The address bar is on the stop's route. */
  pathOk: () => boolean;
  /** document.readyState === "complete". */
  ready: () => boolean;
  /** A loading UI is visible: aria-busy, [data-loading], a skeleton, loading.tsx. */
  loading: () => boolean;
};

export type SettleOptions = {
  probe: SettleProbe;
  /** Subscribe to DOM changes (a MutationObserver in the browser); returns unsubscribe. */
  observe: (onChange: () => void) => () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  quietMs?: number;
  stableMs?: number;
  capMs?: number;
  signal?: AbortSignal;
};

/**
 * Wait for a stop's anchor on a SETTLED page (founder 2026-10-30: "SK waits for
 * the page to load before continuing"). Replaces the fixed 4 s clock counted
 * from the navigation, which dropped four of the teacher's fourteen stops on a
 * slow dashboard ("1 of 10", starting at "output").
 *
 *   found   — `find()` returns an anchor whose box (`rect`) is non-zero and the
 *             same on two checks `stableMs` apart. The page need not be settled
 *             for that: a stable anchor is good enough. A stop with nothing to
 *             point at (`rect` → null) plays once the page has settled.
 *   missing — decided only once the page has SETTLED without one: on the
 *             stop's route, loaded, no loading UI, and no DOM change for
 *             `quietMs`.
 *   cap     — after `capMs` (≈20 s): the anchor found by then (even if it is
 *             still moving), else null.
 *   abort   — null at once.
 *
 * Everything is injected (clock, timers, page probe, observer), so node tests
 * drive it. Checks run every `stableMs`; a mutation only moves the quiet clock.
 */
export function waitForSettledAnchor<T>(
  opts: SettleOptions & {
    find: () => T | null;
    /** The anchor's box; null when the hit has no element (a stop with no anchor). */
    rect: (hit: T) => WalkRect | null;
    /** Two finds are the same anchor (default ===; the browser compares elements). */
    same?: (a: T, b: T) => boolean;
    /** A FALLBACK find (not the stop's own control): taken only once the page
     *  has settled without the control (or at the cap). */
    provisional?: (hit: T) => boolean;
  },
): Promise<T | null> {
  const now = opts.now ?? (() => Date.now());
  const setT = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const quietMs = opts.quietMs ?? SETTLE_QUIET_MS;
  const stableMs = opts.stableMs ?? ANCHOR_STABLE_MS;
  const capMs = opts.capMs ?? SETTLE_CAP_MS;
  const same = opts.same ?? ((a: T, b: T) => a === b);
  return new Promise<T | null>((resolve) => {
    if (opts.signal?.aborted) return resolve(null);
    const started = now();
    let lastChange = started;
    let candidate: { hit: T; rect: WalkRect } | null = null;
    let timer: unknown = null;
    let finished = false;
    let unsubscribe: () => void = () => {};
    const finish = (v: T | null) => {
      if (finished) return;
      finished = true;
      unsubscribe();
      if (timer !== null) clearT(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(v);
    };
    const onAbort = () => finish(null);
    opts.signal?.addEventListener("abort", onAbort);
    const safeFind = (): T | null => {
      try {
        return opts.probe.pathOk() ? opts.find() : null;
      } catch {
        return null;
      }
    };
    const settled = (t: number) => opts.probe.pathOk() && opts.probe.ready() && !opts.probe.loading() && t - lastChange >= quietMs;
    const check = () => {
      timer = null;
      if (finished) return;
      if (opts.signal?.aborted) return finish(null);
      const t = now();
      const hit = safeFind();
      if (t - started >= capMs) {
        // The cap: whatever visible anchor there is by now (even still moving).
        const r = hit ? opts.rect(hit) : null;
        return finish(hit && (r === null || (r.width > 0 && r.height > 0)) ? hit : null);
      }
      if (hit) {
        const r = opts.rect(hit);
        if (r === null) {
          // Nothing to point at: the stop plays once the page has settled.
          if (settled(t)) return finish(hit);
        } else if (r.width > 0 && r.height > 0) {
          const stable = !!candidate && same(candidate.hit, hit) && sameRect(candidate.rect, r);
          if (stable && (!opts.provisional?.(hit) || settled(t))) return finish(hit);
          candidate = { hit, rect: r };
        } else candidate = null;
      } else {
        candidate = null;
        if (settled(t)) return finish(null);
      }
      timer = setT(check, stableMs);
    };
    unsubscribe = opts.observe(() => {
      lastChange = now();
    });
    check();
  });
}

/** Wait for the page itself to settle — the tour does not START before the
 *  home page has. Resolves true once settled (or at the cap: the tour then
 *  starts anyway), false when aborted. */
export function waitForSettledPage(opts: SettleOptions): Promise<boolean> {
  const hit = { page: true };
  return waitForSettledAnchor({ ...opts, find: () => hit, rect: () => null }).then((v) => v !== null && !opts.signal?.aborted);
}

/** Wait for a box to stop moving (a smooth scroll finishing): resolves once two
 *  checks `stepMs` apart read the same box, or at `capMs`. */
export function waitForStableRect(opts: {
  rect: () => WalkRect | null;
  setTimer?: (fn: () => void, ms: number) => unknown;
  stepMs?: number;
  capMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const setT = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const stepMs = opts.stepMs ?? 100;
  const maxSteps = Math.max(1, Math.ceil((opts.capMs ?? 1500) / stepMs));
  return new Promise<void>((resolve) => {
    let last = opts.rect();
    let steps = 0;
    const tick = () => {
      if (opts.signal?.aborted) return resolve();
      const r = opts.rect();
      if (r === null || sameRect(last, r) || ++steps >= maxSteps) return resolve();
      last = r;
      setT(tick, stepMs);
    };
    setT(tick, stepMs);
  });
}

// ── auto-advance: one thing at a time ───────────────────────────────────────

/** With sound: the pause after a line has FULLY finished, before the next stop. */
export const ADVANCE_AFTER_SPEECH_MS = 1000;
/** Without sound: reading time per character, and its floor. */
export const READ_MS_PER_CHAR = 55;
export const READ_MIN_MS = 5000;

export function readingMs(text: string): number {
  return Math.max(READ_MIN_MS, Math.round([...String(text ?? "")].length * READ_MS_PER_CHAR));
}

/** How a stop's line ended: every sentence spoken, cut off (barge-in, Stop,
 *  an error), or silent (read-aloud off / nothing to say). */
export type LineOutcome = "spoken" | "stopped" | "silent";

/**
 * When the tour may move on by itself — strictly after the stop is shown
 * (navigated, settled, highlighted) AND its line is over. Null = never by
 * itself (wait for Next or Resume).
 *   sound on  — ADVANCE_AFTER_SPEECH_MS after the line FULLY finished (all its
 *               sentences); a line that was cut off never advances; null
 *               while it is still being spoken. Read-aloud off reads instead.
 *   sound off — the line's reading time (55 ms a character, at least 5 s).
 * Only a running tour advances: a pause or a question holds it.
 */
export function advanceDelay(input: { status: WalkStatus; soundOn: boolean; outcome?: LineOutcome | null; text: string }): number | null {
  if (input.status !== "running") return null;
  if (!input.soundOn || input.outcome === "silent") return readingMs(input.text);
  if (input.outcome === "spoken") return ADVANCE_AFTER_SPEECH_MS;
  return null;
}

/** The path part of a route ("/dashboard/diary?c=1" → "/dashboard/diary"). */
export function routePath(route: string): string {
  return route.split("?", 1)[0] ?? route;
}

// ── spoken / typed tour commands ────────────────────────────────────────────

export type WalkCommand = "next" | "back" | "pause" | "resume" | "skip";

const CMD: Array<[WalkCommand, RegExp]> = [
  ["next", /^(?:next|next stop|go on|seterusnya|berikutnya|التالي|التالية|suivant|siguiente|próximo|proximo|seguinte|अगला|आगे|पुढे|पुढील|తదుపరి)$/u],
  ["back", /^(?:back|go back|previous|kembali|sebelumnya|السابق|رجوع|ارجع|retour|précédent|precedent|atrás|atras|anterior|voltar|पीछे|पिछला|मागे|వెనుకకు)$/u],
  ["pause", /^(?:pause|pause the tour|hold on|wait|jeda|tunggu|توقف|انتظر|attends|attendez|espera|pausa|pausar|रुको|थांबा|ఆగు)$/u],
  [
    "resume",
    /^(?:continue|continue the tour|carry on|resume|keep going|sambung|teruskan|تابع|استمر|واصل|continuer|continuez|continuar|continua|जारी रखें|आगे बढ़ो|सुरू ठेवा|కొనసాగించు)$/u,
  ],
  ["skip", /^(?:skip|skip the tour|end the tour|stop the tour|langkau|tamat|تخط|تخطى|إنهاء الجولة|passer|terminer|omitir|saltar|pular|छोड़ें|वगळा|దాటవేయి)$/u],
];

// 2026-10-30 (founder: "Hi, continue with the tour?" went to the model as a
// question). The loose match: greetings and fillers are stripped, then a
// command word ANYWHERE in a short message counts when the message also
// mentions the tour, or is nothing but the command and a few light words
// ("go to the next one"). A real question ("how do I continue a lesson?")
// keeps words that are neither, so it stays a question.

/** Greetings and fillers, any app language (whole words or phrases): the ONE
 *  shared frame list (intent-normalize.ts) plus the yes-words a command may
 *  carry here ("yes, next"). */
const FILLERS = [
  ...INTENT_FILLER_WORDS,
  "k", "yes", "yeah", "yep", "sure", "want to", "can we", "could we",
  "oui", "d'accord", "sí", "si", "sim", "हाँ", "हो", "అవును",
];

/** Words that only carry a command along ("go to the next one"). */
const LIGHT = new Set([
  "go", "to", "the", "one", "stop", "step", "page", "on", "with", "this", "that", "a", "an", "again", "ahead", "it", "me", "us", "of", "our", "your", "my", "please", "now", "show", "take", "move", "last", "part", "bit", "little", "sec", "second", "moment", "minute", "for", "just",
  "ke", "yang", "ini", "itu", "dengan",
  "إلى", "الى", "مع", "هذه", "هذا",
  "la", "le", "les", "à", "au", "avec", "cette", "ce",
  "el", "al", "con", "esta", "este", "lo",
  "o", "a", "ao", "com", "essa", "esse", "isso",
  "को", "से", "यह", "ये", "ला", "हा", "ही",
  "ని", "ఈ",
]);

/** The tour itself, any app language. */
const TOUR_WORDS = ["tour", "the tour", "walkthrough", "walk through", "guided tour", "lawatan", "panduan", "tur", "الجولة", "جولة", "visite", "la visite", "recorrido", "passeio", "टूर", "టూర్"];

/** Command words found anywhere (phrases first, so "go back" beats "back"). */
const LOOSE: Array<[WalkCommand, string[]]> = [
  ["resume", ["continue", "carry on", "resume", "keep going", "go on with", "pick up", "lanjutkan", "lanjut", "sambung", "sambungkan", "teruskan", "تابع", "استمر", "واصل", "أكمل", "اكمل", "continuer", "continuez", "continuar", "continua", "continúa", "continúe", "continue com", "जारी", "सुरू ठेवा", "కొనసాగించు"]],
  ["skip", ["skip", "end", "stop", "finish", "exit", "quit", "close", "langkau", "tamat", "tamatkan", "hentikan", "تخط", "تخطى", "إنهاء", "أنهي", "أنهِ", "انهي", "passer", "terminer", "arrêter", "omitir", "saltar", "terminar", "pular", "encerrar", "छोड़ें", "छोड़ो", "बंद", "वगळा", "దాటవేయి"]],
  ["back", ["go back", "back", "previous", "kembali", "sebelumnya", "السابق", "رجوع", "ارجع", "retour", "précédent", "precedent", "atrás", "atras", "anterior", "voltar", "पीछे", "पिछला", "मागे", "వెనుకకు"]],
  ["pause", ["pause", "hold on", "wait", "jeda", "tunggu", "توقف", "انتظر", "attends", "attendez", "espera", "pausa", "pausar", "रुको", "थांबा", "ఆగు"]],
  ["next", ["next", "go on", "move on", "go forward", "forward", "seterusnya", "berikutnya", "التالي", "التالية", "suivant", "suivante", "siguiente", "próximo", "proximo", "seguinte", "अगला", "आगे", "पुढे", "पुढील", "తదుపరి"]],
];

/** Words that turn a command around ("don't skip the tour"). */
const NEGATION = /(?:^| )(?:don't|dont|do not|not|no|never|jangan|tidak|لا|ne|pas|nunca|não|nao|मत|नहीं|వద్దు)(?= |$)/u;

/** "skip" and friends with a meaning outside the tour ("stop", "end"): only
 *  with the tour named. */
const NEEDS_TOUR = new Set(["end", "stop", "finish", "exit", "quit", "close", "hentikan", "إنهاء", "أنهي", "أنهِ", "انهي", "arrêter", "terminar", "encerrar", "बंद"]);

const MAX_LOOSE_WORDS = 8;
/** Other words a command may carry when the tour is named ("…the tour you were giving me"). */
const MAX_EXTRA_WORDS = 3;

/** A question about something ("how do I end a lesson in the tour?") is not a command. */
const QUESTION_START = /^(?:how|what|what's|whats|why|when|where|who|which|is|are|does|do|can i|should|bagaimana|macam mana|apa|kenapa|mengapa|bila|di mana|كيف|ماذا|ما|لماذا|متى|أين|هل|comment|quoi|pourquoi|quand|où|est-ce|cómo|como|qué|que|por qué|cuándo|dónde|o que|porque|quando|onde|कैसे|क्या|क्यों|कब|कहाँ|कसे|काय|का|कधी|कुठे|ఎలా|ఏమి|ఎందుకు|ఎప్పుడు|ఎక్కడ)(?: |$)/u;

/** Lower-case, quotes and punctuation to spaces, one space between words. */
const normalise = intentWords;

const has = (t: string, phrase: string) => ` ${t} `.includes(` ${phrase} `);
const cut = (t: string, phrase: string) => ` ${t} `.split(` ${phrase} `).join(" ").replace(/\s+/g, " ").trim();

/** Remove every filler phrase (longest first), wherever it stands. */
function stripFillers(t: string): string {
  let out = t;
  for (const f of [...FILLERS].sort((a, b) => b.length - a.length)) while (has(out, f)) out = cut(out, f);
  return out;
}

/**
 * A tour command, or null for anything else (which is a question for SK).
 * Strict by default: a bare command, after greetings and fillers ("ok next",
 * "please continue"), or the command anywhere in a short message (≤ 8 words)
 * that mentions the tour or carries nothing else but light words ("Hi,
 * continue with the tour?", "go to the next one", "skip this tour please").
 * `loose` (the server's check while a tour is on): no word limit, but the
 * tour must be named.
 */
export function walkCommand(text: string, opts: { loose?: boolean } = {}): WalkCommand | null {
  const t = normalise(text);
  if (!t) return null;
  const bare = stripFillers(t);
  if (!bare) return null;
  for (const [cmd, re] of CMD) if (re.test(bare)) return cmd;
  if (NEGATION.test(bare) || QUESTION_START.test(bare)) return null;
  const words = t.split(" ").length;
  const tourNamed = TOUR_WORDS.some((w) => has(bare, w));
  if (!opts.loose && words > MAX_LOOSE_WORDS) return null;
  if (opts.loose && !tourNamed) return null;
  // The earliest command phrase in the message.
  let best: { cmd: WalkCommand; at: number; phrase: string } | null = null;
  for (const [cmd, phrases] of LOOSE) {
    for (const p of phrases) {
      const at = ` ${bare} `.indexOf(` ${p} `);
      if (at < 0) continue;
      if (NEEDS_TOUR.has(p) && !tourNamed) continue;
      if (!best || at < best.at || (at === best.at && p.length > best.phrase.length)) best = { cmd, at, phrase: p };
    }
  }
  if (!best) return null;
  // What else the message says: with the tour named, a few other words; with
  // it unnamed, nothing but the command and light words ("go to the next one").
  let rest = cut(bare, best.phrase);
  for (const w of [...TOUR_WORDS].sort((a, b) => b.length - a.length)) while (has(rest, w)) rest = cut(rest, w);
  const extra = rest.split(" ").filter((w) => w && !LIGHT.has(w)).length;
  return extra <= (tourNamed ? MAX_EXTRA_WORDS : 0) ? best.cmd : null;
}

// 2026-10-30 (founder: "Continue with the tour." with NO tour running went to
// the model, which said there is no tour). With no run in this tab, "continue
// / resume / carry on / start … the tour" STARTS one — the existing
// `walkthrough` start event, no model. The tour must be NAMED: a bare
// "continue" with no tour is a Board or tutor move ("continue the video").

/**
 * True when `text` asks to continue, resume or start THE TOUR (any app
 * language, natural phrasing like "Hi, continue with the tour?"). Callers use
 * it only when no tour is running: the running tour takes "continue" itself
 * (walkCommand → "resume").
 */
export function walkStartCommand(text: string): boolean {
  const bare = stripFillers(normalise(text));
  if (!bare || !TOUR_WORDS.some((w) => has(bare, w))) return false;
  if (walkCommand(text, { loose: true }) === "resume") return true;
  // "start / begin / restart the tour" (the server's "Show me around" rule
  // takes the bare forms; this catches them inside a short sentence).
  if (NEGATION.test(bare) || QUESTION_START.test(bare)) return false;
  let rest = bare;
  for (const w of [...TOUR_WORDS].sort((a, b) => b.length - a.length)) while (has(rest, w)) rest = cut(rest, w);
  const verb = [...START_WORDS].sort((a, b) => b.length - a.length).find((p) => has(rest, p));
  if (!verb) return false;
  return cut(rest, verb).split(" ").filter((w) => w && !LIGHT.has(w)).length <= MAX_EXTRA_WORDS;
}

/** "Start the tour" verbs, any app language. */
const START_WORDS = [
  "start", "begin", "restart", "start again", "begin again",
  "mula", "mulakan", "mulai",
  "ابدأ", "ابدا", "إبدأ",
  "commencer", "commence", "commencez", "démarrer", "demarrer",
  "empezar", "empieza", "comenzar", "comienza", "iniciar", "inicia",
  "começar", "comecar", "comece",
  "शुरू करो", "शुरू करें", "शुरू",
  "सुरू करा", "सुरू",
  "ప్రారంభించు", "మొదలుపెట్టు",
];
