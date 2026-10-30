// Where a CATALOGUE kit's lesson video lives on YouTube — so a viewer streams
// it from YouTube and not from our storage (founder 2026-10-30: "the video
// should be pulled from youtube to avoid egress cost").
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
 * Play from YouTube, or from our storage? YouTube whenever it covers EVERY
 * part the lesson has (a 2-part lesson with one posted part would otherwise
 * lose its second half); storage only when it does not — the caller logs that.
 */
export function videoSource(youtube: readonly string[], storedParts: number): "youtube" | "storage" | "none" {
  if (youtube.length > 0 && youtube.length >= storedParts) return "youtube";
  return storedParts > 0 ? "storage" : "none";
}

/**
 * How a lesson's video is served, given its generation's params, its stored
 * MP4 paths (in part order) and the kits' YouTube ids:
 *   - a catalogue copy (catalogue_ref / product_ref) whose kit is on YouTube
 *     for every part → `youtube`, and NO storage path is signed;
 *   - a catalogue copy that is not → its storage paths, and `fellBack` names
 *     the kit so the caller logs it;
 *   - anything else (an uploaded book's lesson) → its own storage paths.
 */
export function lessonVideo(
  params: Record<string, unknown> | null | undefined,
  storedPaths: readonly string[],
  byKit: ReadonlyMap<string, string[]>,
): { youtube: string[]; paths: string[]; fellBack: string | null } {
  const kit = topicKitIdOf(params);
  if (!kit) return { youtube: [], paths: [...storedPaths], fellBack: null };
  const ids = byKit.get(kit) ?? [];
  if (videoSource(ids, storedPaths.length) === "youtube") return { youtube: [...ids], paths: [], fellBack: null };
  return { youtube: [], paths: [...storedPaths], fellBack: storedPaths.length ? kit : null };
}

/** The watch page (the same URL the Kits gallery links: kits/logic.ts youtubeUrl). */
export const youtubeWatchUrl = (id: string): string => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = { from: (table: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * topic_kit_id → watchable YouTube ids, read with the SERVICE ROLE
 * (topic_publications has no client grant). Never throws: a failed read is an
 * empty map, and every caller then falls back to storage and logs it.
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
