// TEMPORARY — founder-only lesson-video download (added 2026-08-31).
//
// Lesson videos ship as a disposition-free "Watch" link on purpose: the signed
// URL has to stream in-tab, and a Content-Disposition would turn playback into
// a save prompt (see `docDownloadName` in ./download-name, which returns
// undefined for video_mp4 for exactly that reason).
//
// So this does NOT change the Watch URL. It signs the SAME storage path a
// SECOND time, with a download disposition, for a small allow-list of
// accounts — giving those accounts a separate "Save" link beside "Watch" and
// leaving playback untouched for everyone.
//
// TO REVOKE THE ACCESS: empty VIDEO_DOWNLOAD_EMAILS. Nothing else is needed —
// with no address on the list no download URL is ever signed, and every Save
// link hides itself.
// TO REMOVE THE FEATURE: delete this file, the `videoDownloads` field on
// CellLesson, and its three call sites (dashboard/page.tsx, content-cell.tsx,
// lesson-card.tsx).
const VIDEO_DOWNLOAD_EMAILS: readonly string[] = ["muqtadar1984@gmail.com"];

/** Whether this signed-in address may download lesson videos. */
export function canDownloadVideo(email: string | null | undefined): boolean {
  if (!email) return false;
  return VIDEO_DOWNLOAD_EMAILS.includes(email.trim().toLowerCase());
}

/**
 * The Content-Disposition filename for one video part.
 *
 * ENGLISH-ONLY ASCII, for the same reasons `docDownloadName` is: stored
 * basenames never were localized, and a lesson title can be Arabic or Devanagari
 * — neither survives Content-Disposition the same way across browsers. The
 * index is the part's position in the already part-sorted list, so the names
 * match the "Pt 1 / Pt 2" chips the Library renders.
 */
export function videoDownloadName(index: number, total: number): string {
  return total > 1 ? `Lesson Part ${index + 1}.mp4` : "Lesson.mp4";
}
