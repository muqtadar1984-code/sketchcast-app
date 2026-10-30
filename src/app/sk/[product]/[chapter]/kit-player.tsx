"use client";

// SK S3 slice B — the student kit player on /sk/[product]/[chapter].
//
// Plays the chapter's mapped kit (the catalogue kit's lesson video) section by
// section from its Kit Manifest, with the tutor's moves beside it:
//   segment  play one section and pause at its end (Final Plan §2.4)
//   slide    the section's finished slide: the paused frame — or, when the map
//            says the picture is not trusted, a heading-and-points card. A
//            caption_only section NEVER shows the video frame (design decision 6)
//   explain  /api/sk/kit/turn: one metered model turn on the section's words
//   practise /api/sk/kit/items + /api/sk/kit/answer (marked on the server)
//   what's next  nextMove(), deterministic
// Every decision is a pure function in src/sk/kit-player.ts; this file renders.
//
// Touch: every control is a visible button (no hover-only controls).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { fmt } from "@/i18n/format";
import { uuidv7 } from "@/sk/ids";
import {
  canStep,
  clampIndex,
  loadKit,
  nextMove,
  parseSse,
  refusalKey,
  sectionAt,
  sectionForRung,
  slideView,
  stepSection,
  withCheckItem,
  type KitFetchResult,
  type KitGrade,
  type KitListEntry,
  type KitPractiseItem,
  type KitReply,
  type KitRung,
  type KitView,
  type SlideView,
} from "@/sk/kit-player";
import { registerTutorPort, type TutorPort } from "@/sk/shell/client/tutor-bridge";

type T = Dictionary["sk"]["player"];
type Status = { kind: "loading" } | { kind: "preparing" } | { kind: "ready" } | { kind: "refused"; reason?: string } | { kind: "failed"; mapFailed: boolean };
/** The practise panel. `rungs` are the remediation ladder's rungs served on
 *  the current question so far (slice C); `checkIds` the check questions the
 *  ladder added to the list. The attempt number is the server's. */
type Practice = { index: number; items: KitPractiseItem[] | null; i: number; response: unknown; grade: KitGrade | null; rungs: KitRung[]; checkIds: string[]; busy: boolean; error: boolean };

const btn = "inline-flex min-h-10 items-center justify-center rounded-lg border border-[#14181F] px-3 py-2 text-sm text-[#14181F] disabled:opacity-40";
const btnPrimary = "inline-flex min-h-10 items-center justify-center rounded-lg bg-[#0C8175] px-3 py-2 text-sm font-medium text-white disabled:opacity-40";

