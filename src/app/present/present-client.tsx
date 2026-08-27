"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import {
  resolveContext,
  type LastTaught,
  type PresentContext,
} from "@/utils/present/context";
import type { Slot, TimetableShape } from "@/utils/timetable";

// The context bar: what the board knows before she taps anything.
//
// THE CLOCK IS THE PANEL'S. Resolved here rather than on the server because the
// server is in UTC and the classroom is not. A period is a local-time fact.
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
  chapters: { num: number; title?: string; parts?: unknown[] }[];
};

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
// snapshot keeps a STABLE identity between minutes: returning a fresh object
// every call would make React re-render forever, and returning a new Date()
// would do it sixty times a second.

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

  // DERIVED, not synced. An effect that copied the suggestion into state would
  // have to be careful never to overwrite a choice she had already made; a null
  // `pick` meaning "she has not chosen" needs no such care, and it makes
  // "explicitly cleared" a state the suggestion cannot quietly undo.
  const [pick, setPick] = useState<{ book: string | null; chapter: number | null } | null>(null);
  const bookId = pick ? pick.book : (ctx?.suggestion?.bookId ?? null);
  const chapter = pick ? pick.chapter : (ctx?.suggestion?.chapterNum ?? null);

  const klass = classes.find((c) => c.id === ctx?.classId) ?? null;
  const book = books.find((b) => b.id === bookId) ?? null;
  const chapters = book?.chapters ?? [];

  const ready = !!bookId && chapter !== null;

  return (
    <main className="min-h-dvh bg-[#0F1417] text-[#E7EDE9]">
      {/* The bar. Dark, because it sits above a lit board in a room with the
          lights down, and because it must read from the back of the class. */}
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

      <section className="grid place-items-center px-4" style={{ minHeight: "70dvh" }}>
        <div className="text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#5F6F69]">
            Present mode · Phase 2 in progress
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            {ready ? "Ready to start the board" : "Choose what you are teaching"}
          </h1>
          <p className="mt-2 max-w-md text-sm text-[#93A09A]">
            {ctx?.confidence === "slot"
              ? "Your timetable filled in the class and subject. The book and chapter come from where this class got to last time."
              : ctx?.confidence === "period"
                ? "A period is running, but your timetable has no lesson for you in it."
                : "No timetable for right now — pick what you are teaching."}
          </p>
          <button
            type="button"
            disabled={!ready}
            className="mt-5 rounded-xl bg-[#0C8175] px-6 py-3 text-sm font-medium text-white disabled:opacity-40"
          >
            Start the board
          </button>
          <p className="mt-3 font-mono text-[11px] text-[#5F6F69]">
            The kit rail, the stage and the roll land next.
          </p>
        </div>
      </section>
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
