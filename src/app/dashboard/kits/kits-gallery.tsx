"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { fmt } from "@/i18n/format";
import type { Dictionary } from "@/i18n/dictionaries";
import AssignModal, { type ChildRow, type ClassRow } from "../assign-modal";
import { kindLabel, type LibraryMessages } from "../labels";
import { languageLabel } from "@/utils/narration";
import { youtubeEmbedUrl } from "@/utils/catalogue/kit-youtube";
import { KIT_CHUNK, assignablePieces, downloadsOf, languagesOf, lessonPageUrl, storageVideo, visibleKits, youtubeUrl } from "./logic";

export type KitsMessages = Dictionary["kits"];

/** A piece as the server sends it. Its label, its download links and whether
 * it is assignable are derived here (logic.ts) — shipping them resolved for
 * every card made the page's payload several hundred KB of repeated strings. */
export type PieceView = { kind: string; generationId: string };
export type KitView = {
  topicId: string;
  kitId: string;
  slug: string;
  title: string;
  subject: string | null;
  language: string;
  /** the kit's YouTube video: the card's frame, and the FALLBACK player when
   * the stored MP4 cannot be played */
  youtubeId: string | null;
  /** the presentation's generation: its stored MP4 plays in-app from
   * /api/catalogue/file?kind=video_mp4 — first, whether or not the kit is on
   * YouTube (founder 2026-10-30: quality first) */
  videoGenerationId: string | null;
  questionCount: number;
  unlocked: boolean;
  pieces: PieceView[];
};

// min-h-11 below sm: 44px phone tap targets; py-2 alone measured ~36px.
const BTN_PRIMARY =
  "inline-flex w-full min-h-11 sm:min-h-0 items-center justify-center rounded-lg bg-[#0C8175] px-3 py-2 text-sm font-medium text-white hover:bg-[#0A6F65] disabled:opacity-60";
const BTN_ICON =
  "inline-flex flex-1 min-h-11 sm:min-h-0 items-center justify-center gap-1.5 rounded-lg border border-[#CBD3D1] px-2 py-2 text-xs font-medium text-[#1F2A37] hover:bg-[#F3F6F5] disabled:opacity-60";
const CHIP = "inline-flex min-h-11 sm:min-h-0 items-center rounded-full px-3 py-1 text-xs font-medium border transition-colors";
const CHIP_ON = `${CHIP} bg-[#0C8175] border-[#0C8175] text-white`;
const CHIP_OFF = `${CHIP} bg-white border-[#CBD3D1] text-[#1F2A37] hover:bg-[#F3F6F5]`;

