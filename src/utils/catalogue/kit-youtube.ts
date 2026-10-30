// Where a CATALOGUE kit's lesson video lives on YouTube — the FALLBACK source
// for a lesson with no stored MP4.
//
// STORED MP4 FIRST, EVERYWHERE IN THE APP (founder 2026-10-30, reversing the
// same day's "pull it from YouTube to avoid egress": "the quality matters in
// the app so lets use stored mp4 wherever possible"). YouTube re-compresses
// our 1280x720 renders, and the Board hides YouTube's controls, so there is no
// quality picker. Every surface — the Board, the Library, the Kits gallery,
// SK, the SketchCast-book chapters — plays the stored file whenever one
// exists; a kit's YouTube video is used only when the lesson has no stored
// MP4 (videoSource / lessonVideo below). The fallback player turns captions
// off by default (youtubeEmbedUrl here; the Board's IFrame player in
// src/app/present/youtube-video.ts).
//
// THE SOURCE OF TRUTH is topic_publications (0112/0122/0148): one row per
// (topic_kit_id, part, channel_language), carrying youtube_video_id once the
// topic catalogue → YouTube pipeline posted that part. A part is WATCHABLE when
// its row has a well-formed id, is not superseded (0122), is public or
// unlisted (a private video does not embed), and YouTube has not reported it
// gone (youtube_missing_since, 0148). The English catalogue's visibility rule
// (catalogue_current_kits, 0128/0134) already demands a public publication for
// every current English kit, so those always resolve.
//
// A kit is found from a generation by its lineage: a teacher's copy carries
// params.catalogue_ref.topic_kit_id (0132, and 0175's adopt_product_kit) and
// params.product_ref.topic_kit_id (0175); a master presentation is found by
// topic_kits.presentation_generation_id.
//
// A book release bundle also lists each chapter's videos as "video:<id>"
// (bundleVideoId) — the script prints those beside the resolved kits as a
// cross-check; the publications stay the source.
//
// Pure apart from loadKitYoutubeIds (one service-role read).

/** A YouTube video id: 11 characters of [A-Za-z0-9_-]. */
export const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

export type PublicationRow = {
  topic_kit_id: string;
  part?: number | null;
  youtube_video_id?: string | null;
  privacy?: string | null;
  superseded_by?: string | null;
  channel_language?: string | null;
  youtube_missing_since?: string | null;
};

const watchable = (p: PublicationRow): boolean =>
  typeof p.youtube_video_id === "string" &&
  YOUTUBE_ID.test(p.youtube_video_id) &&
  !p.superseded_by &&
  (p.privacy === "public" || p.privacy === "unlisted") &&
  !p.youtube_missing_since;

/**
 * Each kit's watchable YouTube ids, one per part, in part order. A part posted
 * to more than one channel keeps one id (public before unlisted, then by
 * channel language, so the answer is stable).
 */
export function youtubeIdsByKit(rows: readonly PublicationRow[]): Map<string, string[]> {
  const perPart = new Map<string, Map<number, PublicationRow>>();
  const rank = (p: PublicationRow) => (p.privacy === "public" ? 0 : 1);
  for (const p of rows) {
    if (!p?.topic_kit_id || !watchable(p)) continue;
    const part = Number.isInteger(Number(p.part)) && Number(p.part) > 0 ? Number(p.part) : 1;
    const parts = perPart.get(p.topic_kit_id) ?? new Map<number, PublicationRow>();
    const have = parts.get(part);
    if (!have || rank(p) < rank(have) || (rank(p) === rank(have) && String(p.channel_language ?? "") < String(have.channel_language ?? ""))) parts.set(part, p);
    perPart.set(p.topic_kit_id, parts);
  }
  const out = new Map<string, string[]>();
  for (const [kit, parts] of perPart) {
    out.set(
      kit,
      [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p.youtube_video_id as string),
    );
  }
  return out;
}

