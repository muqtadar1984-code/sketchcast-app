"use client";

import { useEffect, useState } from "react";
import { notFound } from "next/navigation";
import ContentCell, { type CellLesson } from "@/app/dashboard/content-cell";
import ChapterGenerate from "@/app/dashboard/chapter-generate";
import LessonCard, { type CardPart } from "@/app/dashboard/lesson-card";
import RegenerateButton from "@/app/dashboard/regenerate-button";
import GettingStarted from "@/app/dashboard/getting-started";
import PageScanner from "@/app/dashboard/page-scanner";
import type { LibraryMessages } from "@/app/dashboard/content-cell";
// This gallery has no server parent to hand it a dictionary, so it reads the
// ENGLISH messages directly. Safe here and nowhere else: the route notFound()s
// in production, so the whole file (and this import) only exists in dev.
import en from "@/i18n/messages/en.json";

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

const T: LibraryMessages = { ...en.library, common: en.common, utils: en.utils };
const COMMON = { bookId: "demo", schoolId: null, chapterNum: 0, t: T };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 ps-4 py-2.5 border-t border-[#EEF0EC] text-xs">
      <span className="w-28 shrink-0 text-[#5B6470]">{label}</span>
      {children}
    </div>
  );
}

export default function KitPreview() {
  if (process.env.NODE_ENV === "production") notFound();

  const [showScanner, setShowScanner] = useState(false);

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

  const part = (n: number, over: Partial<CardPart> = {}): CardPart => ({
    n,
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
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F] py-10">
      <div className="max-w-7xl mx-auto px-6">
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
                section parts just repeat the chapter name — both suppressed. */}
            <LessonCard {...COMMON} classes={[]} chapterTitle="Cells" part={part(1, { titles: ["1", "Cells"] })} />
            <LessonCard {...COMMON} classes={[]} part={part(1, { titles: ["What a cell is", "Cell structure and using a microscope"] })} />
            <LessonCard {...COMMON} classes={[]} part={part(2, {
              titles: ["Plant and animal cells"],
              presentation: pres({ status: "processing", progress: 45, video: null, deck: null }),
              worksheet: doc({ status: "processing", progress: 12, doc: null }),
              exam: doc({ status: "queued", progress: 0, doc: null }),
            })} />
            <LessonCard {...COMMON} classes={[]} part={part(3, {
              titles: ["Specialised cells"],
              worksheet: null,
              caseStudy: doc({ status: "error" }),
            })} />
            <LessonCard {...COMMON} classes={[]} part={part(4, {
              titles: ["Cells, tissues and organs"],
              presentation: null, lessonPlan: null, activity: null, worksheet: null, exam: null, caseStudy: null,
            })} />
            <LessonCard {...COMMON} classes={[]} locked part={part(5, { titles: ["A locked part"], presentation: null })} />
            <LessonCard {...COMMON} classes={[]} part={part(6, {
              titles: ["A long lesson"],
              presentation: pres({ videos: ["#", "#", "#"], decks: ["#", "#", "#"] }),
            })} />
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
            {/* Fully generated — every artifact + Assign on one line. */}
            <Row label="Part 1 (done)">
              <ContentCell {...COMMON} kind="presentation" label="Lesson" lesson={pres()} />
              <ContentCell {...COMMON} kind="lesson_plan" label="Plan" lesson={doc()} />
              <ContentCell {...COMMON} kind="activity" label="Activities" lesson={doc()} />
              <ContentCell {...COMMON} kind="worksheet" label="Worksheet" lesson={doc()} />
              <ContentCell {...COMMON} kind="exam_paper" label="Test paper" lesson={doc()} />
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
          Hover a done artifact to reveal its ✕. Rings = live progress. ↻ regenerates.
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
