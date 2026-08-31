"use client";

import ContentCell, { kindLabel, type CellLesson, type LibraryMessages } from "./content-cell";
import AssignModal, { type ChildRow, type ClassRow } from "./assign-modal";
import GenerateKitButton from "./generate-kit-button";
import RegenerateButton from "./regenerate-button";
import { type JunkGateInfo } from "./junk-gate-dialog";
import DeleteLesson from "./delete-lesson";
import AskCoachButton from "./ask-coach-button";
import { recordArtifactView } from "@/utils/views";
import { etaLabel } from "@/utils/job-stage";
import { cleanPartTitles, partAnchor, partHeading, partLabel } from "@/utils/part-label";
import { fmt } from "@/i18n/format";

// Preview-first lesson card (2026-07-21): a part's kit shown as a card — a deck
// preview with a play affordance, the lesson's real title, and its documents as
// chips — instead of a row of underlined links. The video "Watch" is the
// thumbnail; every document reuses ContentCell (so all of its state logic —
// progress rings, add-backs, retries, regenerate, delete — is preserved), just
// wrapped in a chip. Ungenerated parts show a single "Generate kit" card.

export type CardPart = {
  n: number;
  /** How many parts this chapter has. Required, not optional: it is what turns
   *  a bare "Part 3" into "<chapter> · Part 3 of 7", and an optional field with
   *  a default is exactly how the chapter name went missing here in the first
   *  place. A single-part chapter (total 1) suppresses the ordinal entirely. */
  total: number;
  titles: string[];
  presentation: CellLesson | null;
  lessonPlan: CellLesson | null;
  activity: CellLesson | null;
  worksheet: CellLesson | null;
  exam: CellLesson | null;
  caseStudy: CellLesson | null;
};

// Document kinds shown as chips (the presentation is the thumbnail, not a chip).
// Second element is the matching CardPart field; the chip's wording comes from
// the dictionary via kindLabel(), keyed by the kind itself.
const DOCS = [
  ["lesson_plan", "lessonPlan"],
  ["activity", "activity"],
  ["worksheet", "worksheet"],
  ["exam_paper", "exam"],
  ["case_study", "caseStudy"],
] as const;

function PlayGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden className="shrink-0">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
function DownloadGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="inline-block align-[-1px] shrink-0" aria-hidden>
      <path d="M12 3v12m0 0l4-4m-4 4l-4-4" />
      <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
    </svg>
  );
}
function Ring({ pct, size = 22 }: { pct: number; size?: number }) {
  const stroke = 2.6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E6E8E4" strokeWidth={stroke} />
      {pct > 0 && (
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1FB8A6" strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(100, Math.max(0, pct)) / 100)} />
      )}
    </svg>
  );
}

// A mini "deck slide" drawn in CSS — echoes compose_slide (teal number badge +
// heading + a figure block). We have no rendered poster yet, so this stands in as
// the preview; when the video is ready its play button opens it.
function SlideThumb({ n, title, video, processing, pct, trackId, watchHint }: {
  n: number; title: string; video?: string | null; processing?: boolean; pct?: number; trackId?: string | null;
  watchHint: string;
}) {
  const slide = (
    <div className="absolute inset-0 rounded-lg bg-white border border-[#DCE6E2] overflow-hidden">
      <span className="absolute top-2 start-2 flex h-4 w-4 items-center justify-center rounded-full bg-[#1FB8A6] text-[10px] font-medium text-[#04342C]">{n}</span>
      {/* <bdi>: the label can mix an RTL chapter name with the Latin/digit run
          "Part 3 of 7", and without isolation the bidi algorithm reorders them
          against each other. Same wrapper on every render site of a composed
          part label — see utils/part-label.ts. */}
      <span className="absolute top-2.5 start-7 end-2 text-[8px] font-medium text-[#14181F] truncate"><bdi>{title}</bdi></span>
      <span className="absolute top-[19px] start-7 h-[3px] w-8 rounded-full bg-[#E2F4F1]" />
      <span className="absolute bottom-2.5 end-3 h-7 w-9 rounded-md border-2 border-[#1FB8A6] bg-[#F4FBF9]" />
      <span className="absolute bottom-3.5 start-3 h-[3px] w-9 rounded-full bg-[#EEF0EC]" />
      <span className="absolute bottom-2.5 start-3 h-[3px] w-6 rounded-full bg-[#EEF0EC]" />
    </div>
  );
  const overlay = processing ? (
    <div className="absolute inset-0 flex items-center justify-center bg-white/45">
      <Ring pct={pct ?? 0} />
    </div>
  ) : video ? (
    <div className="absolute inset-0 flex items-center justify-center">
      {/* pl-, not ps-: the triangle is a media TRANSPORT control, so it points
          right in every locale, and the optical nudge that centres it has to
          stay on the same physical side. */}
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#14181F]/60 text-white pl-0.5"><PlayGlyph /></span>
    </div>
  ) : null;
  // Narrower on a phone. At 375px the fixed 128px thumb left the title column
  // 64px — measured — which is fewer than eight characters, so a part label that
  // now carries a chapter name AND "Part k of n" was clipped to the first word.
  // 100px gives the label back ~28px and costs a preview nobody reads at that
  // size; the full breakpoint is unchanged.
  const body = <div className="relative h-[58px] w-[100px] sm:h-[74px] sm:w-[128px] shrink-0">{slide}{overlay}</div>;
  return video && !processing ? (
    <a href={video} target="_blank" onClick={() => trackId && recordArtifactView(trackId, "video_mp4")} className="block hover:opacity-95" title={watchHint}>
      {body}
    </a>
  ) : body;
}

