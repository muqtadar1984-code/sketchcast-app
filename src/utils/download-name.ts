// Download filenames for generated documents.
//
// The browser names a download after the LAST thing that claims a name; with
// nothing set, that is the Supabase storage basename — so a "Test paper" saved
// as exam_paper.docx. The fix is at SIGNING time: createSignedUrl's `download`
// option bakes a Content-Disposition filename into the signed URL, which means
// every already-stored artifact is covered too — no re-upload, no rename in
// the bucket.
//
// Filenames are ENGLISH-ONLY on purpose: stored basenames never were
// localized, a localized filename would need all 10 locales (a missing key is
// a build error), and plain ASCII avoids Content-Disposition encoding
// surprises across browsers.

const DOC_NAME: Record<string, string> = {
  exam_paper: "Test Paper",
  worksheet: "Worksheet",
  lesson_plan: "Lesson Plan",
  activity: "Activities",
  case_study: "Case Study",
  exam: "Exam",
};

/**
 * The filename a signed URL should download as, or undefined to leave the URL
 * untouched. Only document artifacts get a name: videos, decks and quiz JSON
 * must stay disposition-free — a download disposition on the Watch link would
 * break in-tab playback.
 */
export function docDownloadName(genKind: string | null | undefined, artifactKind: string): string | undefined {
  if (artifactKind === "answer_key_docx") {
    // Since the student/teacher document split (2026-08-18) every document
    // kind can carry a key, so the key is prefixed with its paper's name —
    // a chapter's "Worksheet Answer Key.docx" and "Test Paper Answer
    // Key.docx" must not collide in the Downloads folder. The cumulative
    // exam (0062) keeps the plain "Answer Key.docx" it has shipped with
    // since birth, and an unknown kind falls back to it too — a key should
    // never leave named after its storage basename.
    const name = genKind ? DOC_NAME[genKind] : undefined;
    return name && genKind !== "exam" ? `${name} Answer Key.docx` : "Answer Key.docx";
  }
  if (artifactKind !== "docx") return undefined;
  const name = genKind ? DOC_NAME[genKind] : undefined;
  return name ? `${name}.docx` : undefined;
}
