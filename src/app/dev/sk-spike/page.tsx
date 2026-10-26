import { notFound } from "next/navigation";
import SpikePlayer from "./player";

// SK S1 spike harness — DEV ONLY. Returns 404 on a production build so the
// page, its fixtures and its measurements never ship. Option E: the ERE board
// extended into a pausable, audio-clocked lesson player.
export const dynamic = "force-static";

export default function SkSpikePage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="min-h-screen bg-[#F6F7F5] p-4">
      <h1 className="font-display text-lg mb-1">SK S1 spike — Option E (ERE player)</h1>
      <p className="text-xs text-[#667085] mb-3">
        Unit U4 “Total magnification”, Biology ch.2. Space = interrupt (push-to-talk). Measurements are logged to the panel and
        downloadable as JSON for the S1 report.
      </p>
      <SpikePlayer base="/sk-s1/u4/" />
    </main>
  );
}