// One document artifact as a chip — ContentCell does the real work (states,
// add-back, retry, regenerate, delete); the pill is just its frame.
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[#DCE6E2] bg-white px-2.5 py-1 leading-none">
      {children}
    </span>
  );
}

export default function LessonCard({
  bookId,
  schoolId,
  chapterNum,
  part,
  classes,
  childTargets = null,
  t,
  chapterTitle = "",
  bookTitle = null,
  locked = false,
  trackViews = false,
  bookLanguage = null,
  bookGrade = null,
  gate = null,
}: {
  bookId: string;
  schoolId: string | null;
  chapterNum: number;
  part: CardPart;
  classes: ClassRow[];
  /** Parent-role viewers: linked children for direct assignment (null = class mode). */
  childTargets?: ChildRow[] | null;
  t: LibraryMessages;
  /** Used to suppress a part title that just repeats the chapter heading. */
  chapterTitle?: string;
  /** Named in the failure report a teacher emails to staff. */
  bookTitle?: string | null;
  locked?: boolean;
  trackViews?: boolean;
  bookLanguage?: string | null;
  bookGrade?: string | null;
  /** Junk-upload gate: non-null for a gated book — threaded to every control
      on this card that inserts generation rows. */
  gate?: JunkGateInfo | null;
}) {
  const pres = part.presentation;
  const generated = !!pres && pres.status !== "error";

  // How a part is NAMED. The founder's rule, verbatim: "ensure that all parts
  // carry the chapter name and part number and not just say part 1, part 2".
  //
  // This card used to compute `titles[0] || fmt(t.part, {n})` — so a part whose
  // section headings were all unusable (bare numerals, the structurer's
  // "Content" placeholder, or an echo of the chapter name) rendered as the
  // literal string the rule forbids. The rules now live in utils/part-label.ts,
  // a line-for-line mirror of the worker's shared/part_label.py, so the Library
  // card and the stored generations.title cannot drift apart again — which is
  // how the two came to disagree in the first place.
  const heading = partHeading(part.titles, chapterTitle);
  const anchor = partAnchor(t, chapterTitle, part.n, part.total);
  const title = heading ?? anchor;
  // When a real heading takes the title row, the anchor drops to the meta line:
  // the chapter name and "Part k of n" are on the card either way, never only
  // one of them and never neither.
  const extras = cleanPartTitles(part.titles, chapterTitle).slice(1);
  const subtitle = [heading ? anchor : "", ...extras].filter(Boolean).join(" · ");
  // One string, for the tooltip — the full composer, same shape the worker
  // persists ("<chapter> · Part 3 of 7 — Balancing loops").
  const fullLabel = partLabel(t, {
    chapterTitle,
    part: part.n,
    total: part.total,
    titles: part.titles,
  });

  // Trial (0057): this part isn't the pinned unit — a muted, non-actionable card.
  if (locked) {
    return (
      <div className="flex items-center gap-3.5 rounded-xl border border-dashed border-[#DCE6E2] bg-[#E1E8E5] px-3.5 py-3">
        <div className="h-[74px] w-[128px] shrink-0 rounded-lg border border-dashed border-[#DCE6E2] bg-[#D8E1DD] flex items-center justify-center text-[#C6CBC4]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg>
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-[#5B6470] truncate"><bdi>{title}</bdi></div>
          <div className="text-xs text-[#98A0A9]"><bdi>{fmt(t.card.trialOnePart, { part: subtitle || anchor })}</bdi></div>
        </div>
      </div>
    );
  }

  // Not generated: one clear card with a single "Generate kit" action.
  if (!generated) {
    return (
      // The WHOLE card is the button — a part that doesn't exist yet has exactly
      // one thing to do, so the click target is the card, not a link at its edge.
      <GenerateKitButton
        bookId={bookId}
        schoolId={schoolId}
        chapterNum={chapterNum}
        part={part.n}
        language={bookLanguage}
        bookGrade={bookGrade}
        gate={gate}
        t={t}
        className="group/new w-full text-start flex items-center gap-3.5 rounded-xl border border-dashed border-[#C3D0CB] bg-[#E1E8E5] px-3.5 py-3 transition-colors hover:bg-[#E9EFEC] hover:border-[#1FB8A6] disabled:opacity-70"
        skipKinds={(
          [
            ["lesson_plan", part.lessonPlan],
            ["activity", part.activity],
            ["worksheet", part.worksheet],
            ["exam_paper", part.exam],
            ["case_study", part.caseStudy],
          ] as const
        )
          .filter(([, l]) => l && l.status !== "error")
          .map(([k]) => k)}
      >
        {({ busy }) => (
          <>
            <span className="h-[74px] w-[128px] shrink-0 rounded-lg border border-dashed border-[#C3D0CB] bg-[#D8E1DD] flex items-center justify-center text-[#B7C1B9] transition-colors group-hover/new:border-[#1FB8A6] group-hover/new:text-[#0C8175]">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
            </span>
            <span className="min-w-0 flex-1">
              {/* Ink is dialled back on the filled card so a made lesson (white,
                  full-contrast) still wins the eye. */}
              <span className="block text-sm font-medium text-[#556059] truncate"><bdi>{title}</bdi></span>
              {/* Don't repeat the heading: when the title already IS the
                  chapter-anchored label, the meta line drops it. */}
              <span className="block text-xs text-[#87938D] truncate">
                <bdi>{subtitle ? `${subtitle} · ` : ""}{t.card.notGenerated}</bdi>
              </span>
            </span>
            <span className="shrink-0 text-[13px] font-medium text-[#0C8175]">
              {busy ? t.queuing : t.card.generateKit}
            </span>
          </>
        )}
      </GenerateKitButton>
    );
  }

  // Generated. Presentation states drive the thumbnail; documents are chips.
  const p = pres!;
  const processing = p.status === "queued" || p.status === "processing";
  const videos = p.videos?.length ? p.videos : p.video ? [p.video] : [];
  const decks = p.decks?.length ? p.decks : p.deck ? [p.deck] : [];
  // TEMPORARY (2026-08-31): founder-only "Save" links, index-aligned with
  // `videos`. Empty for every other account. See @/utils/video-download.
  const videoDownloads = p.videoDownloads ?? [];
  const multi = Math.max(videos.length, decks.length) > 1;
  const eta =
    p.status === "processing" ? etaLabel("presentation", p.progress, p.stage, t.utils.job) : "";

  const assignable = [part.presentation, part.worksheet, part.exam]
    .filter((l): l is CellLesson => !!l && l.status === "done")
    .map((l) => l.id);

  return (
    <div className="group/card flex gap-3.5 rounded-xl border border-[#DCE6E2] bg-white px-3.5 py-3">
      <SlideThumb
        n={part.n}
        title={title}
        video={!processing && !multi ? videos[0] : null}
        processing={processing}
        pct={p.progress}
        trackId={trackViews ? p.id : null}
        watchHint={t.card.watchLesson}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {/* Two lines on a phone, one on a desktop. `truncate` alone put the
                chapter name and the ordinal in competition for ~90px and the
                ordinal always lost — which is the requirement failing on the
                only screen half these teachers own. */}
            <div className="text-sm font-medium line-clamp-2 sm:truncate" title={fullLabel}><bdi>{title}</bdi></div>
            <div className="text-xs text-[#98A0A9] truncate">
              <bdi>{subtitle}</bdi>
              {processing && (
                <span className="text-[#9A6400]">
                  {subtitle ? " · " : ""}
                  {fmt(t.utils.job.percent, { pct: p.progress })}
                  {eta ? ` · ${eta}` : ""}
                </span>
              )}
            </div>
          </div>
          {/* Lesson-level controls: regenerate + delete/cancel.
              The delete used to be `opacity-0 group-hover/card:opacity-100`.
              A hover-only reveal does not exist on touch — that is the exact
              pattern that made the scanner's manual-crop control unreachable
              on every phone and got reported as "frozen" — and this control is
              now the free Cancel while a lesson is queued, which is precisely
              when a teacher on a phone needs to reach it. It stays visible. */}
          <span className="flex items-center gap-1 shrink-0">
            <RegenerateButton
              icon
              bookId={bookId}
              schoolId={schoolId}
              chapterRef={chapterNum}
              kind="presentation"
              params={p.params}
              oldGenId={p.id}
              oldArtifactPaths={p.artifactPaths}
              gate={gate}
            />
            <DeleteLesson genId={p.id} status={p.status} t={t} />
          </span>
        </div>

        {/* Artifact chips: Deck + Ask Coach + the five documents. */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px]">
          {multi ? (
            // Long lesson: one Watch·Deck chip per rendered part.
            Array.from({ length: Math.max(videos.length, decks.length) }, (_, i) => (
              <Chip key={i}>
                <span className="text-[#98A0A9] me-1.5">{fmt(t.partShort, { n: i + 1 })}</span>
                {videos[i] && (
                  <a href={videos[i]} target="_blank" onClick={() => trackViews && recordArtifactView(p.id, "video_mp4")} className="inline-flex items-center gap-1 font-medium text-[#0C8175] hover:underline">
                    <span className="text-[#1FB8A6]"><PlayGlyph size={12} /></span>{t.watch}
                  </a>
                )}
                {/* TEMPORARY founder-only download — English literal, no view
                    tracking; see the note in content-cell.tsx. */}
                {videoDownloads[i] && (
                  <a href={videoDownloads[i]!} className="inline-flex items-center gap-1 font-medium text-[#0C8175] hover:underline ms-2">
                    <span className="text-[#1FB8A6]"><DownloadGlyph /></span>Save
                  </a>
                )}
                {decks[i] && (
                  <a href={decks[i]} onClick={() => trackViews && recordArtifactView(p.id, "deck_pptx")} className="inline-flex items-center gap-1 font-medium text-[#0C8175] hover:underline ms-2">
                    <span className="text-[#1FB8A6]"><DownloadGlyph /></span>{t.deck}
                  </a>
                )}
              </Chip>
            ))
          ) : (
            <>
              {/* TEMPORARY founder-only download. Single-part cards have no
                  Watch link (the thumbnail is the play affordance), so Save
                  gets its own chip rather than riding the deck's. */}
              {videoDownloads[0] && (
                <Chip>
                  <a href={videoDownloads[0]!} className="inline-flex items-center gap-1 font-medium text-[#0C8175] hover:underline">
                    <span className="text-[#1FB8A6]"><DownloadGlyph /></span>Save
                  </a>
                </Chip>
              )}
              {decks[0] && (
                <Chip>
                  <a href={decks[0]} onClick={() => trackViews && recordArtifactView(p.id, "deck_pptx")} className="inline-flex items-center gap-1 font-medium text-[#0C8175] hover:underline">
                    <span className="text-[#1FB8A6]"><DownloadGlyph /></span>{t.deck}
                  </a>
                </Chip>
              )}
            </>
          )}

          {DOCS.map(([kind, field]) => {
            const lesson = part[field];
            return (
              <Chip key={kind}>
                <ContentCell
                  bookId={bookId}
                  schoolId={schoolId}
                  chapterNum={chapterNum}
                  kind={kind}
                  label={kindLabel(t, kind)}
                  lesson={lesson}
                  part={part.n}
                  trackViews={trackViews}
                  bookLanguage={bookLanguage}
                  bookTitle={bookTitle}
                  gate={gate}
                  t={t}
                />
              </Chip>
            );
          })}

          <span className="inline-flex items-center">
            <AskCoachButton generationId={p.id} chapterLabel={fmt(t.chapter, { n: chapterNum + 1 })} className="font-medium text-[#0C8175] hover:underline px-1" />
          </span>

          {assignable.length > 0 && (
            <span className="ms-auto">
              <AssignModal label={t.assign} generationIds={assignable} classes={classes} childTargets={childTargets} t={t} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
