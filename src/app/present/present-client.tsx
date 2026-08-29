"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { resolveContext, type LastTaught, type PresentContext } from "@/utils/present/context";
import { GROUP_LABEL } from "@/utils/present/kit";
import BoardSession, { type SessionInfo, type SessionKit } from "./board-session";
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
// Not translated yet: Present mode is behind a single-account allowlist, and the
// ten locales land when it reaches a second teacher. English is the fallback
// base in this repo, so that is additive rather than a rewrite.

export type ClassName = { id: string; name: string; grade: string | null };
export type BookOption = {
  id: string;
  title: string;
  grade: string | null;
  subject: string | null;
  chapters: { num: number; title?: string }[];
};

/** Exactly what /api/present/kit returns, and exactly what the board consumes. */
type Kit = SessionKit;

type Props = {
  teacherId: string;
  teacherName: string | null;
  shape: TimetableShape;
  slots: Slot[];
  classes: ClassName[];
  lastTaught: LastTaught[];
  books: BookOption[];
};

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
  shape,
  slots,
  classes,
  lastTaught,
  books,
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
  const [pick, setPick] = useState<{ book: string | null; chapter: number | null } | null>(null);
  const bookId = pick ? pick.book : (ctx?.suggestion?.bookId ?? null);
  const chapter = pick ? pick.chapter : (ctx?.suggestion?.chapterNum ?? null);

  const klass = classes.find((c) => c.id === ctx?.classId) ?? null;
  const book = books.find((b) => b.id === bookId) ?? null;
  const chapters = book?.chapters ?? [];

  // SHE PICKS A CHAPTER, NOT A PART. A long chapter is split into parts at index
  // time and every kit is generated per part, so a rail that matched only
  // part-less generations would find nothing at all and read "nothing generated
  // for this chapter yet" while sitting on a full set. The rail returns every
  // unit in the chapter instead, and she opens one once the board is running —
  // which is also when she actually knows, since a period often spans two.
  const ready = !!bookId && chapter !== null;

  // The rail, fetched once she has named a book and chapter.
  //
  // THE RESULT CARRIES THE SELECTION IT WAS FETCHED FOR, and what renders is
  // whatever matches the CURRENT one. That does two jobs with one mechanism.
  // It keeps every setState on an async path — clearing state synchronously in
  // an effect cascades a render, and React's compiler refuses it. And it makes
  // a late response from a superseded selection structurally unable to land: a
  // `live` flag closes the window, a key comparison closes the question.
  const key = bookId && chapter !== null ? `${bookId}|${chapter}` : null;
  const [loaded, setLoaded] = useState<{ key: string; kit: Kit | null; error: string | null } | null>(
    null,
  );
  useEffect(() => {
    if (!key || !bookId || chapter === null) return;
    let live = true;
    const q = new URLSearchParams({ book: bookId, chapter: String(chapter) });
    fetch(`/api/present/kit?${q.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "Not available." : `Failed (${r.status})`);
        return (await r.json()) as Kit;
      })
      .then((k) => {
        if (live) setLoaded({ key, kit: k, error: null });
      })
      .catch((e: unknown) => {
        // A rail that fails silently looks like a chapter with no kit, which is
        // a very different thing from a request that broke.
        if (live) {
          setLoaded({ key, kit: null, error: e instanceof Error ? e.message : "Could not load the kit." });
        }
      });
    return () => {
      live = false;
    };
  }, [key, bookId, chapter]);

  const current = loaded && loaded.key === key ? loaded : null;
  const kit = current?.kit ?? null;
  const kitError = current?.error ?? null;
  const loading = !!key && !current;

  // The running lesson. Starting one is a server round trip because the session
  // id is what every later write is scoped to — strokes, items, the close.
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const start = useCallback(async () => {
    if (!bookId || chapter === null) return;
    setStarting(true);
    setStartError(null);
    try {
      const r = await fetch("/api/present/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bookId,
          chapterNum: chapter,
          classId: ctx?.classId ?? null,
          subject: ctx?.subject ?? null,
          slotDay: ctx?.day ?? null,
          slotPeriod: ctx?.period?.period ?? null,
        }),
      });
      const d = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!r.ok || !d.id) throw new Error(d.error || `Could not start (${r.status})`);
      setSession({ id: d.id, bookId, chapterNum: chapter });
    } catch (e) {
      // Starting is the one action where a silent failure is unacceptable: she
      // taps it and turns to the class.
      setStartError(e instanceof Error ? e.message : "Could not start the board.");
    } finally {
      setStarting(false);
    }
  }, [bookId, chapter, ctx]);

  const endSession = useCallback(() => setSession(null), []);

  return (
    <main className="min-h-dvh bg-[#0F1417] text-[#E7EDE9]">
      {/* Dark, because it sits above a lit board in a room with the lights down,
          and because it must read from the back of the class. */}
      <header className="flex flex-wrap items-center gap-2 border-b border-[#222C30] px-3 py-2">
        <Chip label="Grade" value={klass?.grade ?? "—"} />
        <Chip label="Subject" value={ctx?.subject ?? "—"} />
        <Chip label="Class" value={klass?.name ?? "—"} />

        <select
          aria-label="Book"
          value={bookId ?? ""}
          onChange={(e) => setPick({ book: e.target.value || null, chapter: null })}
          className="rounded-lg border border-[#2A363B] bg-[#141B1F] px-3 py-2 text-sm"
        >
          <option value="">Choose a book…</option>
          {books.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
            </option>
          ))}
        </select>

        <select
          aria-label="Chapter"
          value={chapter ?? ""}
          disabled={!book}
          onChange={(e) =>
            setPick({ book: bookId, chapter: e.target.value === "" ? null : Number(e.target.value) })
          }
          className="rounded-lg border border-[#2A363B] bg-[#141B1F] px-3 py-2 text-sm disabled:opacity-40"
        >
          <option value="">Chapter…</option>
          {chapters.map((c) => (
            <option key={c.num} value={c.num}>
              {/* chapter_ref is 0-based in the database and rendered +1. */}
              {c.title ? `${c.num + 1}. ${c.title}` : `Chapter ${c.num + 1}`}
            </option>
          ))}
        </select>

        <Confidence ctx={ctx} />

        <div className="ms-auto text-end font-mono text-[11px] leading-tight text-[#93A09A]">
          <div>{teacherName ?? ""}</div>
          <div>
            {ctx?.period ? `${ctx.period.label} · ${ctx.timeLabel}` : now ? "Outside lesson hours" : "…"}
          </div>
        </div>
      </header>

      {session ? (
        <BoardSession session={session} kit={kit} onEnd={endSession} />
      ) : ready ? (
        <section className="grid gap-3 p-3 lg:grid-cols-[260px_1fr]">
          <aside className="grid content-start gap-2">
            <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#5F6F69]">
              Chapter kit
            </h2>
            {loading && <p className="text-sm text-[#93A09A]">Loading…</p>}
            {kitError && <p className="text-sm text-[#E58A93]">{kitError}</p>}

            {kit?.units.map((u) => (
              <div key={u.part === null ? "whole" : u.part} className="grid gap-1">
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#5F6F69]">
                  {u.label}
                </p>
                {u.video && (
                  <div className="rounded-xl border border-[#17544C] bg-[#12302C] px-3 py-3 text-sm text-[#4FD6C2]">
                    ▶ Video
                    <span className="mt-0.5 block font-mono text-[10px] opacity-70">
                      {u.video.urls.length > 1 ? `${u.video.urls.length} parts` : "ready"}
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
                    {d.label}
                    {d.note && (
                      <span className="mt-0.5 block font-mono text-[10px] leading-snug text-[#5F6F69]">
                        {d.note}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}

            {kit && !kit.units.length && (
              <p className="text-sm text-[#93A09A]">Nothing generated for this chapter yet.</p>
            )}

            {/* Listed, not tappable: opening one is something the running board
                does, and a button here that only highlighted itself would be a
                control that looked like it had done something. */}
            {!!kit?.picker.length && (
              <>
                <h2 className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[#5F6F69]">
                  Also available on the board
                </h2>
                {kit.picker.map((g) => (
                  <div key={g.group} className="grid gap-1">
                    <p className="font-mono text-[10px] text-[#5F6F69]">{GROUP_LABEL[g.group]}</p>
                    {g.items.map((i) => (
                      <p key={i.id} className="text-sm text-[#93A09A]">
                        {i.label}
                      </p>
                    ))}
                  </div>
                ))}
              </>
            )}
          </aside>

          <div className="grid place-items-center rounded-xl border border-[#222C30] bg-[#0B0F11] p-6 text-center">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Ready when you are</h1>
              <p className="mt-2 max-w-md text-sm text-[#93A09A]">
                Starting the board opens a session: the roll is saved as you write,
                and what you show is recorded so the lesson note can be about the
                concept rather than the timetable.
              </p>
              <button
                type="button"
                onClick={start}
                disabled={starting}
                className="mt-5 rounded-xl bg-[#0C8175] px-6 py-3 text-sm font-medium text-white disabled:opacity-50"
              >
                {starting ? "Starting…" : "Start the board"}
              </button>
              {startError && <p className="mt-3 text-sm text-[#E58A93]">{startError}</p>}
            </div>
          </div>
        </section>
      ) : (
        <section className="grid place-items-center px-4" style={{ minHeight: "70dvh" }}>
          <div className="text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#5F6F69]">
              Present mode
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">
              Choose what you are teaching
            </h1>
            <p className="mt-2 max-w-md text-sm text-[#93A09A]">
              {ctx?.confidence === "slot"
                ? "Your timetable filled in the class and subject. Pick the book and chapter to see the kit."
                : ctx?.confidence === "period"
                  ? "A period is running, but your timetable has no lesson for you in it."
                  : "No timetable for right now — pick what you are teaching."}
            </p>
          </div>
        </section>
      )}
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
function Confidence({ ctx }: { ctx: PresentContext | null }) {
  if (!ctx) return null;
  const map = {
    slot: { text: "Set from timetable", cls: "border-[#17544C] bg-[#12302C] text-[#4FD6C2]" },
    period: { text: "No lesson this period", cls: "border-[#4A3A1C] bg-[#2C2318] text-[#E0A664]" },
    none: { text: "Pick manually", cls: "border-[#2A363B] bg-[#141B1F] text-[#93A09A]" },
  }[ctx.confidence];
  return (
    <span className={`rounded-lg border px-3 py-2 text-sm ${map.cls}`}>
      {ctx.confidence === "slot" ? "● " : ""}
      {map.text}
    </span>
  );
}
