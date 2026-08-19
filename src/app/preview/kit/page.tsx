"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { notFound, useSearchParams } from "next/navigation";
import ContentCell, { type CellLesson } from "@/app/dashboard/content-cell";
import ChapterGenerate from "@/app/dashboard/chapter-generate";
import LessonCard, { type CardPart } from "@/app/dashboard/lesson-card";
import RegenerateButton from "@/app/dashboard/regenerate-button";
import GettingStarted from "@/app/dashboard/getting-started";
import PageScanner from "@/app/dashboard/page-scanner";
import type { LibraryMessages } from "@/app/dashboard/content-cell";
// This gallery has no server parent to hand it a dictionary, so it reads the
// message files directly. Safe here and nowhere else: the route notFound()s in
// production, so the whole file (and these imports) only exists in dev.
//
// All TEN, not just English, because the two things this gallery is now used to
// check are both invisible in English: whether a composed part label survives
// RTL (ar / ms-arab), and whether a control sized around a 6-character English
// word still fits a 375px row when the word is "రద్దు చేయండి". `?locale=te`.
import en from "@/i18n/messages/en.json";
import ms from "@/i18n/messages/ms.json";
import ar from "@/i18n/messages/ar.json";
import fr from "@/i18n/messages/fr.json";
import es from "@/i18n/messages/es.json";
import pt from "@/i18n/messages/pt.json";
import te from "@/i18n/messages/te.json";
import mr from "@/i18n/messages/mr.json";
import hi from "@/i18n/messages/hi.json";
import msArab from "@/i18n/messages/ms-arab.json";
import { dirFor, isLocale, DEFAULT_LOCALE, type Locale } from "@/i18n/locales";

// ONLY the three slices this gallery renders. This map used to be typed
// `Record<Locale, typeof en>` — the WHOLE dictionary — which quietly demanded
// more than the i18n contract gives: a locale file is a SUBSET of English by
// design (i18n/dictionaries.ts: `Messages = DeepPartial<Dictionary>`, and
// getDictionary layers English underneath at runtime). Under the old type, an
// English key added anywhere in the dictionary — a new fair-use string, say —
// failed the type-check of a dev-only route that never renders it. Narrowed to
// library/common/utils, this map now breaks only when something it ACTUALLY
// shows goes untranslated, which is the check worth having.
type GalleryMessages = Pick<typeof en, "library" | "common" | "utils">;

const MESSAGES: Record<Locale, GalleryMessages> = {
  en,
  ms,
  ar,
  fr,
  es,
  pt,
  te,
  mr,
  hi,
  "ms-arab": msArab,
};

// DEV-ONLY verification of the REAL redesigned kit cells (ContentCell) in every
// state — done, generating (ring), queued, error, add-back, trial-locked — laid
// out exactly like the dashboard part rows. Not a mockup: this renders the same
// component prod does, so a visual check here is a real check. notFound() in
// production keeps the route out of the live app.

const L = (over: Partial<CellLesson>): CellLesson => ({
  id: Math.random().toString(36).slice(2),
  status: "done",
  progress: 100,
  video: null,
  deck: null,
  doc: null,
  params: null,
  artifactPaths: [],
  ...over,
});

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 ps-4 py-2.5 border-t border-[#EEF0EC] text-xs">
      <span className="w-28 shrink-0 text-[#5B6470]">{label}</span>
      {children}
    </div>
  );
}

// useSearchParams makes the client tree up to the nearest Suspense boundary
// client-rendered, and Next requires that boundary to exist — hence the split.
// It is also why the locale is NOT read with `window.location` + setState in an
// effect: that is a cascading render (react-hooks/set-state-in-effect), and
// reading location during render desyncs hydration. useSearchParams is the one
// route that is neither.
export default function KitPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense>
      <KitPreview />
    </Suspense>
  );
}

