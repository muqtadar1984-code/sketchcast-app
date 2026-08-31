// Who may read a published lesson note, and who may publish one.
//
// THIS IS THE PART THE ALLOWLIST CANNOT EXPRESS. `presentAllowed()` answers one
// question — "may this account drive a board?" — and it answers it about a
// single operator-listed address. A student is never on that list and must never
// need to be: adding one would hand them /api/present/kit, which signs
// eight-hour URLs to every artifact the teacher owns.
//
// So the reader's right to a recap is not a property of the reader at all. It is
// three facts ANDed together, and only the first involves the allowlist:
//
//   (a) THE AUTHOR is allowlisted. Feature visibility is decided by who made the
//       thing, never by who is reading it — the same shape the AI Tutor already
//       uses, where the entitlement is checked against the lesson's OWNER
//       (tutorEntitled + planGrantsTutor), not the student asking the question.
//   (b) IT IS PUBLISHED. recap_published_at is set, and what is served is
//       recap_body — never recap_draft, never the live ink of an open session.
//   (c) THE READER IS RELATED TO IT. Enrolled in the session's class, a verified
//       parent of someone who is, the teacher herself, or leadership of the
//       session's school.
//
// All three are re-checked in code because the route reads through the service
// role, which bypasses RLS. That is the same reason ownedSession() exists two
// files over, and the reason is worth repeating: the service role is a key, not
// a policy, and something has to be the policy.
//
// PURE. Takes already-fetched facts and returns a verdict. The fetching, and the
// allowlist lookup on the author, belong to the route.

export type RecapSession = {
  teacher_id: string;
  class_id: string | null;
  school_id: string | null;
  recap_body: string | null;
  recap_published_at: string | null;
};

/** Everything about the reader that bears on this decision, fetched once. */
export type RecapReader = {
  userId: string;
  /** Classes this account is enrolled in as a student. */
  enrolledClassIds: string[];
  /** Classes a VERIFIED child of this account is enrolled in. Unverified parent
   *  links are not a relationship — 0018's own rule, and 0068 tightened it
   *  further for school audiences. */
  childClassIds: string[];
  /** Leadership of the session's school. Resolved by the caller, because
   *  "leadership" is four different grants in this schema. */
  leadsSchool: boolean;
};

export type RecapRole = "teacher" | "student" | "parent" | "leader";

export type RecapVerdict =
  | { ok: true; as: RecapRole }
  | { ok: false; reason: "unpublished" | "author-not-allowed" | "unrelated" };

/**
 * May this reader see this note?
 *
 * `authorAllowed` is the caller's `presentAllowed(teacherProfile)` — passed in
 * rather than computed here so this module stays pure and so the call site has
 * to think about WHOSE identity it is testing. Getting that backwards (checking
 * the reader) is the one mistake this whole file exists to make hard.
 *
 * The teacher branch is checked first and is the only one that can see her own
 * unpublished work — but even she is served through the read path only once
 * published; a draft belongs to the composer, not to a shared link. Hence the
 * publish check comes before the role check for everyone, herself included.
 */
export function mayReadRecap(
  session: RecapSession,
  reader: RecapReader,
  authorAllowed: boolean,
): RecapVerdict {
  if (!authorAllowed) return { ok: false, reason: "author-not-allowed" };
  if (!session.recap_published_at || !session.recap_body) {
    return { ok: false, reason: "unpublished" };
  }
  if (session.teacher_id === reader.userId) return { ok: true, as: "teacher" };
  if (session.class_id && reader.enrolledClassIds.includes(session.class_id)) {
    return { ok: true, as: "student" };
  }
  if (session.class_id && reader.childClassIds.includes(session.class_id)) {
    return { ok: true, as: "parent" };
  }
  // Leadership sees its school's lessons, but a session with no school is a
  // private board and belongs to nobody's oversight.
  if (session.school_id && reader.leadsSchool) return { ok: true, as: "leader" };
  return { ok: false, reason: "unrelated" };
}

export type PublishCheck =
  | { ok: true; body: string }
  | { ok: false; reason: "empty" | "too-long" | "not-closed" | "no-audience" };

/** The longest a lesson note may be. Two sentences with room to breathe — she
 *  can edit the draft, and an edit box with no ceiling becomes a document. */
export const MAX_BODY = 600;

/**
 * May this be published, and with what text?
 *
 * `no-audience` is a REFUSAL, not a warning, and it is the honest one: a session
 * with no class has nobody to publish to. An independent teacher with no classes
 * would otherwise get a published note that exactly one person — herself — can
 * ever open, and would reasonably conclude the feature was broken rather than
 * that she had no audience configured.
 */
export function checkPublish(
  session: { class_id: string | null; ended_at: string | null },
  body: string,
): PublishCheck {
  const text = (body || "").replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > MAX_BODY) return { ok: false, reason: "too-long" };
  // Publishing an open lesson would publish a note about a lesson still being
  // taught, and the roll it points at would not be the roll she ends with.
  if (!session.ended_at) return { ok: false, reason: "not-closed" };
  if (!session.class_id) return { ok: false, reason: "no-audience" };
  return { ok: true, body: text };
}

/** Why a refusal is worded the way it is, for the UI. Kept beside the reasons so
 *  a new reason cannot ship without a sentence. */
export const PUBLISH_MESSAGE: Record<
  Exclude<PublishCheck, { ok: true }>["reason"],
  string
> = {
  empty: "Write a sentence first — a published note with nothing in it helps nobody.",
  "too-long": `Keep it under ${MAX_BODY} characters. This is the line a parent reads, not a report.`,
  "not-closed": "End the lesson first. The note points at the roll you finish with.",
  "no-audience":
    "This lesson has no class attached, so there is nobody to publish it to. Pick a class on the bar before you start.",
};