// The Ready-made kits gallery (founder, 2026-10-16: "a mix of A and B").
//
// The first cut gave every card its summary, every download link and the
// allowance copy at once — fifty-one of those is a wall of text. This one
// shows a THUMBNAIL (the kit's own YouTube frame, which already carries the
// subject and the whiteboard look), a title, one short fact line, the pieces
// as icons, and ONE action. Everything else waits for a click:
//   · locked    → Unlock. The database decides (unlock_catalogue_kit) and the
//                 card only translates its status word.
//   · unlocked  → Files (unfolds the per-piece download links under the card)
//                 and Add to Library (adopt_catalogue_piece per piece, idempotent).
//   · adopted   → Files, Assign (the Library's modal over the COPY ids) and
//                 a link to the Library.
// Filtering is client-side over the rows the server already resolved: subject
// chips, an "unlocked" chip, and a find box over the title.
//
// 2026-10-30 (the tour skipped this page — "probably because it was taking too
// long to load"): the allowance line (the tour's anchor) is rendered by the
// server ABOVE this gallery, and the gallery renders in chunks of KIT_CHUNK —
// the first chunk at once, the next as the reader nears the end (an
// IntersectionObserver sentinel, with a "Show more" button as the fallback).
// The chips and the find box still filter EVERY kit (visibleKits); a `?topic=`
// highlight is always rendered and scrolled to.
export default function KitsGallery({
  kits,
  canUnlock,
  resetsLabel,
  highlight,
  classes,
  childTargets,
  t,
  tLib,
}: {
  kits: KitView[];
  canUnlock: boolean;
  resetsLabel: string;
  /** `?topic=` slug to ring and scroll to — never cut from the rendered
   * chunk, never a filter: it just stands out. */
  highlight: string | null;
  classes: ClassRow[];
  childTargets: ChildRow[] | null;
  t: KitsMessages;
  tLib: LibraryMessages;
}) {
  const [subject, setSubject] = useState<string>("all");
  const [language, setLanguage] = useState<string>("all");
  const [query, setQuery] = useState("");
  /** How many matching cards to render; back to one chunk on every filter change. */
  const [count, setCount] = useState(KIT_CHUNK);
  const languages = useMemo(() => languagesOf(kits), [kits]);

  const subjects = useMemo(() => {
    const seen = new Map<string, number>();
    for (const k of kits) if (k.subject) seen.set(k.subject, (seen.get(k.subject) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  }, [kits]);
  const unlockedCount = useMemo(() => kits.filter((k) => k.unlocked).length, [kits]);

  const { shown, matched, more } = useMemo(
    () => visibleKits(kits, { query, subject, language }, highlight, count),
    [kits, query, subject, language, highlight, count],
  );
  const pickSubject = (s: string) => {
    setSubject(s);
    setCount(KIT_CHUNK);
  };
  const pickLanguage = (l: string) => {
    setLanguage(l);
    setCount(KIT_CHUNK);
  };

  // The next chunk counts from what is on screen (the highlight may have
  // stretched the cut past `count`), so "more" always adds cards.
  const nextCount = shown.length + KIT_CHUNK;
  const nextRef = useRef(nextCount);
  useEffect(() => {
    nextRef.current = nextCount;
  }, [nextCount]);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!more || !el || typeof IntersectionObserver === "undefined") return;
    // A margin below the fold: the next chunk is there before she reaches it.
    // Re-observed after every chunk, so a sentinel still in range loads again.
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setCount(nextRef.current);
      },
      { rootMargin: "0px 0px 600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [more, shown.length]);

  // The signup carry-through (`?topic=`): bring its card into view, once.
  const scrolledRef = useRef(false);
  useEffect(() => {
    if (!highlight || scrolledRef.current) return;
    const el = document.getElementById(`kit-${highlight}`);
    if (!el) return;
    scrolledRef.current = true;
    try {
      el.scrollIntoView({ block: "center" });
    } catch {
      /* old browsers */
    }
  }, [highlight]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <button type="button" onClick={() => pickSubject("all")} className={subject === "all" ? CHIP_ON : CHIP_OFF}>
          {t.filterAll} · {kits.length}
        </button>
        {subjects.map((s) => (
          <button key={s} type="button" onClick={() => pickSubject(s)} className={subject === s ? CHIP_ON : CHIP_OFF}>
            {s}
          </button>
        ))}
        {unlockedCount > 0 && (
          <button type="button" onClick={() => pickSubject("unlocked")} className={subject === "unlocked" ? CHIP_ON : CHIP_OFF}>
            {t.filterUnlocked} · {unlockedCount}
          </button>
        )}
        {languages.length > 1 && (
          <span className="flex flex-wrap items-center gap-2 sm:ml-2 sm:pl-2 sm:border-l sm:border-[#E6E8E4]" role="group" aria-label={t.filterLanguage}>
            {["all", ...languages].map((l) => (
              <button key={l} type="button" onClick={() => pickLanguage(l)} className={language === l ? CHIP_ON : CHIP_OFF} lang={l === "all" ? undefined : l}>
                {l === "all" ? t.filterAll : (languageLabel(l) ?? l.toUpperCase())}
              </button>
            ))}
          </span>
        )}
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCount(KIT_CHUNK);
          }}
          placeholder={t.find}
          aria-label={t.find}
          className="ml-auto w-full sm:w-56 h-11 sm:h-auto rounded-lg border border-[#CBD3D1] px-3 py-1.5 text-base sm:text-sm"
        />
      </div>

      {matched === 0 && <p className="text-sm text-[#5B6470]">{kits.length === 0 ? t.empty : t.noMatches}</p>}

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {shown.map((k) => (
          <KitCard
            key={k.kitId}
            kit={k}
            canUnlock={canUnlock}
            resetsLabel={resetsLabel}
            highlighted={highlight !== null && k.slug === highlight}
            classes={classes}
            childTargets={childTargets}
            t={t}
            tLib={tLib}
          />
        ))}
      </div>
      {more && (
        <div ref={sentinelRef} className="mt-6 flex justify-center" data-kits-more={matched - shown.length}>
          <button
            type="button"
            onClick={() => setCount(nextCount)}
            className="min-h-11 sm:min-h-0 rounded-lg border border-[#CBD3D1] bg-white px-4 py-2 text-sm font-medium text-[#1F2A37] hover:bg-[#F3F6F5]"
          >
            {fmt(t.showMore, { n: Math.min(KIT_CHUNK, matched - shown.length) })}
          </button>
        </div>
      )}
    </>
  );
}

