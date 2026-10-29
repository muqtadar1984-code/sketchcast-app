// Signing a kit's artifacts — shared by the teacher's Present route
// (/api/present/kit, gated by presentEntitled) and the student kit player
// (/api/sk/kit, gated by canOpenKit). SERVER ONLY: it takes the service-role
// client, because the artifacts bucket is not readable through a member
// session. Each CALLER decides who may have a URL; nothing here checks.
//
// Moved out of the Present route (SK S3 slice B) so the student route reuses
// the same ordering rule and signing call instead of copying them.

import { sortVideoArtifacts, videoPartOf } from "@/utils/catalogue/kit";

/** What signing needs from the admin client. */
export type SignAdmin = {
  storage: {
    from: (bucket: string) => {
      createSignedUrl: (path: string, expiresIn: number, opts?: { download?: string }) => Promise<{ data: { signedUrl: string } | null; error?: unknown }>;
    };
  };
};

/** One storage path in the artifacts bucket → a signed URL, or null when there
 *  is no path or the storage call gave nothing back. */
export async function signArtifactPath(admin: SignAdmin, path: string | null, ttlSeconds: number, download?: string): Promise<string | null> {
  if (!path) return null;
  const { data } = await admin.storage.from("artifacts").createSignedUrl(path, ttlSeconds, download ? { download } : undefined);
  return data?.signedUrl ?? null;
}

/** The video_mp4 paths of a generation's artifacts, in PART order (lesson.mp4
 *  is part 1, lesson_part2.mp4 part 2 …) — by extracted part number, never by
 *  path string (sortVideoArtifacts explains the ICU trap). */
export function videoPathsInPartOrder(artifacts: readonly { kind: string; storage_path: string }[]): string[] {
  return sortVideoArtifacts(artifacts.filter((a) => a.kind === "video_mp4").map((a) => a.storage_path));
}

/** Every video part of a kit, signed, as [{part, url}] in part order. A part
 *  whose signing failed is left out. */
export async function signKitVideos(admin: SignAdmin, artifacts: readonly { kind: string; storage_path: string }[], ttlSeconds: number): Promise<{ part: number; url: string }[]> {
  const paths = videoPathsInPartOrder(artifacts);
  const urls = await Promise.all(paths.map((p) => signArtifactPath(admin, p, ttlSeconds)));
  return paths.flatMap((p, i) => (urls[i] ? [{ part: videoPartOf(p), url: urls[i] as string }] : []));
}
