"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { resolveContext, type LastTaught, type PresentContext } from "@/utils/present/context";
import type { SkSelection } from "@/sk/shell/types";
import { deepLinkStartable, parsePresentDeepLink } from "./deep-link";
import type { Dictionary } from "@/i18n/dictionaries";
import { fmt } from "@/i18n/format";
import type { TourCopy } from "@/tour/definitions";
import SkLauncher from "@/app/dashboard/sk-launcher";
import type { SkShellCopy } from "@/app/dashboard/sk-shell";
import BoardSession, { type SessionInfo, type SessionKit } from "./board-session";
import type { BoardController, BoardUnit } from "./board-controller";
import { createBoardBridge, loadManifest, toBridgeManifest, type BridgeManifest, type BridgeRun, type ManifestReply, type ManifestStatus } from "./sk-board-bridge";
import { prepareDeck, type DeckPagesReply, type DeckStatus } from "./deck-load";
import { activeSelection, createAskChannel, type HeldSelection, type SkSelectionPayload } from "./highlight-select";
import { docLabel, docNote, groupLabel, scopeLabel, unitLabel } from "./words";
import { menuItemsFor, type MenuItem } from "./menu-items";
import { RAIL_CLOSED, railReduce } from "./rail-state";
import type { Slot, TimetableShape } from "@/utils/timetable";

// The context bar and the kit rail.
//
// THE CLOCK IS THE PANEL'S. The context is resolved here rather than on the
// server because the server is in UTC and the classroom is not. A period is a
// local-time fact.
//
// The bar reports its own confidence rather than presenting a guess with the
// same weight as a fact. Her timetable naming the class is one thing; a
// remembered pointer suggesting a chapter is another; and having nothing at all
// — the permanent state of every independent teacher — is a third that has to
// look deliberate rather than broken.
//
// EVERY WORD ON THIS PAGE ARRIVES AS A PROP. The dictionary is resolved by the
// server shell and handed down, because dictionaries.ts is server-only and ten
// message files have no business in the browser bundle. Anything the API used to
// compose in English — a doc's label, "Part 1 of 4", "Chapter 4 · Part 2" —
// now arrives as a place or a kind and is turned into words in ./words.ts.

export type ClassName = { id: string; name: string; grade: string | null };
export type BookOption = {
  id: string;
  title: string;
  grade: string | null;
  subject: string | null;
  chapters: { num: number; title?: string }[];
};

/** A ready-made kit: one entry per title prefix, keyed by its presentation. */
export type KitOption = { id: string; title: string };

/** Exactly what /api/present/kit returns, and exactly what the board consumes. */
type Kit = SessionKit;

export type PresentWords = Dictionary["present"];

/** S1: what the server hands down when the SK Shell is on for this user. */
export type PresentSk = {
  copy: SkShellCopy;
  tourCopy: TourCopy;
  role: string | null;
  hat: string | null;
};

type Props = {
  teacherId: string;
  teacherName: string | null;
  /** Resolved on the server and handed down, so ten message files never reach
   *  the browser bundle. */
  t: PresentWords;
  shape: TimetableShape;
  slots: Slot[];
  classes: ClassName[];
  lastTaught: LastTaught[];
  books: BookOption[];
  /** Her ready-made kits (book-less presentations), newest first. */
  kits?: KitOption[];
  /** Null when the Shell is off (gates in page.tsx). */
  sk?: PresentSk | null;
  /** Board UX (2026-10-28): the portal's tabs for the current hat, as the app
   *  header computes them (page.tsx), for the Board's menu. Labels already
   *  translated; /present itself is dropped by menuItemsFor. */
  tabs?: MenuItem[];
};

/** GET/POST /api/sk/manifest (slice A's contract) as the bridge's fetch. */
async function fetchManifest(generationId: string, method: "GET" | "POST"): Promise<ManifestReply> {
  const q = new URLSearchParams({ generationId });
  const r = await fetch(`/api/sk/manifest?${q.toString()}`, { method });
  if (r.status === 404) return { status: "missing" };
  if (!r.ok) throw new Error(`manifest ${r.status}`);
  const j = (await r.json()) as ManifestReply;
  return j && typeof j.status === "string" ? j : { status: "failed" };
}

/** GET/POST /api/present/deck-pages as prepareDeck's fetch. A 404 (not her
 *  deck, no .pptx) is an error, not "missing": there is nothing to ask for. */
