import { readFile } from "node:fs/promises";
import { notFound } from "next/navigation";
import { getDictionary } from "@/i18n/dictionaries";
import type { BoardManifest, ManifestSegment, VisualVerdict } from "@/app/present/board-controller";
import Harness from "./harness-client";

// SK spike M2 harness — DEV ONLY. The REAL Board (BoardSession: stage, roll,
// store, wrap-up) mounted with an in-memory network seam and a local kit video,
// so SK's BoardController can be driven headlessly from `window.__skBoard`
// without a login and without a single production write.
//
// Local inputs, all optional and none committed (see ./video and ./questions):
//   SK_M2_VIDEO_PATH      an mp4
//   SK_M2_MANIFEST_PATH   { segments: [{ start_s, end_s, slide_t?, heading?, points?, visual? }] }
//   SK_M2_QUESTIONS_PATH  a worksheet's questions.json
export const dynamic = "force-dynamic";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function segment(raw: unknown): ManifestSegment | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const start_s = num(s.start_s);
  const end_s = num(s.end_s);
  if (start_s === undefined || end_s === undefined) return null;
  const out: ManifestSegment = { start_s, end_s };
  const slide_t = num(s.slide_t);
  if (slide_t !== undefined) out.slide_t = slide_t;
  if (typeof s.heading === "string") out.heading = s.heading;
  if (Array.isArray(s.points)) out.points = s.points.filter((p): p is string => typeof p === "string");
  if (s.visual && typeof s.visual === "object") out.visual = s.visual as VisualVerdict;
  return out;
}

export default async function SkBoardHarnessPage() {
  if (process.env.NODE_ENV !== "development") notFound();

  const t = (await getDictionary("en")).present;
  let manifest: BoardManifest = { segments: [] };
  const mp = process.env.SK_M2_MANIFEST_PATH;
  if (mp) {
    try {
      const raw = JSON.parse(await readFile(mp, "utf8")) as { segments?: unknown };
      if (Array.isArray(raw.segments)) {
        manifest = { segments: raw.segments.map(segment).filter((x): x is ManifestSegment => !!x) };
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
      <Harness
        t={t}
        manifest={manifest}
        hasVideo={!!process.env.SK_M2_VIDEO_PATH}
        hasQuestions={!!process.env.SK_M2_QUESTIONS_PATH}
      />
    </main>
  );
}