/** The catalogue kit a generation's lineage names (a copy), or null. */
export function topicKitIdOf(params: Record<string, unknown> | null | undefined): string | null {
  if (!params || typeof params !== "object") return null;
  for (const key of ["catalogue_ref", "product_ref"]) {
    const ref = params[key] as { topic_kit_id?: unknown } | null | undefined;
    if (ref && typeof ref === "object" && typeof ref.topic_kit_id === "string" && ref.topic_kit_id) return ref.topic_kit_id;
  }
  return null;
}

/** "video:<id>" from a release bundle's chapters[].videos → the id, or null. */
export function bundleVideoId(entry: unknown): string | null {
  if (typeof entry !== "string") return null;
  const id = entry.startsWith("video:") ? entry.slice(6) : entry;
  return YOUTUBE_ID.test(id) ? id : null;
}

/**
 * Play from our storage, or from YouTube? STORAGE whenever the lesson has a
 * stored part (founder 2026-10-30: quality first); YouTube only when it has
 * none and the kit is on YouTube; nothing when neither.
 */
export function videoSource(youtube: readonly string[], storedParts: number): "youtube" | "storage" | "none" {
  if (storedParts > 0) return "storage";
  return youtube.length > 0 ? "youtube" : "none";
}

/**
 * How a lesson's video is served, given its generation's params, its stored
 * MP4s (paths or signed URLs, in part order) and the kits' YouTube ids:
 *   - any stored MP4 → those, and no YouTube (every lesson, catalogue or not);
 *   - no stored MP4, but a catalogue copy (catalogue_ref / product_ref) whose
 *     kit is on YouTube → its YouTube ids, the fallback;
 *   - neither → nothing.
 */
export function lessonVideo(
  params: Record<string, unknown> | null | undefined,
  stored: readonly string[],
  byKit: ReadonlyMap<string, string[]>,
): { youtube: string[]; paths: string[] } {
  if (stored.length) return { youtube: [], paths: [...stored] };
  const kit = topicKitIdOf(params);
  const ids = kit ? (byKit.get(kit) ?? []) : [];
  return { youtube: [...ids], paths: [] };
}

/** The watch page (the same URL the Kits gallery links: kits/logic.ts youtubeUrl). */
export const youtubeWatchUrl = (id: string): string => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

/** The YouTube id a watch link (or a youtu.be / embed link) names, or null for
 *  anything else — a signed storage URL above all. */
export function youtubeIdFromUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || !url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
  let id: string | null = null;
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else if (u.pathname.startsWith("/embed/")) id = u.pathname.slice(7);
  } else if (host === "youtu.be") id = u.pathname.slice(1);
  return id && YOUTUBE_ID.test(id) ? id : null;
}

/**
 * The embed URL of the in-app FALLBACK player (a plain <iframe>): captions OFF
 * by default (cc_load_policy=0 — a viewer can still turn them on from
 * YouTube's own controls, which this player shows), no related videos from
 * other channels, inline on phones.
 */
export const youtubeEmbedUrl = (id: string, opts: { autoplay?: boolean } = {}): string =>
  `https://www.youtube.com/embed/${encodeURIComponent(id)}?cc_load_policy=0&rel=0&playsinline=1&modestbranding=1${opts.autoplay ? "&autoplay=1" : ""}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = { from: (table: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * topic_kit_id → watchable YouTube ids, read with the SERVICE ROLE
 * (topic_publications has no client grant). Never throws: a failed read is an
 * empty map — a lesson with a stored MP4 never needed it, and one without has
 * no fallback.
 */
export async function loadKitYoutubeIds(db: Db, topicKitIds: readonly string[]): Promise<Map<string, string[]>> {
  const ids = [...new Set(topicKitIds.filter((x) => typeof x === "string" && x))];
  if (!ids.length) return new Map();
  try {
    const { data, error } = await db.from("topic_publications").select("*").in("topic_kit_id", ids);
    if (error) {
      console.error("[kit-youtube] topic_publications read failed:", error.message ?? error.code);
      return new Map();
    }
    return youtubeIdsByKit((data ?? []) as PublicationRow[]);
  } catch (e) {
    console.error("[kit-youtube] topic_publications read failed:", (e as Error).message);
    return new Map();
  }
}