export default function KitPlayer({ product, chapter, initialKit, locale, t }: { product: string; chapter: string; initialKit: string | null; locale: string; t: T }) {
  const [kitId, setKitId] = useState<string | null>(initialKit);
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [kits, setKits] = useState<KitListEntry[]>([]);
  const [kit, setKit] = useState<KitView | null>(null);
  const [current, setCurrent] = useState(0);
  const [mode, setMode] = useState<"video" | "slide">("video");
  const [playing, setPlaying] = useState(false);
  const [watched, setWatched] = useState<number[]>([]);
  const [practised, setPractised] = useState<number[]>([]);
  const [skText, setSkText] = useState<string | null>(null);
  const [skBusy, setSkBusy] = useState(false);
  // 2026-10-30: the language SK's reply is in (direction + lang attribute),
  // and the signed note that carries her language choice and SK's last
  // explanation between turns (/api/sk/kit/turn `state`).
  const [skLang, setSkLang] = useState<{ lang: string; dir: "ltr" | "rtl" } | null>(null);
  const skState = useRef<string | null>(null);
  const [question, setQuestion] = useState("");
  const [practice, setPractice] = useState<Practice | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const loadedPart = useRef<number | null>(null);
  const stopAt = useRef<number | null>(null);
  const pendingSeek = useRef<{ t: number; play: boolean } | null>(null);
  const refreshedOnError = useRef(false);

  const query = useCallback((id: string | null) => {
    const q = new URLSearchParams({ product, chapter });
    if (id) q.set("kit", id);
    return q;
  }, [product, chapter]);

  // ── load (GET → one POST to build the map → poll) ──
  useEffect(() => {
    const ac = new AbortController();
    const fetchKit = async (method: "GET" | "POST"): Promise<KitFetchResult> => {
      const q = query(kitId);
      const res =
        method === "GET"
          ? await fetch(`/api/sk/kit?${q.toString()}`, { signal: ac.signal })
          : await fetch("/api/sk/kit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product, chapter, kit: kitId }), signal: ac.signal });
      const body = (await res.json().catch(() => null)) as (KitReply & { reason?: string }) | { reason?: string } | null;
      if (!res.ok) return { ok: false, status: res.status, reason: body?.reason };
      return { ok: true, reply: body as KitReply };
    };
    void loadKit(fetchKit, {
      signal: ac.signal,
      onPreparing: (r) => {
        setKits(r.kits);
        setStatus({ kind: "preparing" });
      },
    }).then((r) => {
      if (ac.signal.aborted) return;
      if (r.status === "ready") {
        setKits(r.reply.kits);
        setKit(r.reply.kit);
        setCurrent(0);
        setMode("video");
        setStatus({ kind: "ready" });
      } else if (r.status === "refused") setStatus({ kind: "refused", reason: r.reason });
      else if (r.reason !== "aborted") setStatus({ kind: "failed", mapFailed: r.reason === "map_failed" });
    });
    return () => ac.abort();
  }, [kitId, product, chapter, query, reloadKey]);

  const segments = useMemo(() => kit?.segments ?? [], [kit]);
  const partsWithVideo = useMemo(() => new Set((kit?.videos ?? []).map((v) => v.part)), [kit]);
  const hasVideo = partsWithVideo.size > 0;
  const seg = segments[clampIndex(segments, current)];
  const slide: SlideView | null = mode === "slide" && seg ? slideView(segments, current, partsWithVideo) : null;
  const showCard = !!seg && (!hasVideo || !partsWithVideo.has(seg.part) || slide?.kind === "caption");

  // ── video control ──
  const seekTo = useCallback(
    (part: number, time: number, play: boolean) => {
      const v = videoRef.current;
      const url = kit?.videos.find((x) => x.part === part)?.url;
      if (!v || !url) return;
      if (loadedPart.current !== part) {
        loadedPart.current = part;
        pendingSeek.current = { t: time, play };
        v.src = url;
        v.load();
        return;
      }
      v.currentTime = time;
      if (play) void v.play().catch(() => setPlaying(false));
      else v.pause();
    },
    [kit],
  );

  const markWatched = useCallback((index: number) => setWatched((w) => (w.includes(index) ? w : [...w, index])), []);

  const playSection = useCallback(
    (i: number) => {
      const k = clampIndex(segments, i);
      const s = segments[k];
      if (!s) return;
      setCurrent(k);
      setMode("video");
      setSkText(null);
      if (!partsWithVideo.has(s.part)) {
        // No video for this part: the card is the section; reading it counts.
        markWatched(s.index);
        return;
      }
      stopAt.current = s.end;
      seekTo(s.part, s.start, true);
    },
    [segments, partsWithVideo, seekTo, markWatched],
  );

  const showSlideAt = useCallback(
    (i: number) => {
      const k = clampIndex(segments, i);
      if (k < 0) return;
      setCurrent(k);
      const view = slideView(segments, k, partsWithVideo);
      setMode("slide");
      stopAt.current = null;
      if (view.kind === "frame") seekTo(view.part, view.t, false);
      else videoRef.current?.pause();
    },
    [segments, partsWithVideo, seekTo],
  );
  const showSlide = useCallback(() => {
    if (seg) showSlideAt(current);
  }, [seg, current, showSlideAt]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v || !seg) return;
    if (!v.paused) {
      v.pause();
      return;
    }
    if (mode === "slide" || loadedPart.current !== seg.part) {
      playSection(current);
      return;
    }
    // Resume: carry on to the end of the current section.
    stopAt.current = seg.end;
    void v.play().catch(() => setPlaying(false));
  }, [seg, mode, current, playSection]);

  // A kit (re)loaded: cue section 1, paused (the <video> mounts with "ready").
  useEffect(() => {
    if (status.kind !== "ready" || !kit) return;
    loadedPart.current = null;
    const first = kit.segments[0];
    if (first && kit.videos.some((v) => v.part === first.part)) seekTo(first.part, first.start, false);
  }, [status.kind, kit, seekTo]);

  const onLoadedMetadata = () => {
    const p = pendingSeek.current;
    const v = videoRef.current;
    if (!p || !v) return;
    pendingSeek.current = null;
    v.currentTime = p.t;
    if (p.play) void v.play().catch(() => setPlaying(false));
  };

  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v || loadedPart.current === null) return;
    const tNow = v.currentTime;
    if (stopAt.current !== null && tNow >= stopAt.current - 0.05) {
      stopAt.current = null;
      v.pause();
      const at = sectionAt(segments, loadedPart.current, Math.max(0, tNow - 0.1));
      if (at >= 0) markWatched(segments[at]!.index);
      return;
    }
    if (mode === "video" && !v.paused) {
      const at = sectionAt(segments, loadedPart.current, tNow);
      if (at >= 0 && at !== current) {
        if (segments[current]) markWatched(segments[current]!.index);
        setCurrent(at);
      }
    }
  };

  // ── the tutor's turn (explain / ask) — one metered model turn ──
  const ask = useCallback(
    async (q: string) => {
      if (!seg || skBusy) return;
      setSkBusy(true);
      setSkText(null);
      videoRef.current?.pause();
      try {
        const res = await fetch("/api/sk/kit/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId: uuidv7(), product, chapter, kit: kit?.generationId, segment: seg.key, question: q || undefined, locale, ...(skState.current ? { state: skState.current } : {}) }),
        });
        if (!res.ok) {
          setSkText(t.loadFailed);
          return;
        }
        const events = parseSse(await res.text());
        const text = events.filter((e) => e.event === "text").map((e) => String(e.data ?? "")).join("");
        const done = events.find((e) => e.event === "done")?.data as { state?: unknown; lang?: { lang?: unknown; dir?: unknown } } | undefined;
        if (typeof done?.state === "string") skState.current = done.state;
        if (typeof done?.lang?.lang === "string") setSkLang({ lang: done.lang.lang, dir: done.lang.dir === "rtl" ? "rtl" : "ltr" });
        setSkText(text || t.loadFailed);
      } catch {
        setSkText(t.loadFailed);
      } finally {
        setSkBusy(false);
      }
    },
    [seg, skBusy, product, chapter, kit, locale, t],
  );

  // ── practise ──
  const openPractice = useCallback(
    async (i: number) => {
      const k = clampIndex(segments, i);
      const s = segments[k];
      if (!s) return;
      setCurrent(k);
      videoRef.current?.pause();
      setPractice({ index: k, items: null, i: 0, response: null, grade: null, rungs: [], checkIds: [], busy: true, error: false });
      try {
        const q = query(kit?.generationId ?? null);
        q.set("segment", s.key);
        const res = await fetch(`/api/sk/kit/items?${q.toString()}`);
        const body = (await res.json().catch(() => null)) as { items?: KitPractiseItem[] } | null;
        setPractice((p) => (p && p.index === k ? { ...p, items: res.ok ? (body?.items ?? []) : [], busy: false, error: !res.ok } : p));
      } catch {
        setPractice((p) => (p && p.index === k ? { ...p, items: [], busy: false, error: true } : p));
      }
    },
    [segments, query, kit],
  );

  const check = useCallback(async () => {
    if (!practice?.items) return;
    const item = practice.items[practice.i];
    if (!item || practice.response === null || practice.response === "") return;
    setPractice({ ...practice, busy: true });
    try {
      const res = await fetch("/api/sk/kit/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The server counts attempts; the eventId makes a resend of this answer a replay.
        body: JSON.stringify({ eventId: uuidv7(), product, chapter, kit: kit?.generationId, itemId: item.id, response: practice.response }),
      });
      const grade = res.ok ? ((await res.json()) as KitGrade) : null;
      setPractice((p) => (p ? { ...p, grade, rungs: grade ? [...p.rungs, ...(grade.rungs ?? [])] : p.rungs, busy: false, error: !grade } : p));
    } catch {
      setPractice((p) => (p ? { ...p, busy: false, error: true } : p));
    }
  }, [practice, product, chapter, kit]);

  const nextQuestion = useCallback(() => {
    if (!practice?.items) return;
    const g = practice.grade;
    if (g && g.triesLeft > 0 && g.outcome !== "correct") {
      // Another try on the same question.
      setPractice({ ...practice, grade: null, response: null });
      return;
    }
    if (practice.i + 1 < practice.items.length) {
      setPractice({ ...practice, i: practice.i + 1, grade: null, response: null, rungs: [] });
      return;
    }
    const s = segments[practice.index];
    if (s) setPractised((d) => (d.includes(s.index) ? d : [...d, s.index]));
    setPractice(null);
  }, [practice, segments]);

  /** Rung 4: put the check question right after this one and go to it. */
  const takeCheck = useCallback(
    (q: KitPractiseItem) => {
      if (!practice?.items) return;
      const items = withCheckItem(practice.items, practice.i, q);
      const at = items.findIndex((x) => x.id === q.id);
      setPractice({ ...practice, items, i: at, grade: null, response: null, rungs: [], checkIds: practice.checkIds.includes(q.id) ? practice.checkIds : [...practice.checkIds, q.id] });
    },
    [practice],
  );

  const closePractice = useCallback(() => {
    if (practice?.items && practice.items.length && practice.grade) {
      const s = segments[practice.index];
      if (s) setPractised((d) => (d.includes(s.index) ? d : [...d, s.index]));
    }
    setPractice(null);
  }, [practice, segments]);

  // ── S3 slice D: the SK Shell's controller port (shell/client/tutor-bridge.ts).
  // Additive: the Shell's moves call the player's own handlers. The latest
  // handlers ride in a ref, refreshed after every render; the port itself is
  // registered once per mount.
  const shellPort = useRef<TutorPort | null>(null);
  useEffect(() => {
    shellPort.current = {
      state: () =>
        status.kind === "ready" && kit
          ? {
              product,
              chapter,
              kit: kit.generationId,
              k: clampIndex(segments, current),
              ...(seg ? { key: seg.key } : {}),
              playing: !!videoRef.current && !videoRef.current.paused,
              mode,
              practising: !!practice,
              watched,
              practised,
              segments: segments.map((s, i) => ({ k: i, key: s.key, heading: s.heading })),
              ...(kit.language ? { language: kit.language } : {}),
            }
          : null,
      playing: () => !!videoRef.current && !videoRef.current.paused,
      play: () => {
        if (videoRef.current && !videoRef.current.paused) return;
        setPractice(null);
        togglePlay();
      },
      pause: () => videoRef.current?.pause(),
      restart: () => {
        setPractice(null);
        playSection(0);
      },
      section: (k) => {
        setPractice(null);
        playSection(k);
      },
      slide: (k) => {
        setPractice(null);
        showSlideAt(k);
      },
      practise: (k) => void openPractice(k),
    };
  });
  useEffect(
    () =>
      registerTutorPort({
        state: () => shellPort.current?.state() ?? null,
        playing: () => shellPort.current?.playing() ?? false,
        play: () => shellPort.current?.play(),
        pause: () => shellPort.current?.pause(),
        restart: () => shellPort.current?.restart(),
        section: (k) => shellPort.current?.section(k),
        slide: (k) => shellPort.current?.slide(k),
        practise: (k) => shellPort.current?.practise(k),
      }),
    [],
  );

  // ── what's next ──
  const move = useMemo(() => nextMove({ segments, current, watched, practised }), [segments, current, watched, practised]);
  const moveLabel =
    move.kind === "watch"
      ? fmt(t.nextWatch, { n: move.index + 1, heading: segments[move.index]?.heading || t.untitled })
      : move.kind === "practise"
        ? fmt(t.nextPractise, { n: move.index + 1 })
        : t.nextDone;
  const doMove = () => {
    if (move.kind === "watch") playSection(move.index);
    else if (move.kind === "practise") void openPractice(move.index);
    else setSkText(t.nextDone);
  };

  const reload = () => {
    setStatus({ kind: "loading" });
    setReloadKey((n) => n + 1);
  };

  const pickKit = (id: string) => {
    if (id === kit?.generationId) return;
    setStatus({ kind: "loading" });
    setKit(null);
    setWatched([]);
    setPractised([]);
    setPractice(null);
    setSkText(null);
    setKitId(id);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("kit", id);
      window.history.replaceState(null, "", u.toString());
    } catch {
      /* not essential */
    }
  };

  // ── render ──
  if (status.kind === "loading" || status.kind === "preparing") {
    return (
      <div className="mx-auto max-w-3xl rounded-xl border border-[#E3E6E2] bg-white p-4 text-sm text-[#5B6470]" role="status" data-testid="kit-status">
        {status.kind === "preparing" ? t.preparing : t.loading}
      </div>
    );
  }
  if (status.kind === "refused" || status.kind === "failed") {
    const msg = status.kind === "refused" ? t[refusalKey(status.reason)] : status.mapFailed ? t.mapFailed : t.loadFailed;
    return (
      <div className="mx-auto max-w-3xl rounded-xl border border-[#E3E6E2] bg-white p-4" role="alert" data-testid="kit-refused">
        <p className="text-sm text-[#14181F]">{msg}</p>
        {status.kind === "failed" && (
          <button className={`${btn} mt-3`} onClick={reload}>
            {t.retry}
          </button>
        )}
      </div>
    );
  }
  if (!kit) return null;

  const item = practice?.items?.[practice.i];
  const total = segments.length;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3" data-testid="kit-player">
      <header>
        <h1 className="text-lg font-semibold text-[#14181F]">{kit.title}</h1>
        {kits.length > 1 && (
          <nav aria-label={t.lessonsInChapter} className="mt-2">
            <div className="text-xs uppercase tracking-wide text-[#5B6470]">{t.lessonsInChapter}</div>
            <div className="mt-1 flex flex-wrap gap-2">
              {kits.map((k) => (
                <button key={k.generationId} className={k.generationId === kit.generationId ? btnPrimary : btn} aria-pressed={k.generationId === kit.generationId} onClick={() => pickKit(k.generationId)}>
                  {k.label || k.title}
                </button>
              ))}
            </div>
          </nav>
        )}
      </header>

      <div className="relative w-full overflow-hidden rounded-xl bg-[#0E1116]" style={{ aspectRatio: "16 / 9" }}>
        {hasVideo && (
          <video
            ref={videoRef}
            playsInline
            preload="metadata"
            className={`absolute inset-0 h-full w-full ${showCard ? "invisible" : ""}`}
            onLoadedMetadata={onLoadedMetadata}
            onTimeUpdate={onTimeUpdate}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onError={() => {
              // A signed URL lasts an hour: fetch fresh ones once.
              if (refreshedOnError.current) return;
              refreshedOnError.current = true;
              reload();
            }}
            data-testid="kit-video"
          />
        )}
        {showCard && seg && (
          <div className="absolute inset-0 overflow-auto bg-white p-4 sm:p-6" data-testid="kit-card">
            <h2 className="text-base font-semibold text-[#14181F] sm:text-xl">{seg.heading || t.untitled}</h2>
            {seg.points.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-[#14181F] sm:text-base">
                {seg.points.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-[#5B6470]">{hasVideo ? t.captionNote : t.noVideo}</p>
          </div>
        )}
      </div>

      <div className="text-sm text-[#5B6470]" aria-live="polite">
        {fmt(t.sectionOf, { n: clampIndex(segments, current) + 1, total })}
        {seg ? ` · ${seg.heading || t.untitled}` : ""}
      </div>

      <div className="flex flex-wrap gap-2">
        <button className={btn} onClick={() => playSection(stepSection(segments, current, -1))} disabled={!canStep(segments, current, -1)}>
          {t.previous}
        </button>
        {hasVideo && (
          <button className={btnPrimary} onClick={togglePlay} disabled={!seg || !partsWithVideo.has(seg.part)} data-testid="kit-play">
            {playing ? t.pause : t.play}
          </button>
        )}
        <button className={btn} onClick={() => playSection(stepSection(segments, current, 1))} disabled={!canStep(segments, current, 1)}>
          {t.next}
        </button>
        {hasVideo && (
          <button className={btn} onClick={() => (mode === "slide" ? playSection(current) : showSlide())} disabled={!seg} data-testid="kit-slide">
            {mode === "slide" ? t.showVideo : t.showSlide}
          </button>
        )}
      </div>

      <div className="rounded-xl border border-[#E3E6E2] bg-white p-3">
        <div className="flex flex-wrap gap-2">
          <button className={btn} onClick={() => void ask("")} disabled={!seg || skBusy} data-testid="kit-explain">
            {t.explain}
          </button>
          <button className={btn} onClick={() => void openPractice(current)} disabled={!seg || !seg.practise} data-testid="kit-practise">
            {t.practise}
          </button>
          <button className={btnPrimary} onClick={doMove} data-testid="kit-next-move">
            {t.whatsNext}
          </button>
        </div>
        <p className="mt-2 text-xs text-[#5B6470]">{moveLabel}</p>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const q = question.trim();
            if (!q) return;
            setQuestion("");
            void ask(q);
          }}
        >
          <input className="min-h-10 min-w-0 flex-1 rounded-lg border border-[#C9CEC8] px-3 text-sm" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t.askPlaceholder} maxLength={600} disabled={skBusy} />
          <button className={btnPrimary} type="submit" disabled={skBusy || !question.trim()}>
            {t.ask}
          </button>
        </form>
        {(skBusy || skText) && (
          <div className="mt-3 rounded-lg bg-[#F1F7F6] p-3 text-sm text-[#14181F]" aria-live="polite" data-testid="kit-sk-text">
            <span className="font-semibold text-[#0C8175]">{t.skSays}: </span>
            {skBusy ? t.thinking : <span dir={skLang?.dir ?? "auto"} lang={skLang?.lang === "ms-arab" ? "ms-Arab" : skLang?.lang === "zh" ? "zh-CN" : skLang?.lang}>{skText}</span>}
          </div>
        )}
      </div>

      {practice && (
        <section className="rounded-xl border border-[#E3E6E2] bg-white p-3" data-testid="kit-practice">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-sm font-semibold text-[#14181F]">{fmt(t.practiceTitle, { heading: segments[practice.index]?.heading || t.untitled })}</h2>
            <button className={btn} onClick={closePractice}>
              {t.closePractice}
            </button>
          </div>
          {practice.items === null ? (
            <p className="mt-2 text-sm text-[#5B6470]">{t.loading}</p>
          ) : practice.error && !practice.items.length ? (
            <p className="mt-2 text-sm text-[#B42318]">{t.loadFailed}</p>
          ) : !item ? (
            <p className="mt-2 text-sm text-[#5B6470]">{t.noPractice}</p>
          ) : (
            <div className="mt-2">
              <div className="text-xs text-[#5B6470]">
                {practice.checkIds.includes(item.id) ? t.checkQuestion : fmt(t.questionOf, { n: practice.i + 1, total: practice.items.length })}
              </div>
              <p className="mt-1 font-medium text-[#14181F]">{item.prompt}</p>
              <ItemInput item={item} value={practice.response} disabled={practice.busy || !!practice.grade} t={t} onChange={(v) => setPractice({ ...practice, response: v })} />
              {practice.grade && (
                <p className="mt-2 text-sm" role="status">
                  {t[practice.grade.outcome === "correct" ? "correct" : practice.grade.outcome === "partial" ? "partial" : practice.grade.outcome === "needs_review" ? "needsReview" : "incorrect"]}
                  {practice.grade.triesLeft > 0 ? ` ${fmt(t.triesLeft, { n: practice.grade.triesLeft })}` : ""}
                </p>
              )}
              {(practice.rungs.length > 0 || practice.grade?.reveal) && (
                <Rungs rungs={practice.rungs} reveal={practice.grade?.reveal ?? null} t={t} onSlide={(r) => showSlideAt(sectionForRung(segments, r))} onWatch={(r) => playSection(sectionForRung(segments, r))} onCheck={takeCheck} />
              )}
              {practice.error && practice.items.length > 0 && <p className="mt-2 text-sm text-[#B42318]">{t.loadFailed}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {!practice.grade ? (
                  <button className={btnPrimary} onClick={() => void check()} disabled={practice.busy || practice.response === null || practice.response === ""}>
                    {t.check}
                  </button>
                ) : (
                  <button className={btnPrimary} onClick={nextQuestion}>
                    {practice.grade.triesLeft > 0 && practice.grade.outcome !== "correct" ? t.retry : t.nextQuestion}
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      <section className="rounded-xl border border-[#E3E6E2] bg-white p-3">
        <h2 className="text-sm font-semibold text-[#14181F]">{t.sections}</h2>
        <ol className="mt-2 flex flex-col gap-1">
          {segments.map((s, i) => (
            <li key={s.key}>
              <button
                className={`flex min-h-10 w-full items-center gap-2 rounded-lg px-2 py-1 text-start text-sm ${i === current ? "bg-[#E7F3F1] font-medium" : ""}`}
                aria-current={i === current ? "true" : undefined}
                onClick={() => playSection(i)}
              >
                <span className="w-6 shrink-0 text-[#5B6470]">{i + 1}</span>
                <span className="flex-1 text-[#14181F]">{s.heading || t.untitled}</span>
                {watched.includes(s.index) && <span aria-hidden="true">✓</span>}
              </button>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

const card = "mt-2 rounded-lg border border-[#E3E6E2] bg-[#F8FAF7] p-3 text-sm text-[#14181F]";

/** The remediation ladder in the practise panel: the misconception card, the
 *  hint, "watch this part" (slide(k)), the check question, and — after the
 *  last try — the answer. Renders what the server sent; decides nothing. */
function Rungs({ rungs, reveal, t, onSlide, onWatch, onCheck }: { rungs: KitRung[]; reveal: KitGrade["reveal"]; t: T; onSlide: (r: KitRung) => void; onWatch: (r: KitRung) => void; onCheck: (q: KitPractiseItem) => void }) {
  return (
    <div className="mt-2 flex flex-col gap-2" aria-live="polite" data-testid="kit-rungs">
      {rungs.map((r, i) => {
        const key = `${r.rung}-${i}`;
        if (r.kind === "misconception")
          return (
            <div key={key} className={card} data-testid="kit-rung-misconception">
              <p>{fmt(t.rungThinking, { thinking: r.misconception })}</p>
            </div>
          );
        if (r.kind === "why_wrong")
          return (
            <p key={key} className={card} data-testid="kit-rung-why">
              {fmt(t.rungWhyWrong, { text: r.text })}
            </p>
          );
        if (r.kind === "hint" && r.from === "section")
          return (
            <div key={key} className={card} data-testid="kit-rung-hint">
              <p>
                <span className="font-semibold">{t.rungHint}</span> {fmt(t.rungHintSection, { heading: r.heading || t.untitled })}
              </p>
              <button className={`${btn} mt-2`} onClick={() => onSlide(r)}>
                {t.showSlide}
              </button>
            </div>
          );
        if (r.kind === "hint")
          return (
            <p key={key} className={card} data-testid="kit-rung-hint">
              <span className="font-semibold">{t.rungHint}</span> {"text" in r ? r.text : ""}
            </p>
          );
        if (r.kind === "slide")
          return (
            <div key={key} className={card} data-testid="kit-rung-slide">
              <p>{fmt(t.rungSlide, { heading: r.heading || t.untitled })}</p>
              {r.correction && <p className="mt-1">{fmt(t.rungActually, { correction: r.correction })}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                <button className={btn} onClick={() => onSlide(r)}>
                  {t.showSlide}
                </button>
                <button className={btnPrimary} onClick={() => onWatch(r)}>
                  {t.watchThisPart}
                </button>
              </div>
            </div>
          );
        if (r.itemId === null)
          return (
            <div key={key} className={card} data-testid="kit-rung-nocheck">
              <p>{t.rungNoCheck}</p>
              {r.explanation && !reveal?.explanation && <p className="mt-1 text-[#3A424D]">{r.explanation}</p>}
            </div>
          );
        const q = r.item;
        return (
          <div key={key} className={card} data-testid="kit-rung-check">
            <p>{t.rungCheck}</p>
            {q && (
              <button className={`${btnPrimary} mt-2`} onClick={() => onCheck(q)}>
                {t.tryCheck}
              </button>
            )}
          </div>
        );
      })}
      {reveal && (
        <div className={card} data-testid="kit-reveal">
          <p>
            <span className="font-semibold">{t.revealAnswer}</span> {reveal.answer}
          </p>
          {reveal.explanation && <p className="mt-1 text-[#3A424D]">{reveal.explanation}</p>}
          {reveal.correction && <p className="mt-1">{fmt(t.rungActually, { correction: reveal.correction })}</p>}
        </div>
      )}
    </div>
  );
}

function ItemInput({ item, value, disabled, t, onChange }: { item: KitPractiseItem; value: unknown; disabled: boolean; t: T; onChange: (v: unknown) => void }) {
  if (item.type === "mcq") {
    return (
      <div className="mt-2 flex flex-col gap-2">
        {item.options.map((o) => (
          <button key={o} className={`${value === o ? btnPrimary : btn} justify-start text-start`} aria-pressed={value === o} disabled={disabled} onClick={() => onChange(o)}>
            {o}
          </button>
        ))}
      </div>
    );
  }
  if (item.type === "true_false") {
    return (
      <div className="mt-2 flex gap-2">
        <button className={value === true ? btnPrimary : btn} aria-pressed={value === true} disabled={disabled} onClick={() => onChange(true)}>
          {t.trueLabel}
        </button>
        <button className={value === false ? btnPrimary : btn} aria-pressed={value === false} disabled={disabled} onClick={() => onChange(false)}>
          {t.falseLabel}
        </button>
      </div>
    );
  }
  if (item.type === "match") {
    const v = (value && typeof value === "object" ? value : {}) as Record<string, string>;
    return (
      <div className="mt-2 flex flex-col gap-2">
        {item.left.map((l, i) => (
          <label key={i} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 flex-1">{l}</span>
            <select className="min-h-10 rounded-lg border border-[#C9CEC8] px-2" value={v[String(i)] ?? ""} disabled={disabled} onChange={(e) => onChange({ ...v, [String(i)]: e.target.value })}>
              <option value="">{t.matchPick}</option>
              {item.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    );
  }
  return <input className="mt-2 min-h-10 w-full rounded-lg border border-[#C9CEC8] px-3 text-sm" value={typeof value === "string" ? value : ""} placeholder={t.yourAnswer} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
}
