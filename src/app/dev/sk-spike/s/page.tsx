import { notFound } from "next/navigation";
import SpikePlayer from "../player";

// SK S1 spike harness — Option S: the scene engine's clip as the main clock,
// with the ERE overlay (in the clip's world coordinates) for the live aside.
// DEV ONLY — 404 on a production build.
export const dynamic = "force-static";

export default function SkSpikeOptionSPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="min-h-screen bg-[#F6F7F5] p-4">
      <h1 className="font-display text-lg mb-1">SK S1 spike — Option S (scene-engine clip + ERE overlay)</h1>
      <p className="text-xs text-[#667085] mb-3">
        Same unit, same audio and cue times as Option E; the board is rendered by the production video engine. Space = interrupt.
      </p>
      <SpikePlayer base="/sk-s1/u4/" mode="S" />
    </main>
  );
}