async function fetchDeckPages(generationId: string, method: "GET" | "POST"): Promise<DeckPagesReply> {
  const r =
    method === "GET"
      ? await fetch(`/api/present/deck-pages?${new URLSearchParams({ generationId }).toString()}`)
      : await fetch("/api/present/deck-pages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ generationId }) });
  if (!r.ok) throw new Error(`deck pages ${r.status}`);
  const j = (await r.json()) as DeckPagesReply;
  if (!j || (j.status !== "ready" && j.status !== "building" && j.status !== "missing")) throw new Error("deck pages: bad reply");
  return j;
}

// ── the clock ────────────────────────────────────────────────────────────────
//
// A ticking clock is an external system, so it is read through
// useSyncExternalStore rather than pushed into state from an effect. The
// snapshot keeps a STABLE identity between minutes: returning a fresh object on
// every call would re-render for ever, and returning a new Date() would do it
// sixty times a second.

/** JS Sunday=0; timetable_slots uses Monday=1. */
const timetableDay = (d: Date) => ((d.getDay() + 6) % 7) + 1;

export type ClockTime = { day: number; minutes: number };

let clock: ClockTime | null = null;
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;

function readClock(): ClockTime {
  const d = new Date();
  return { day: timetableDay(d), minutes: d.getHours() * 60 + d.getMinutes() };
}

function subscribeClock(cb: () => void): () => void {
  clockListeners.add(cb);
  if (!clockTimer) {
    clock ??= readClock();
    // Thirty seconds: a period boundary must not need a reload to show up — she
    // opens the board during the interval and teaches through the bell.
    clockTimer = setInterval(() => {
      const next = readClock();
      if (clock && next.day === clock.day && next.minutes === clock.minutes) return;
      clock = next;
      for (const l of clockListeners) l();
    }, 30_000);
  }
  return () => {
    clockListeners.delete(cb);
    if (!clockListeners.size && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

const clockSnapshot = (): ClockTime => (clock ??= readClock());
/** The server has no business rendering a period — it is eight hours away. */
const clockServerSnapshot = (): ClockTime | null => null;

export default function PresentClient({
  teacherId,
  teacherName,
  t,
  shape,
  slots,
  classes,
  lastTaught,
  books,
  kits = [],
  sk = null,
  tabs = [],
}: Props) {
  const now = useSyncExternalStore(subscribeClock, clockSnapshot, clockServerSnapshot);

  const ctx: PresentContext | null = useMemo(() => {
    if (!now) return null;
    return resolveContext({ teacherId, shape, slots, lastTaught, day: now.day, minutes: now.minutes });
  }, [now, teacherId, shape, slots, lastTaught]);

  // DERIVED, not synced. An effect copying the suggestion into state would have
  // to be careful never to overwrite a choice she had already made; a null
  // `pick` meaning "she has not chosen" needs no such care, and it makes
  // "explicitly cleared" a state the suggestion cannot quietly undo.
  // A pick is a book + chapter OR a ready-made kit (a book-less catalogue kit
  // in her library); choosing one clears the other, since a lesson is on one.
  //
  // THE DEEP LINK IS A SECOND DEFAULT LAYER, derived like the suggestion and
  // never copied into state: `/present?class=…&book=…&chapter=…` (or `?kit=…`)
  // is how SK "opens the Board and starts with the video" from nothing (Final
  // Plan §2.7) and how it starts the bar's own pick from this very page — a
  // router.push with a new query changes `search` and nothing re-mounts. Ids
  // not in the page's own lists are dropped (deep-link.ts). Her pick is KEYED
  // TO THE QUERY it was made under, so a new link is not quietly overridden by
  // a choice made before it, while under one query her choice still wins.
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? "";
  const link = useMemo(() => parsePresentDeepLink(search, { classes, books, kits }), [search, classes, books, kits]);
  const linkPick = link.kitId
    ? { book: null, chapter: null, kit: link.kitId }
    : link.bookId
      ? { book: link.bookId, chapter: link.chapterNum ?? null, kit: null }
      : null;

  type Pick = { book: string | null; chapter: number | null; kit: string | null };
  const [pickState, setPickState] = useState<(Pick & { search: string }) | null>(null);
  const pick: Pick | null = pickState && pickState.search === search ? pickState : null;
  const setPick = useCallback((p: Pick) => setPickState({ ...p, search }), [search]);
  const kitId = pick ? pick.kit : (linkPick?.kit ?? null);
  const bookId = kitId ? null : pick ? pick.book : linkPick ? linkPick.book : (ctx?.suggestion?.bookId ?? null);
  const chapter = kitId ? null : pick ? pick.chapter : linkPick ? linkPick.chapter : (ctx?.suggestion?.chapterNum ?? null);
  const kitPick = kits.find((k) => k.id === kitId) ?? null;

  // WHICH CLASS. The timetable names it when there is one; otherwise she picks,
  // and she has to be able to — an independent teacher has classes and no
  // timetable, and a lesson with no class has nobody to publish the note to.
  // That refusal is enforced server-side (checkPublish -> "no-audience"), so
  // the picker is what stops her meeting it after the lesson rather than before.
  // HER CHOICE FIRST. The timetable is a default she can see and change, not a
  // value that reclaims the field: the clock keeps resolving, so `ctx.classId`
  // winning would silently replace a class she picked for a covering lesson the
  // moment the period rolled over — and the picker was hidden whenever the
  // timetable had an opinion, so she could not have seen it happen.
  // The deep link's class sits between her choice and the timetable's.
  const [pickedClassState, setPickedClassState] = useState<{ id: string | null; search: string } | null>(null);
  const pickedClass = pickedClassState && pickedClassState.search === search ? pickedClassState.id : null;
  const setPickedClass = useCallback((id: string | null) => setPickedClassState({ id, search }), [search]);
  const classId = pickedClass ?? link.classId ?? ctx?.classId ?? null;
  const klass = classes.find((c) => c.id === classId) ?? null;
  const book = books.find((b) => b.id === bookId) ?? null;
  const chapters = book?.chapters ?? [];

  // SHE PICKS A CHAPTER, NOT A PART. A long chapter is split into parts at index
  // time and every kit is generated per part, so a rail that matched only
  // part-less generations would find nothing at all and read "nothing generated
  // for this chapter yet" while sitting on a full set. The rail returns every
  // unit in the chapter instead, and she opens one once the board is running —
  // which is also when she actually knows, since a period often spans two.
  const ready = (!!bookId && chapter !== null) || !!kitPick;

  // The running lesson. Declared here rather than beside its own handlers
  // because the kit fetch below has to know whether one exists.
  const [session, setSession] = useState<SessionInfo | null>(null);

  // ONCE A LESSON IS RUNNING, THE CHOICE IS FIXED.
  //
  // `ctx` is recomputed every time the 30-second clock crosses a minute, and
  // `bookId`/`chapter` fall back to `ctx.suggestion` — which is the whole point
  // of the bar before a lesson and a hazard during one. Crossing a period
  // boundary mid-lesson is the case this feature is explicitly built for ("she
  // opens the board during the interval and teaches through the bell"), and it
  // is exactly when the suggestion changes: the kit key would change, the kit
  // would go null for a render, and <Stage src> would lose its source — the one
  // thing stage.tsx forbids, because it reloads the video in front of the class.
  // Worse quietly: a kit reloaded for a different chapter makes the rail's first
  // unit a part she never taught, which is what the pointer would then record.
  //
  // So the session carries its own book and chapter, and while it exists nothing
  // else is consulted.
  const locked = !!session;
  const liveBook = session ? session.bookId : bookId;
  const liveChapter = session ? session.chapterNum : chapter;
  const liveKit = session ? (session.kitId ?? null) : kitPick?.id ?? null;

  // The rail, fetched once she has named a book and chapter.
  //
  // THE RESULT CARRIES THE SELECTION IT WAS FETCHED FOR, and what renders is
  // whatever matches the CURRENT one. That does two jobs with one mechanism.
  // It keeps every setState on an async path — clearing state synchronously in
  // an effect cascades a render, and React's compiler refuses it. And it makes
  // a late response from a superseded selection structurally unable to land: a
  // `live` flag closes the window, a key comparison closes the question.
  const key = liveKit ? `kit|${liveKit}` : liveBook && liveChapter !== null ? `${liveBook}|${liveChapter}` : null;
  const [loaded, setLoaded] = useState<{ key: string; kit: Kit | null; error: string | null } | null>(
    null,
  );
  useEffect(() => {
    if (!key) return;
    let live = true;
    const q = liveKit ? new URLSearchParams({ kit: liveKit }) : new URLSearchParams({ book: liveBook ?? "", chapter: String(liveChapter) });
    fetch(`/api/present/kit?${q.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? t.kit.unavailable : `Failed (${r.status})`);
        return (await r.json()) as Kit;
      })
      .then((k) => {
        if (live) setLoaded({ key, kit: k, error: null });
      })
      .catch((e: unknown) => {
        // A rail that fails silently looks like a chapter with no kit, which is
        // a very different thing from a request that broke.
        if (live) {
          setLoaded({ key, kit: null, error: e instanceof Error ? e.message : t.kit.failed });
        }
      });
    return () => {
      live = false;
    };
  }, [key, liveKit, liveBook, liveChapter, t]);

  const current = loaded && loaded.key === key ? loaded : null;
  const kit = current?.kit ?? null;
  const kitError = current?.error ?? null;
  const loading = !!key && !current;

  // The running lesson. Starting one is a server round trip because the session
  // id is what every later write is scoped to — strokes, items, the close.
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const start = useCallback(async () => {
    const kit = kitPick?.id ?? null;
    if (!kit && (!bookId || chapter === null)) return;
    setStarting(true);
    setStartError(null);
    try {
      const r = await fetch("/api/present/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // A ready-made kit has no book and no chapter: the kit's presentation
          // id is the lesson's key and the server sets the subject to its name.
          ...(kit ? { kitId: kit } : { bookId, chapterNum: chapter }),
          classId,
          subject: ctx?.subject ?? klass?.name ?? null,
          slotDay: ctx?.day ?? null,
          slotPeriod: ctx?.period?.period ?? null,
        }),
      });
      const d = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!r.ok || !d.id) throw new Error(d.error || `Could not start (${r.status})`);
      setSession(kit ? { id: d.id, teacherId, bookId: null, chapterNum: null, kitId: kit } : { id: d.id, teacherId, bookId, chapterNum: chapter });
    } catch (e) {
      // Starting is the one action where a silent failure is unacceptable: she
      // taps it and turns to the class.
      setStartError(e instanceof Error ? e.message : t.start.failed);
    } finally {
      setStarting(false);
    }
  }, [bookId, chapter, kitPick, ctx, classId, klass, teacherId, t]);

  // The unit rail overlay's state (Board UX 2026-10-28; see below). Declared
  // here so ending a lesson can shut it: the next lesson starts with it closed.
  const [rail, railDispatch] = useReducer(railReduce, RAIL_CLOSED);
  const endSession = useCallback(() => {
    setSession(null);
    railDispatch("close");
  }, [railDispatch]);

  // ── autostart (Final Plan §2.7) ──────────────────────────────────────────
  //
  // `&autostart=1` on a link that resolves whole starts the lesson ONCE per
  // distinct query, and only while none is running: a session ending under
  // the same query must not start another, and a later session must not
  // re-read the link. The pick is derived above, so start() already sees it;
  // one tick's deferral keeps the start out of the effect's own render pass.
  const startedFor = useRef<string | null>(null);
  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  }, [start]);
  useEffect(() => {
    if (!search || !link.autostart || !deepLinkStartable(link) || session || startedFor.current === search) return;
    startedFor.current = search;
    const id = setTimeout(() => void startRef.current(), 0);
    return () => clearTimeout(id);
  }, [search, link, session]);

  // ── SK on the Board (S1) ──────────────────────────────────────────────────
  //
  // The BoardController is BoardSession's (merged M2) and arrives through a
  // callback ref into STATE, so the bridge is rebuilt (not mutated) when the
  // session starts or ends and nothing reads a ref during render.
  // Which unit is open is BoardSession's state: it reports every switch through
  // `onUnit` (S1 slice C) and answers the controller's `getUnit()` on demand, so
  // nothing here is inferred from the audit sink any more.
  const [controller, setController] = useState<BoardController | null>(null);
  const controllerRef = useCallback((c: BoardController | null) => setController(c), []);
  const [openUnit, setOpenUnit] = useState<BoardUnit | null>(null);
  const unitGen = session ? (openUnit?.generationId ?? null) : null;
  const unitPart = session ? (openUnit?.part ?? null) : null;

  // The lesson map for the open unit: fetched (and polled while building)
  // whenever the unit's video changes. The result carries the generation it
  // was fetched for, so a late reply for a unit she has left cannot land, and
  // the status before the first reply is derived ("building"), not synced.
  const [lesson, setLesson] = useState<{ gen: string; manifest: BridgeManifest | null; status: ManifestStatus } | null>(null);
  useEffect(() => {
    if (!sk || !unitGen) return;
    const gen = unitGen;
    const part = unitPart;
    const ac = new AbortController();
    void loadManifest(fetchManifest, gen, {
      signal: ac.signal,
      onStatus: (s) => {
        if (!ac.signal.aborted && s !== "ready") setLesson({ gen, manifest: null, status: s });
      },
    }).then((r) => {
      if (ac.signal.aborted) return;
      if (r.status !== "ready") {
        setLesson({ gen, manifest: null, status: "failed" });
        return;
      }
      try {
        setLesson({ gen, manifest: toBridgeManifest(r.manifest, part), status: "ready" });
      } catch {
        setLesson({ gen, manifest: null, status: "failed" });
      }
    });
    return () => ac.abort();
  }, [sk, unitGen, unitPart]);
  const lessonNow = lesson && lesson.gen === unitGen ? lesson : null;
  const manifest = lessonNow?.manifest ?? null;
  const mapStatus: ManifestStatus = !unitGen ? "none" : lessonNow ? lessonNow.status : "building";

  // The bar's pick, for SK's collector: with no lesson running, "start the
  // video" can start THIS lesson rather than asking what to teach. Ids only.
  const selection = useMemo<SkSelection | undefined>(() => {
    if (session) return undefined;
    const sel: SkSelection = {};
    if (classId) sel.classId = classId;
    if (kitPick) sel.generationId = kitPick.id;
    else {
      if (bookId) sel.bookId = bookId;
      if (bookId && chapter !== null) sel.chapterRef = String(chapter);
    }
    return Object.keys(sel).length ? sel : undefined;
  }, [session, classId, kitPick, bookId, chapter]);

  // ── Board UX (2026-10-28) ──────────────────────────────────────────────
  //
  // The unit rail overlay: one state for the handle, the overlay and SK's
  // `rail` move (rail-state.ts). The bridge reads it through a stable getter
  // (a closure box made once, kept current by an effect), so it is not rebuilt
  // every time the rail opens and no ref is read during render.
  const [railBox] = useState(() => {
    let open = false;
    return { get: () => open, set: (v: boolean) => void (open = v) };
  });
  useEffect(() => {
    railBox.set(rail.open);
  }, [railBox, rail.open]);

  // The slides load (k of n while it runs, then where the pages landed), for
  // the Board's own status line. The panel's tray reads the bridge directly.
  const [slideLoad, setSlideLoad] = useState<{ k: number; n: number } | null>(null);
  const [slidesDone, setSlidesDone] = useState<{ n: number; a: number; b: number } | null>(null);

  // ── The kit's .pptx as pages (founder 2026-10-28) ──────────────────────
  //
  // The open unit's deck (its `deck` doc), whether its rendered pages exist,
  // and the one path that loads them — shared by the rail's "Load the deck as
  // pages" and SK's `load_deck`, so the two can never disagree. The status is
  // looked up once per deck (a GET, never a POST: nothing is rendered until
  // she asks) so SK's "skip to the PowerPoint" knows whether the deck is there.
  const deckGen = useMemo(() => {
    if (!session || !kit) return null;
    const u =
      kit.units.find((x) => openUnit && x.part === openUnit.part && (x.video?.id ?? null) === openUnit.generationId) ??
      kit.units.find((x) => openUnit && x.part === openUnit.part) ??
      kit.units[0];
    return u?.docs.find((d) => d.note === "deck")?.id ?? null;
  }, [session, kit, openUnit]);
  const [deck, setDeck] = useState<{ gen: string; status: DeckStatus } | null>(null);
  /** The deck a load is under way for (the status line shows only then). */
  const [deckBusy, setDeckBusy] = useState<string | null>(null);
  const [deckFailed, setDeckFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!sk || !deckGen) return;
    const gen = deckGen;
    let live = true;
    fetchDeckPages(gen, "GET")
      .then((r) => {
        if (live) setDeck((d) => (d?.gen === gen && d.status === "loaded" ? d : { gen, status: r.status }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [sk, deckGen]);
  const deckStatus: DeckStatus = deckGen && deck?.gen === deckGen ? deck.status : "none";
  // The load under way, so a second press (or SK) restarts rather than races.
  // A box in state, not a ref: the bridge holds runDeck and is built in render.
  const [deckRun] = useState(() => {
    let ac: AbortController | null = null;
    return {
      /** Abort the running load, if any, and start a new one. */
      next: () => {
        ac?.abort();
        ac = new AbortController();
        return ac;
      },
      stop: () => ac?.abort(),
    };
  });
  const runDeck = useCallback(
    async (gen: string): Promise<BridgeRun> => {
      const c = controller;
      if (!c?.loadDeck) return { ok: false, summary: "Open the Board first." };
      try {
        // Already on the roll: go to its first page rather than load it twice.
        if (c.findDeckPage?.(1, gen) != null && c.goToDeckPage) {
          const page = c.goToDeckPage(1, gen);
          return { ok: true, summary: `The deck is on the roll; slide 1 is page ${page + 1}.` };
        }
        const ac = deckRun.next();
        setDeckBusy(gen);
        setDeckFailed(null);
        const r = await prepareDeck(fetchDeckPages, gen, {
          signal: ac.signal,
          onStatus: (st) => {
            if (!ac.signal.aborted) setDeck({ gen, status: st });
          },
        });
        if (r.status !== "ready") {
          if (r.reason !== "aborted") setDeckFailed(gen);
          return { ok: false, summary: r.reason === "timeout" ? "The deck is taking too long to prepare." : "The deck could not be prepared." };
        }
        const res = await c.loadDeck({ generationId: gen, slides: r.slides, map: r.map, signal: ac.signal });
        if (!res.pages) return { ok: false, summary: "Stopped before the first slide." };
        setDeck({ gen, status: "loaded" });
        const a = res.firstPage + 1;
        const b = res.lastPage + 1;
        return { ok: true, summary: `The deck is on the roll as pages ${a}–${b}.`, loaded: { n: res.pages, a, b, aborted: res.aborted } };
      } catch (e) {
        setDeckFailed(gen);
        return { ok: false, summary: e instanceof Error ? e.message : String(e) };
      } finally {
        setDeckBusy((g) => (g === gen ? null : g));
      }
    },
    [controller, deckRun],
  );
  useEffect(() => () => deckRun.stop(), [deckRun]);
  const deckPort = useMemo(
    () => (deckGen ? { status: () => deckStatus, load: () => runDeck(deckGen) } : undefined),
    [deckGen, deckStatus, runDeck],
  );

  // "Highlight a portion and ask SK" (founder 2026-10-28). The Board reports
  // the words under her latest highlighter stroke on a deck page; the bridge
  // reads them (60 s window) into every turn's state, and the chip's click
  // goes to the panel through the ask channel — both made ONCE (closure boxes
  // in state), so a bridge rebuilt in between loses neither.
  const [highlightBox] = useState(() => {
    let held: HeldSelection | null = null;
    return { get: () => held, set: (h: HeldSelection | null) => void (held = h) };
  });
  const [askChannel] = useState(() => createAskChannel());
  const onHighlight = useCallback(
    (sel: SkSelectionPayload | null) => highlightBox.set(sel ? { selection: sel, at: Date.now() } : null),
    [highlightBox],
  );
  const onAskSelection = useCallback(() => askChannel.post("explain_selection"), [askChannel]);

  // Rebuilt whenever what it reads changes; the old one's segment watcher is
  // disposed with it (a unit or session change ends the watch anyway). The
  // selection only changes BEFORE a lesson, when no watcher can be running.
  const bridge = useMemo(
    () =>
      sk
        ? createBoardBridge({
            controller: () => controller,
            manifest: () => manifest,
            mapStatus: () => mapStatus,
            selection: () => selection,
            rail: (open) => railDispatch(open ? "open" : "close"),
            railOpen: railBox.get,
            onLoading: setSlideLoad,
            deck: deckPort,
            highlight: () => activeSelection(highlightBox.get(), Date.now()),
            asks: askChannel,
          })
        : null,
    [sk, controller, manifest, mapStatus, selection, railBox, railDispatch, deckPort, highlightBox, askChannel],
  );
  useEffect(() => () => bridge?.dispose(), [bridge]);

  // "Load slides as pages" from the rail: the same move SK runs, through the
  // same bridge, so the panel's tray and the Board show one load. Offered only
  // with the lesson map in hand: the slides ARE its segments.
  const loadSlides = useMemo(
    () =>
      bridge && manifest && manifest.segments.length
        ? () => {
            setSlidesDone(null);
            void bridge.run("load_slides", {}).then((r) => {
              if (r.ok && r.loaded) setSlidesDone({ n: r.loaded.n, a: r.loaded.a, b: r.loaded.b });
            });
          }
        : undefined,
    [bridge, manifest],
  );
  // The rail's "Load the deck as pages": the same runDeck SK uses. Its line
  // under the roll: preparing while the worker renders, then where the pages
  // landed (SK's own words for that, when SK is on), or that it failed.
  const loadDeck = useCallback(
    (gen: string) => {
      setSlidesDone(null);
      void runDeck(gen).then((r) => {
        if (r.ok && r.loaded) setSlidesDone({ n: r.loaded.n, a: r.loaded.a, b: r.loaded.b });
      });
    },
    [runDeck],
  );
  const deckLine =
    deckBusy && deckBusy === deckGen && deckStatus === "building"
      ? t.bar.preparingDeck
      : deckFailed && deckFailed === deckGen && !deckBusy
        ? t.bar.deckFailed
        : null;
  const slideStatus =
    sk && slideLoad
      ? fmt(sk.copy.loadingSlides, { k: slideLoad.k, n: slideLoad.n })
      : deckLine
        ? deckLine
        : sk && slidesDone
          ? fmt(sk.copy.slidesLoaded, slidesDone)
          : null;

  // The Board's menu: "Back to dashboard", then the portal's tabs.
  const menu = useMemo(() => menuItemsFor(tabs, { href: "/dashboard", label: t.bar.backToDashboard }), [tabs, t]);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <main className="min-h-dvh bg-[#0F1417] text-[#E7EDE9]">
      {/* Dark, because it sits above a lit board in a room with the lights down,
          and because it must read from the back of the class. */}
      <header className="flex flex-wrap items-center gap-2 border-b border-[#222C30] px-3 py-2">
        {/* The Board has no app header (Board UX 2026-10-28, founder): the way
            back to the portal is this menu. Plain links. Above the stage (z 30)
            and the rail overlay, below the SK panel (z 50). */}
        <div className="relative">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            className="rounded-lg border border-[#2A363B] bg-[#141B1F] px-3 py-2 text-sm text-[#C2CCC7]"
            data-board="menu"
          >
            ≡ {t.bar.menu}
          </button>
          {menuOpen && (
            <>
              <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-[41] cursor-default" onClick={() => setMenuOpen(false)} />
              <nav role="menu" className="absolute start-0 top-full z-[42] mt-1 grid min-w-[220px] gap-0.5 rounded-xl border border-[#2A363B] bg-[#141B1F] p-1 shadow-2xl">
                {menu.map((m, i) => (
                  <a
                    key={m.href}
                    role="menuitem"
                    href={m.href}
                    className={`rounded-lg px-3 py-2 text-sm hover:bg-[#1C2529] ${i === 0 ? "text-[#4FD6C2]" : "text-[#E7EDE9]"}`}
                  >
                    {m.label}
                  </a>
                ))}
              </nav>
            </>
          )}
        </div>
        <Chip label={t.bar.grade} value={klass?.grade ?? "—"} />
        <Chip label={t.bar.subject} value={ctx?.subject ?? "—"} />
        <select
          aria-label={t.bar.class}
          value={classId ?? ""}
          disabled={locked}
          onChange={(e) => setPickedClass(e.target.value || null)}
          className="rounded-lg border border-[#2A363B] bg-[#141B1F] px-3 py-2 text-sm disabled:opacity-60"
        >
          <option value="">{t.bar.noClass}</option>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.grade ? `${c.name} · ${c.grade}` : c.name}
            </option>
          ))}
        </select>

        <select
          aria-label={t.bar.book}
          value={bookId ?? ""}
          disabled={locked}
          onChange={(e) => setPick({ book: e.target.value || null, chapter: null, kit: null })}
          className="rounded-lg border border-[#2A363B] bg-[#141B1F] px-3 py-2 text-sm disabled:opacity-60"
        >
          <option value="">{t.bar.chooseBook}</option>
          {books.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
            </option>
          ))}
        </select>

        <select
          aria-label={t.bar.chapter}
          value={chapter ?? ""}
          disabled={locked || !book}
          onChange={(e) =>
            setPick({ book: bookId, chapter: e.target.value === "" ? null : Number(e.target.value), kit: null })
          }
          className="rounded-lg border border-[#2A363B] bg-[#141B1F] px-3 py-2 text-sm disabled:opacity-40"
        >
          <option value="">{t.bar.chooseChapter}</option>
          {chapters.map((c) => (
            <option key={c.num} value={c.num}>
              {/* chapter_ref is 0-based in the database and rendered +1. */}
              {c.title ? `${c.num + 1}. ${c.title}` : fmt(t.bar.chapterN, { n: c.num + 1 })}
            </option>
          ))}
        </select>

        {/* READY-MADE KITS: catalogue kits copied into the library have no book
            and no chapter, so the two pickers above can never reach them. One
            entry per kit, keyed by its presentation. Only rendered when she has
            any — an independent teacher with no kits sees the bar unchanged. */}
        {kits.length > 0 && (
          <select
            aria-label={t.bar.kit}
            value={kitId ?? ""}
            disabled={locked}
            onChange={(e) => setPick(e.target.value ? { book: null, chapter: null, kit: e.target.value } : { book: null, chapter: null, kit: null })}
            className="rounded-lg border border-[#2A363B] bg-[#141B1F] px-3 py-2 text-sm disabled:opacity-60"
          >
            <option value="">{t.bar.chooseKit}</option>
            {kits.map((k) => (
              <option key={k.id} value={k.id}>
                {k.title}
              </option>
            ))}
          </select>
        )}

        <Confidence t={t} ctx={ctx} />

        <div className="ms-auto text-end font-mono text-[11px] leading-tight text-[#93A09A]">
          <div>{teacherName ?? ""}</div>
          <div>
            {ctx?.period ? `${ctx.period.label} · ${ctx.timeLabel}` : now ? t.bar.outsideHours : "…"}
          </div>
        </div>
      </header>

      {session ? (
        <BoardSession
          session={session}
          kit={kit}
          t={t}
          onEnd={endSession}
          controllerRef={controllerRef}
          onUnit={setOpenUnit}
          railOpen={rail.open}
          onRail={railDispatch}
          onLoadSlides={loadSlides}
          slideStatus={slideStatus}
          onLoadDeck={loadDeck}
          onHighlight={sk ? onHighlight : undefined}
          onAskSelection={sk ? onAskSelection : undefined}
        />
      ) : ready ? (
        <section className="grid gap-3 p-3 lg:grid-cols-[260px_1fr]">
          <aside className="grid content-start gap-2">
            <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#5F6F69]">
              {t.kit.heading}
            </h2>
            {loading && <p className="text-sm text-[#93A09A]">{t.kit.loading}</p>}
            {kitError && <p className="text-sm text-[#E58A93]">{kitError}</p>}

            {kit?.units.map((u) => (
              <div key={u.part === null ? "whole" : u.part} className="grid gap-1">
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#5F6F69]">
                  {unitLabel(t, u)}
                </p>
                {u.video && (
                  <div className="rounded-xl border border-[#17544C] bg-[#12302C] px-3 py-3 text-sm text-[#4FD6C2]">
                    ▶ {t.doc.presentation}
                    <span className="mt-0.5 block font-mono text-[10px] opacity-70">
                      {u.video.urls.length > 1
                        ? fmt(t.kit.videoParts, { n: u.video.urls.length })
                        : t.kit.videoReady}
                    </span>
                  </div>
                )}
                {u.docs.map((d) => (
                  <div
                    key={d.id}
                    className={`rounded-xl border px-3 py-3 text-sm ${
                      d.projects
                        ? "border-[#2A363B] bg-[#141B1F] text-[#E7EDE9]"
                        : "border-[#2A363B] bg-[#0F1417] text-[#7C8A85]"
                    }`}
                  >
                    {d.note === "deck" ? "⤓ " : ""}
                    {docLabel(t, d.kind)}
                    {d.note && (
                      <span className="mt-0.5 block font-mono text-[10px] leading-snug text-[#5F6F69]">
                        {docNote(t, d.note)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}

            {kit && !kit.units.length && (
              <p className="text-sm text-[#93A09A]">{t.kit.empty}</p>
            )}

            {/* Listed, not tappable: opening one is something the running board
                does, and a button here that only highlighted itself would be a
                control that looked like it had done something. */}
            {!!kit?.picker.length && (
              <>
                <h2 className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[#5F6F69]">
                  {t.kit.alsoAvailable}
                </h2>
                {kit.picker.map((g) => (
                  <div key={g.group} className="grid gap-1">
                    <p className="font-mono text-[10px] text-[#5F6F69]">{groupLabel(t, g.group)}</p>
                    {g.items.map((i) => (
                      <p key={i.id} className="text-sm text-[#93A09A]">
                        {scopeLabel(t, i.scope, i.title)}
                      </p>
                    ))}
                  </div>
                ))}
              </>
            )}
          </aside>

          <div className="grid place-items-center rounded-xl border border-[#222C30] bg-[#0B0F11] p-6 text-center">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{t.start.ready}</h1>
              <p className="mt-2 max-w-md text-sm text-[#93A09A]">
                {t.start.readyBody}
              </p>
              {/* Said BEFORE she teaches, not after. The publish step refuses a
                  lesson with no class, and meeting that refusal at the bell — with
                  the note already written — would be the wrong moment to learn it. */}
              {!classId && (
                <p className="mx-auto mt-3 max-w-md rounded-lg border border-[#4A3A1C] bg-[#2C2318] px-3 py-2 text-sm text-[#E0A664]">
                  {t.start.noAudience}
                </p>
              )}
              <button
                type="button"
                onClick={start}
                disabled={starting}
                className="mt-5 rounded-xl bg-[#0C8175] px-6 py-3 text-sm font-medium text-white disabled:opacity-50"
              >
                {starting ? t.start.starting : t.start.cta}
              </button>
              {startError && <p className="mt-3 text-sm text-[#E58A93]">{startError}</p>}
            </div>
          </div>
        </section>
      ) : (
        <section className="grid place-items-center px-4" style={{ minHeight: "70dvh" }}>
          <div className="text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#5F6F69]">
              {t.title}
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">
              {t.start.heading}
            </h1>
            <p className="mt-2 max-w-md text-sm text-[#93A09A]">
              {ctx?.confidence === "slot"
                ? t.start.hintSlot
                : ctx?.confidence === "period"
                  ? t.start.hintPeriod
                  : t.start.hintNone}
            </p>
          </div>
        </section>
      )}

      {/* SK Shell on the Board (S1): bottom-start, clear of the Stage's
          bottom-end corner video. Mounted with the bridge whether or not a
          lesson is running — before one, the Shell navigates and answers;
          its Board moves need the session. */}
      {sk && bridge && <SkLauncher copy={sk.copy} tourCopy={sk.tourCopy} role={sk.role} hat={sk.hat} introDue={false} board={bridge} />}
    </main>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-2 rounded-lg border border-[#2A363B] bg-[#141B1F] px-3 py-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[#5F6F69]">{label}</span>
      <span className="text-sm">{value}</span>
    </span>
  );
}

/** How much of the bar is actually known. A guess must not look like a fact. */
function Confidence({ t, ctx }: { t: PresentWords; ctx: PresentContext | null }) {
  if (!ctx) return null;
  const map = {
    slot: { text: t.bar.fromTimetable, cls: "border-[#17544C] bg-[#12302C] text-[#4FD6C2]" },
    period: { text: t.bar.freePeriod, cls: "border-[#4A3A1C] bg-[#2C2318] text-[#E0A664]" },
    none: { text: t.bar.pickManually, cls: "border-[#2A363B] bg-[#141B1F] text-[#93A09A]" },
  }[ctx.confidence];
  return (
    <span className={`rounded-lg border px-3 py-2 text-sm ${map.cls}`}>
      {ctx.confidence === "slot" ? "● " : ""}
      {map.text}
    </span>
  );
}
