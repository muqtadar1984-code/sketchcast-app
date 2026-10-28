import { readFile } from "node:fs/promises";
import { notFound } from "next/navigation";
import { getDictionary } from "@/i18n/dictionaries";
import type { BoardManifest } from "@/app/present/board-controller";
import Harness from "./harness-client";

// SK spike M2 harness — DEV ONLY. The REAL Board (BoardSession: stage, roll,
// store, wrap-up) mounted with an in-memory network seam and a local kit video,
// so SK's BoardController can be driven headlessly from `window.__skBoard`
// without a login and without a single production write.
//
// Video: SK_M2_VIDEO_PATH (an mp4 on disk, streamed by ./video). Segments:
// SK_M2_MANIFEST_PATH ({ segments: [{ start_s, end_s }] }). Neither is committed.
export const dynamic = "force-dynamic";

export default async function SkBoardHarnessPage() {
  if (process.env.NODE_ENV !== "development") notFound();

  const t = (await getDictionary("en")).present;
  let manifest: BoardManifest = { segments: [] };
  const mp = process.env.SK_M2_MANIFEST_PATH;
  if (mp) {
    try {
      const raw = JSON.parse(await readFile(mp, "utf8")) as { segments?: unknown };
      if (Array.isArray(raw.segments)) {
        manifest = {
          segments: raw.segments
            .map((s) => s as { start_s?: unknown; end_s?: unknown })
            .filter((s) => typeof s.start_s === "number" && typeof s.end_s === "number")
            .map((s) => ({ start_s: s.start_s as number, end_s: s.end_s as number })),
        };
      }
    } catch {
      /* no manifest: seeks by time still work */
    }
  }

  return (
    <main className="min-h-screen bg-[#0B1013] text-[#E7EDE9]">
      <p className="px-3 pt-2 font-mono text-[11px] text-[#5F6F69]">
        SK M2 dev harness — the real Board, in-memory network. window.__skBoard / window.__skM2.run()
      </p>
      <Harness t={t} manifest={manifest} hasVideo={!!process.env.SK_M2_VIDEO_PATH} />
    </main>
  );
}
