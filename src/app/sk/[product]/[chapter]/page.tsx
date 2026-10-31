import { skRedirect } from "../../redirect";

// SK Tutor is retired (founder 2026-10-31): a bookmarked chapter opens on the
// Classroom Board, on that book and chapter, for an adult the Board admits;
// everyone else goes to /dashboard (redirect-path.ts).

export const dynamic = "force-dynamic";

export default async function SkChapterPage({ params }: { params: Promise<{ product: string; chapter: string }> }): Promise<never> {
  const { product, chapter } = await params;
  let ref = chapter;
  try {
    ref = decodeURIComponent(chapter);
  } catch {
    ref = "";
  }
  return skRedirect(product, ref);
}
