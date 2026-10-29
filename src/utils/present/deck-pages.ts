// The deck's rendered pages: which artifacts they are, where the text map is,
// and the reply /api/present/deck-pages sends. PURE — the route fetches and
// signs; the rules live here so they are testable without a database.
//
// THE WORKER CONTRACT (sketchcast-ai `feat/deck-pages`, an OBSERVER job — it
// renders, it never rebuilds the deck):
//   jobs row {type: "deck_pages", status: "queued", generation_id: null,
//             params: {generation_id: <deck generation id>}}
//   → artifacts bucket {owner_id}/{generation_id}/deck_pages/slide_NN.png,
//     one `slide_png` artifact row per slide (NN two digits from 01), and
//     {owner_id}/{generation_id}/deck_pages/pages.json as `deck_pages_json`.
//
// THE MAP MAY HAVE NO ROW. `deck_pages_json` arrives with migration 0166, and
// until that is applied in production the worker uploads the map without
// registering it — so the map is looked for BY ITS PATH next to the slides when
// no row names it.

export const DECK_PAGES_JOB = "deck_pages";
export const SLIDE_PNG = "slide_png";
export const DECK_PAGES_JSON = "deck_pages_json";
export const DECK_PPTX = "deck_pptx";

export type ArtifactRow = { kind: string; storage_path: string };

/** A generation whose deck can be rendered: a `deck` generation, or a
 *  presentation from before 0103 that carries its deck*.pptx itself. Either way
 *  it must hold the .pptx — there is nothing to render otherwise. */
export function isDeckSource(g: { kind: string; artifacts: ArtifactRow[] }): boolean {
  const pptx = g.artifacts.some((a) => a.kind === DECK_PPTX && /\.pptx$/i.test(a.storage_path));
  if (g.kind === "deck") return pptx;
  if (g.kind === "presentation") return g.artifacts.some((a) => a.kind === DECK_PPTX && /(?:^|\/)deck[^/]*\.pptx$/i.test(a.storage_path));
  return false;
}

export type SlideFile = { n: number; path: string };

/** slide_07.png → 7; anything else → null. */
export function slideNumber(path: string): number | null {
  const m = /(?:^|\/)slide_(\d+)\.png$/i.exec(path);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** The rendered slides, in slide order. Only `slide_png` rows in a
 *  `deck_pages/` folder named slide_NN.png count — a slide image some other
 *  feature registered is not a deck page. One per number. */
export function slideFiles(artifacts: ArtifactRow[]): SlideFile[] {
  const byN = new Map<number, string>();
  for (const a of artifacts) {
    if (a.kind !== SLIDE_PNG || !/\/deck_pages\/[^/]+$/.test(a.storage_path)) continue;
    const n = slideNumber(a.storage_path);
    if (n !== null && !byN.has(n)) byN.set(n, a.storage_path);
  }
  return [...byN.entries()].sort((a, b) => a[0] - b[0]).map(([n, path]) => ({ n, path }));
}

const dirname = (p: string) => p.slice(0, p.lastIndexOf("/"));

/**
 * Where the text map is: its own artifact row when 0166 is applied, else
 * `pages.json` beside the slides, else the contract's folder for this
 * generation. `rowed` says which — a path without a row may not exist.
 */
export function mapPathOf(
  artifacts: ArtifactRow[],
  slides: SlideFile[],
  gen: { id: string; owner_id: string },
): { path: string; rowed: boolean } {
  const row = artifacts.find((a) => a.kind === DECK_PAGES_JSON)?.storage_path;
  if (row) return { path: row, rowed: true };
  if (slides.length) return { path: `${dirname(slides[0].path)}/pages.json`, rowed: false };
  return { path: `${gen.owner_id}/${gen.id}/deck_pages/pages.json`, rowed: false };
}

/** One slide as the Board receives it. `path` is what a page stores (and
 *  re-signs on load); `url` is signed for the classroom day. */
export type DeckSlideRef = { n: number; path: string; url: string | null; w: number; h: number; title: string };

export type DeckPagesReply =
  | {
      status: "ready";
      slides: DeckSlideRef[];
      /** The text map, signed; null when it could not be found. */
      mapUrl: string | null;
      /** The text map's storage path, for the pages to keep; null when not found. */
      map: string | null;
    }
  | { status: "building" | "missing" };