function KitPreview() {
  const [showScanner, setShowScanner] = useState(false);
  const wanted = useSearchParams().get("locale");
  const locale: Locale = isLocale(wanted) ? wanted : DEFAULT_LOCALE;

  const T: LibraryMessages = useMemo(() => {
    const m = MESSAGES[locale];
    return { ...m.library, common: m.common, utils: m.utils };
  }, [locale]);
  const COMMON = useMemo(
    () => ({ bookId: "demo", schoolId: null, chapterNum: 0, t: T }),
    [T],
  );

  // ?open=<label> auto-clicks a trigger so a screenshot can capture a dialog
  // (including the scanner's "Scan pages (demo)" button).
  useEffect(() => {
    const want = new URLSearchParams(window.location.search).get("open");
    if (!want) return;
    const t = setTimeout(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      btns.find((b) => (b.textContent || "").includes(want))?.click();
    }, 250);
    return () => clearTimeout(t);
  }, []);

  const doc = (over: Partial<CellLesson> = {}) => L({ doc: "#", ...over });
  const pres = (over: Partial<CellLesson> = {}) => L({ video: "#", deck: "#", ...over });

  // An RTL chapter name in the RTL locales, so the bidi check is a real one: a
  // Latin+digit "Part 3 of 7" run beside an Arabic-script heading is precisely
  // the mix that reorders when the label is not isolated.
  const chapterTitle =
    locale === "ar" ? "الخلايا والأنسجة" : locale === "ms-arab" ? "سيل دان تيسو" : "Cells";
  const CARD = { ...COMMON, classes: [], chapterTitle };

  const part = (n: number, over: Partial<CardPart> = {}): CardPart => ({
    n,
    // A 7-part chapter, so every card can show "Part k of 7" — the total is
    // half of what makes an ordinal mean anything.
    total: 7,
    titles: [],
    presentation: pres(),
    lessonPlan: doc(),
    activity: doc(),
    worksheet: doc(),
    exam: doc(),
    caseStudy: doc(),
    ...over,
  });

  return (
    // dir on the wrapper, because the real app sets it on <html> from the
    // locale and every logical property (ps-/me-/text-start) resolves from it.
    // Without this the RTL locales would render LTR here and the bidi check
    // would prove nothing.
    <div dir={dirFor(locale)} className="min-h-screen bg-[#FCFCFA] text-[#14181F] py-10">
      <div className="max-w-7xl mx-auto px-6">
        <p className="text-xs text-[#98A0A9] mb-3">
          Locale: <b>{locale}</b> ({dirFor(locale)}) — switch with{" "}
          <code>?locale=te</code>, <code>?locale=ar</code>, <code>?locale=ms-arab</code>, …
        </p>
        {/* The REAL page scanner, opened by a button (never from render or an
            effect — reading location while rendering desyncs hydration). */}
        <button onClick={() => setShowScanner(true)} className="btn-ghost h-9 px-3 text-sm mb-3">
          Scan pages (demo)
        </button>
        {showScanner && <PageScanner t={T} onDone={() => setShowScanner(false)} onClose={() => setShowScanner(false)} />}
        <p className="text-xs text-[#98A0A9] mb-2">Preview · redesigned lesson cards (direction 1) — dev only.</p>
        <div className="card overflow-hidden bg-[#EEF3F1] mb-10">
          <div className="px-5 py-4 space-y-2">
            {/* Real prod data: a bare numeral leaked in as a title, and single-
                section parts just repeat the chapter name — both suppressed, so
                this card has NO usable heading and must fall back to the
                chapter-anchored label, never to a bare "Part 1". */}
            <LessonCard {...CARD} part={part(1, { titles: ["1", chapterTitle] })} />
            {/* The regression this whole change is about: the worker now writes
                an EMPTY titles list where it used to write ["Content"], so this
                is the commonest card in production. It must read
                "<chapter> · Part 2 of 7" — "Part 2" alone is the exact string
                the founder's rule forbids. */}
            <LessonCard {...CARD} part={part(2, { titles: [] })} />
            {/* Same shape, but the placeholder still stored on older books. */}
            <LessonCard {...CARD} part={part(3, { titles: ["Content"] })} />
            <LessonCard {...CARD} part={part(1, { titles: ["What a cell is", "Cell structure and using a microscope"] })} />
            <LessonCard {...CARD} part={part(2, {
              titles: ["Plant and animal cells"],
              presentation: pres({ status: "processing", progress: 45, video: null, deck: null }),
              worksheet: doc({ status: "processing", progress: 12, doc: null }),
              exam: doc({ status: "queued", progress: 0, doc: null }),
            })} />
            {/* Queued (0078): the delete control becomes a free **Cancel** —
                nothing has run, so removing it voids the ledger row and the
                credit comes back. Part 2 above is the contrast: once the job
                is claimed the same control is deliberately inert, because that
                credit is charged and cannot be given back. */}
            <LessonCard {...CARD} part={part(7, {
              titles: ["A lesson still in the queue"],
              presentation: pres({ status: "queued", progress: 0, video: null, deck: null }),
            })} />
            <LessonCard {...CARD} part={part(3, {
              titles: ["Specialised cells"],
              worksheet: null,
              caseStudy: doc({ status: "error" }),
            })} />
            <LessonCard {...CARD} part={part(4, {
              titles: ["Cells, tissues and organs"],
              presentation: null, lessonPlan: null, activity: null, worksheet: null, exam: null, caseStudy: null,
            })} />
            <LessonCard {...CARD} locked part={part(5, { titles: ["A locked part"], presentation: null })} />
            <LessonCard {...CARD} part={part(6, {
              titles: ["A long lesson"],
              presentation: pres({ videos: ["#", "#", "#"], decks: ["#", "#", "#"] }),
            })} />
            {/* A chapter with exactly one part: no ordinal at all. "Part 1 of 1"
                is noise, and a re-index that shrinks a part map used to emit it. */}
            <LessonCard {...CARD} part={part(1, { total: 1, titles: [] })} />
          </div>
        </div>

        <p className="text-xs text-[#98A0A9] mb-2">
          Regenerate → “New version”: click one to see the honest dialog (dev only; counts come back 0 here).
        </p>
        <div className="card bg-white px-5 py-4 mb-10 flex flex-wrap items-center gap-5">
          <RegenerateButton bookId="demo" schoolId={null} chapterRef={0} kind="exam_paper" oldGenId="demo-exam" />
          <RegenerateButton bookId="demo" schoolId={null} chapterRef={0} icon kind="presentation" oldGenId="demo-pres" />
          <RegenerateButton bookId="demo" schoolId={null} chapterRef={0} icon kind="worksheet" oldGenId="demo-ws" />
        </div>

        <p className="text-xs text-[#98A0A9] mb-4">Preview · the REAL ContentCell in every state (dev only).</p>

        <div className="card overflow-hidden bg-[#EEF3F1]">
          <div className="px-5 py-3">
            {/* Fully generated — every artifact + Assign on one line. Post-split
                (2026-08-18) documents also carry the separate answer key. */}
            <Row label="Part 1 (done)">
              <ContentCell {...COMMON} kind="presentation" label="Lesson" lesson={pres()} />
              <ContentCell {...COMMON} kind="lesson_plan" label="Plan" lesson={doc()} />
              <ContentCell {...COMMON} kind="activity" label="Activities" lesson={doc()} />
              <ContentCell {...COMMON} kind="worksheet" label="Worksheet" lesson={doc({ answerKey: "#" })} />
              <ContentCell {...COMMON} kind="exam_paper" label="Test paper" lesson={doc({ answerKey: "#" })} />
              <ContentCell {...COMMON} kind="case_study" label="Case study" lesson={doc()} />
            </Row>

            {/* Generating — rings; the video shows %/ETA, done docs show ⬇. */}
            <Row label="Part 2 (generating)">
              <ContentCell {...COMMON} kind="presentation" label="Lesson" lesson={pres({ status: "processing", progress: 45, video: null, deck: null })} />
              <ContentCell {...COMMON} kind="lesson_plan" label="Plan" lesson={doc()} />
              <ContentCell {...COMMON} kind="activity" label="Activities" lesson={doc({ status: "processing", progress: 62, doc: null })} />
              <ContentCell {...COMMON} kind="worksheet" label="Worksheet" lesson={doc({ status: "processing", progress: 12, doc: null })} />
              <ContentCell {...COMMON} kind="exam_paper" label="Test paper" lesson={doc({ status: "queued", progress: 0, doc: null })} />
              <ContentCell {...COMMON} kind="case_study" label="Case study" lesson={doc({ status: "queued", progress: 0, doc: null })} />
            </Row>

            {/* Multi-video presentation — one line per part, stacked. */}
            <Row label="Long chapter">
              <ContentCell {...COMMON} kind="presentation" label="Lesson" lesson={pres({ videos: ["#", "#", "#"], decks: ["#", "#", "#"] })} />
              <ContentCell {...COMMON} kind="worksheet" label="Worksheet" lesson={doc()} />
            </Row>

            {/* Add-back + error + trial lock. */}
            <Row label="Edge cases">
              <ContentCell {...COMMON} kind="worksheet" label="Worksheet" lesson={null} />
              <ContentCell {...COMMON} kind="lesson_plan" label="Plan" lesson={doc({ status: "error" })} />
              <ContentCell {...COMMON} kind="case_study" label="Case study" lesson={null} genLocked />
            </Row>

            {/* Not generated — the whole row is just this. */}
            <div className="flex items-center gap-x-2 ps-4 py-2.5 border-t border-[#EEF0EC] text-xs">
              <span className="w-28 shrink-0 text-[#5B6470]">Part 3 (new)</span>
              <span className="text-[13px] text-[#98A0A9]">→ dashboard shows only a “Generate kit” button here</span>
            </div>
          </div>
        </div>

        <p className="text-[11px] text-[#98A0A9] mt-4">
          Every done artifact shows its ✕ — no hover reveal, because hover does not exist on a phone.
          Rings = live progress. ↻ regenerates. A lesson being built shows an inert ✕ that, when tapped,
          reveals why.
        </p>

        {/* Chunked lesson at CHAPTER level — the REAL ChapterGenerate swaps its
            flat wrap for one bordered card: Pt chips first, docs attached. */}
        <p className="text-xs text-[#98A0A9] mt-10 mb-2">Chapter row with a chunked lesson (REAL ChapterGenerate) — dev only.</p>
        <div className="card overflow-hidden bg-[#EEF3F1] mb-10">
          <div className="px-5 py-3">
            <ChapterGenerate
              {...COMMON}
              classes={[]}
              lessons={{
                presentation: pres({ videos: ["#", "#", "#"], decks: ["#", "#", "#"] }),
                lesson_plan: doc(),
                activity: doc(),
                worksheet: doc(),
                exam_paper: doc(),
                case_study: doc(),
              }}
            />
          </div>
        </div>

        <p className="text-xs text-[#98A0A9] mt-10 mb-3">Getting-started stepper — fresh / mid / done:</p>
        <div className="grid gap-4 sm:grid-cols-3 items-start">
          <GettingStarted userId="preview" steps={{ upload: false, generate: false, assign: false }} />
          <GettingStarted userId="preview" steps={{ upload: true, generate: false, assign: false }} />
          <GettingStarted userId="preview" steps={{ upload: true, generate: true, assign: true }} />
        </div>
      </div>
    </div>
  );
}
