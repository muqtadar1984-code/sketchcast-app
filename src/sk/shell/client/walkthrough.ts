// SK's first-login walkthrough — the PURE engine (founder 2026-10-30).
//
//   planWalk()      — the role's stops (src/sk/walkthrough/stops.ts) against
//                     the user's facts: which stops play, on which concrete
//                     route, with which line and anchors.
//   start/next/back/jump/pause/resume/skip/missing — the state machine:
//                     idle → running ⇄ paused → done | skipped. Every function
//                     returns a NEW state and never throws on a bad move (back
//                     at the first stop stays there; next at the last is done).
//   createWalkStore() — the position in sessionStorage, so it survives page
//                     moves AND the separate launchers on /present and /sk.
//   findAnchor() / waitForAnchor() — the first VISIBLE anchor, and the wait for
//                     it after a navigation (observer + ~4 s timeout), with
//                     the DOM injected so node tests drive them.
//   walkCommand()   — "next" / "back" / "pause" / "skip" / "continue" typed or
//                     said while the tour is on (no turn, no model).
//
// The tour writes nothing but the seen row at the end (see sk-launcher.tsx),
// makes no model call, and never sends a sample question.

import { WALK_STOPS, type WalkAnchor, type WalkChip, type WalkDemo, type WalkFacts, type WalkNeedSpec, type WalkRole, type WalkStopDef } from "@/sk/walkthrough/stops";

export type WalkStatus = "idle" | "running" | "paused" | "done" | "skipped";

/** One stop as planned for THIS user: concrete route, its line, its anchors. */
export type PlannedStop = {
  id: string;
  /** The URL to be on (path + optional query). */
  route: string;
  /** sk.walkthrough.<role>.<line>. */
  line: string;
  anchors: Array<{ sel: string; line?: string }>;
  demo?: WalkDemo;
  chips?: WalkChip[];
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

const TOKEN_RE = /\{(classId|tutorPath)\}/g;

/** Fill `{classId}` / `{tutorPath}`. A missing value in the query drops that
 *  parameter; in the path it makes the route unusable (null). */
export function resolveRoute(route: string, f: WalkFacts): string | null {
  const values: Record<string, string | null | undefined> = { classId: f.classId, tutorPath: f.tutorPath };
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

/** One stop against the facts: null when it does not play for this user. */
export function planStop(def: WalkStopDef, f: WalkFacts): PlannedStop | null {
  if (def.needs && !def.needs.every((n) => needHolds(n, f))) return null;
  let line = def.line ?? def.id;
  let anchors = def.anchors;
  const fb = def.fallback?.find((x) => !needHolds(x.unless, f));
  if (fb) {
    if (fb.skip) return null;
    if (fb.line) line = fb.line;
    if (fb.anchors) anchors = fb.anchors;
  }
  const route = resolveRoute(def.route, f);
  if (!route) return null;
  return {
    id: def.id,
    route,
    line,
    anchors: anchors.map(anchorOf),
    ...(def.demo ? { demo: def.demo } : {}),
    ...(def.chips?.length ? { chips: [...def.chips] } : {}),
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

function validStop(x: unknown): x is PlannedStop {
  const s = x as PlannedStop;
  return !!s && typeof s.id === "string" && typeof s.route === "string" && s.route.startsWith("/") && typeof s.line === "string" && Array.isArray(s.anchors) && s.anchors.every((a) => a && typeof a.sel === "string");
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
  /** Rendered with a box (getClientRects().length > 0): a `hidden sm:flex`
   *  tab is in the DOM on a phone but shows nothing. */
  visible: (el: E) => boolean;
};

export type AnchorMatch<E> = { el: E; sel: string; line?: string };

/** The first visible anchor, in the stop's order. An invalid selector is
 *  passed over rather than thrown. */
export function findAnchor<E>(anchors: PlannedStop["anchors"], dom: AnchorDom<E>): AnchorMatch<E> | null {
  for (const a of anchors) {
    let el: E | null = null;
    try {
      el = dom.query(a.sel);
    } catch {
      el = null;
    }
    if (el && dom.visible(el)) return { el, sel: a.sel, ...(a.line ? { line: a.line } : {}) };
  }
  return null;
}

export const ANCHOR_TIMEOUT_MS = 4000;

/** Wait for `find()` to return something: checked now, again on every change
 *  the observer reports, and given up (null) after `timeoutMs` or on abort. */
export function waitForAnchor<T>(opts: {
  find: () => T | null;
  /** Subscribe to page changes (a MutationObserver in the browser); returns unsubscribe. */
  observe: (onChange: () => void) => () => void;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  signal?: AbortSignal;
}): Promise<T | null> {
  const setT = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  return new Promise<T | null>((resolve) => {
    if (opts.signal?.aborted) return resolve(null);
    const first = opts.find();
    if (first) return resolve(first);
    let settled = false;
    let unsubscribe: () => void = () => {};
    let timer: unknown = null;
    const settle = (v: T | null) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (timer !== null) clearT(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(v);
    };
    const onAbort = () => settle(null);
    opts.signal?.addEventListener("abort", onAbort);
    unsubscribe = opts.observe(() => {
      const hit = opts.find();
      if (hit) settle(hit);
    });
    timer = setT(() => settle(opts.find()), opts.timeoutMs ?? ANCHOR_TIMEOUT_MS);
  });
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

/** A bare tour command, or null for anything else (which is a question). */
export function walkCommand(text: string): WalkCommand | null {
  const t = text
    .toLowerCase()
    .replace(/[“”"«»]/g, "")
    .replace(/^(?:please|sila|tolong|من فضلك)\s+/u, "")
    .replace(/[\s?!.,;:।؟]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  for (const [cmd, re] of CMD) if (re.test(t)) return cmd;
  return null;
}
