import { notFound } from "next/navigation";
import { Suspense } from "react";
import UnitPlayer from "./player";

// SK B2 harness — DEV ONLY (404 on a production build). Plays the six
// prepared Chapter 2 units (B3 packager output under public/sk-s1/ch02) on
// the board runtime in Option S mode: the clip is the clock, the hit map is
// the scene graph, live asides draw on the overlay. `?unit=s1..s6`;
// `&auto=interrupt:20` / `&auto=reload:10` run the §5.3 trials.
export const dynamic = "force-static";

export default function SkPlayerPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="min-h-screen bg-[#F6F7F5] p-4">
      <h1 className="font-display text-lg mb-1">SK B2 — board player on Chapter 2 (S clips + E overlay)</h1>
      <p className="text-xs text-[#667085] mb-3">
        One board model: the packager&apos;s clip carries the prepared teaching, its hit map places the live overlay and the avatar&apos;s gestures.
        Space = ask (barge-in). Measurements are in the panel and downloadable as JSON for the B2 report.
      </p>
      <Suspense fallback={<div className="text-xs text-[#667085]">loading…</div>}>
        <UnitPlayer />
      </Suspense>
    </main>
  );
}