// memo: a new chunk (or a filter) re-renders the gallery, not every card
// already on screen — their props are the same objects as before.
const KitCard = memo(function KitCard({
  kit,
  canUnlock,
  resetsLabel,
  highlighted,
  classes,
  childTargets,
  t,
  tLib,
}: {
  kit: KitView;
  canUnlock: boolean;
  resetsLabel: string;
  highlighted: boolean;
  classes: ClassRow[];
  childTargets: ChildRow[] | null;
  t: KitsMessages;
  tLib: LibraryMessages;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  /** the in-app player (a kit with no YouTube video — a translation) */
  const [playing, setPlaying] = useState(false);
  // the stored MP4 failed to load (none stored): play the kit's YouTube video
  const [ytFallback, setYtFallback] = useState(false);
  /** source generation id → the viewer's copy id, once adopted. */
  const [copies, setCopies] = useState<Record<string, string> | null>(null);

  const unlock = async () => {
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await createClient().rpc("unlock_catalogue_kit", { p_topic: kit.topicId });
    setBusy(false);
    const status = (data as { status?: string } | null)?.status;
    if (rpcError || !status) return setError(t.failed);
    if (status === "unlocked" || status === "already") return router.refresh();
    if (status === "weekly_limit") setError(fmt(t.weeklyLimit, { date: resetsLabel }));
    else if (status === "not_available") setError(t.notAvailable);
    else if (status === "forbidden_role") setError(t.ineligibleRole);
    else if (status === "suspended") setError(t.ineligibleSuspended);
    else setError(t.ineligibleOther);
  };

  const addToLibrary = async () => {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const made: Record<string, string> = { ...(copies ?? {}) };
    for (const p of kit.pieces) {
      if (made[p.generationId]) continue;
      const { data, error: rpcError } = await supabase.rpc("adopt_catalogue_piece", { p_source: p.generationId });
      if (rpcError || typeof data !== "string") {
        setBusy(false);
        setError(t.failed);
        if (Object.keys(made).length) setCopies(made); // resume on the next click (idempotent RPC)
        return;
      }
      made[p.generationId] = data;
    }
    setBusy(false);
    setCopies(made);
    router.refresh();
  };

  // Derived here, not shipped (logic.ts): the in-app video, the assignable
  // pieces, and each piece's label and files.
  const video = storageVideo(kit.videoGenerationId);
  const videoHref = video?.videoHref ?? null;
  const posterHref = video?.posterHref ?? null;
  const pieces = useMemo(
    () =>
      kit.pieces.map((p) => ({
        ...p,
        label: kindLabel(tLib, p.kind),
        downloads: downloadsOf(p.kind, p.generationId).map((d) => ({ label: t[d.label], href: d.href })),
      })),
    [kit.pieces, t, tLib],
  );
  const assignableIds = useMemo(() => assignablePieces(kit.pieces).map((p) => p.generationId), [kit.pieces]);
  const copyIds = copies ? assignableIds.map((id) => copies[id]).filter((id): id is string => !!id) : [];
  const adopted = !!copies && copyIds.length === assignableIds.length;
  const thumb = kit.youtubeId ? `https://i.ytimg.com/vi/${encodeURIComponent(kit.youtubeId)}/mqdefault.jpg` : posterHref;
  const facts = [kit.subject, fmt(t.pieces, { n: kit.pieces.length }), kit.questionCount > 0 ? fmt(t.questions, { n: kit.questionCount }) : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <article
      id={`kit-${kit.slug}`}
      data-topic={kit.slug}
      data-unlocked={kit.unlocked ? "true" : "false"}
      className={`card p-3 flex flex-col ${highlighted ? "ring-2 ring-[#0C8175]" : ""}`}
    >
      {videoHref ? (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          className="relative block w-full aspect-video overflow-hidden rounded-lg bg-[#0A0E0D] text-left"
          aria-label={t.watch}
          title={t.watch}
        >
          {thumb && (
            // eslint-disable-next-line @next/next/no-img-element -- a remote YouTube frame; next/image would need a remotePatterns entry for one host
            <img src={thumb} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />
          )}
          <span className="absolute inset-0 m-auto flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white">
            <svg viewBox="0 0 24 24" className="h-4 w-4 translate-x-px" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
          {kit.unlocked && (
            <span className="absolute top-2 left-2 rounded-full bg-[#E6F6F3] px-2 py-0.5 text-[11px] font-medium text-[#0C8175]">{t.unlocked}</span>
          )}
          {kit.language !== "en" && (
            <span className="absolute top-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white">{kit.language.toUpperCase()}</span>
          )}
        </button>
        ) : (
          <a
            href={kit.youtubeId ? youtubeUrl(kit.youtubeId) : lessonPageUrl(kit.slug)}
            target="_blank"
            rel="noreferrer"
            className="relative block aspect-video overflow-hidden rounded-lg bg-[#0A0E0D]"
            aria-label={t.watch}
            title={t.watch}
          >
          {thumb && (
            // eslint-disable-next-line @next/next/no-img-element -- a remote YouTube frame; next/image would need a remotePatterns entry for one host
            <img src={thumb} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />
          )}
          <span className="absolute inset-0 m-auto flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white">
            <svg viewBox="0 0 24 24" className="h-4 w-4 translate-x-px" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
          {kit.unlocked && (
            <span className="absolute top-2 left-2 rounded-full bg-[#E6F6F3] px-2 py-0.5 text-[11px] font-medium text-[#0C8175]">{t.unlocked}</span>
          )}
          {kit.language !== "en" && (
            <span className="absolute top-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white">{kit.language.toUpperCase()}</span>
          )}
        </a>
      )}
      {playing && videoHref && (
        // The lesson, from storage (Kit Translator §5.7; every kit since
        // 2026-10-30): the <video> follows the route's 302 to a signed URL and
        // seeks against it. Nothing signed is rendered into the page. A kit
        // with no stored MP4 (the route answers 404) falls back to its YouTube
        // video, captions off by default (youtubeEmbedUrl).
        <div className="fixed inset-x-0 top-0 h-[100dvh] z-50 flex items-center justify-center bg-black/85 p-4" role="dialog" aria-modal="true" aria-label={kit.title} onClick={() => setPlaying(false)}>
          <div className="w-full max-w-4xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between gap-3 text-white">
              <span className="min-w-0 truncate text-sm font-medium" lang={kit.language}>
                {kit.title}
              </span>
              <button type="button" onClick={() => setPlaying(false)} className="shrink-0 min-h-11 sm:min-h-0 rounded-md px-3 sm:px-2 py-1 text-sm hover:bg-white/10">
                {t.close}
              </button>
            </div>
            {ytFallback && kit.youtubeId ? (
              <iframe
                src={youtubeEmbedUrl(kit.youtubeId, { autoplay: true })}
                title={kit.title}
                allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                className="aspect-video w-full rounded-lg bg-black"
              />
            ) : (
              <video
                controls
                autoPlay
                playsInline
                preload="metadata"
                src={videoHref}
                onError={() => {
                  if (kit.youtubeId) setYtFallback(true);
                }}
                poster={posterHref ?? undefined}
                controlsList="nodownload"
                disablePictureInPicture
                className="aspect-video w-full rounded-lg bg-black"
              />
            )}
          </div>
        </div>
      )}

      <h2 className="font-display text-[15px] leading-snug mt-3 line-clamp-2" title={kit.title}>
        {kit.title}
      </h2>
      <p className="text-xs text-[#5B6470] mt-1">{facts}</p>
      <ul className="mt-2 flex items-center gap-1.5 text-[#5B6470]" aria-label={fmt(t.pieces, { n: kit.pieces.length })}>
        {pieces.map((p) => (
          <li key={p.generationId} title={p.label} className="rounded-md bg-[#F3F6F5] p-1">
            <PieceIcon kind={p.kind} />
            <span className="sr-only">{p.label}</span>
          </li>
        ))}
      </ul>

      <div className="mt-3 pt-3 border-t border-[#E6E8E4]">
        {!kit.unlocked ? (
          <button type="button" onClick={unlock} disabled={busy || !canUnlock} className={BTN_PRIMARY}>
            {busy ? t.unlocking : t.unlock}
          </button>
        ) : (
          <div className="flex gap-1.5">
            <button type="button" onClick={() => setFilesOpen((v) => !v)} className={BTN_ICON} aria-expanded={filesOpen} title={t.downloads}>
              <Glyph d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
              {t.downloads}
            </button>
            {!adopted ? (
              <button type="button" onClick={addToLibrary} disabled={busy} className={BTN_ICON} title={t.addToLibrary}>
                <Glyph d="M12 5v14m-7-7h14" />
                {busy ? t.adding : t.addToLibrary}
              </button>
            ) : (
              <>
                <span className="flex-1 [&>button]:w-full [&>button]:justify-center">
                  <AssignModal label={t.assign} generationIds={copyIds} classes={classes} childTargets={childTargets} t={tLib} />
                </span>
                <a href="/dashboard" className={BTN_ICON} title={t.openLibrary}>
                  <Glyph d="M4 19V5a1 1 0 011-1h3v15H5a1 1 0 01-1-1zm6 0V4h3v15h-3zm6.5-13.8l3.2 14.1-2.9.7-3.2-14.1 2.9-.7z" />
                  <span className="sr-only">{t.openLibrary}</span>
                </a>
              </>
            )}
          </div>
        )}
        {!kit.unlocked && !canUnlock && !error && <p className="text-[11px] text-[#5B6470] mt-2">{fmt(t.weeklyLimit, { date: resetsLabel })}</p>}
        {error && (
          <p role="alert" className="text-[11px] text-[#B42318] mt-2">
            {error}
          </p>
        )}
        {kit.unlocked && filesOpen && (
          <ul className="mt-3 space-y-1.5 text-sm">
            {pieces
              .filter((p) => p.downloads.length > 0)
              .map((p) => (
                <li key={p.generationId} className="flex flex-wrap items-center justify-between gap-x-2">
                  <span className="min-w-0 text-[#1F2A37] flex items-center gap-1.5">
                    <PieceIcon kind={p.kind} /> {p.label}
                  </span>
                  <span className="flex flex-wrap gap-x-3 shrink-0">
                    {p.downloads.map((d) => (
                      <a key={d.href} href={d.href} className="inline-flex items-center min-h-11 sm:min-h-0 text-xs font-medium text-[#0C8175] hover:underline">
                        ⬇ {d.label}
                      </a>
                    ))}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </div>
    </article>
  );
});

function Glyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** One glyph per generation kind, in the Library's vocabulary. An unknown
 * kind gets a plain document. */
function PieceIcon({ kind }: { kind: string }) {
  const d =
    kind === "presentation"
      ? "M8 5v14l11-7z"
      : kind === "deck"
        ? "M3 5h18v11H3zM8 20h8m-4-4v4"
        : kind === "worksheet"
          ? "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"
          : kind === "activity"
            ? "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM16.5 13v7M13 16.5h7"
            : kind === "case_study"
              ? "M4 5a2 2 0 012-2h12a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2zm4 3h8M8 12h8M8 16h5"
              : kind === "exam_paper" || kind === "exam"
                ? "M6 3h9l4 4v14H6zM14 3v5h5M9 13l2 2 4-4"
                : "M6 3h9l4 4v14H6zM14 3v5h5M9 12h6M9 16h6";
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
