// In-app quiz: the pure core that both quiz routes share.
//
// THREE INTEGRITY RULES live here, and nothing outside this file is allowed to
// weaken them:
//
//   1. THE ANSWER KEY NEVER LEAVES THE SERVER. `questions.json` in the
//      artifacts bucket carries the marking scheme (fill_blank/true_false
//      `answer`, the match `pairs`, the subjective `answer_outline`). Until
//      2026-08-18 the student dashboard handed the student a SERVICE-ROLE
//      signed URL to that exact file — a verifier pulled three of them from
//      production with no credentials and read the keys straight off. Students
//      now only ever see `stripQuiz()` output, which is BUILT FIELD BY FIELD
//      (never spread from the raw question), so a new key-bearing field added
//      by the worker tomorrow is dropped by construction rather than leaked by
//      omission.
//
//   2. THE SCORE IS DERIVED SERVER-SIDE. `scoreQuiz()` is the only grader for
//      an interactive submission, it runs under the service role, and the
//      student's browser no longer computes — or transmits — a mark.
//
//   3. THE MATCH OPTION ORDER IS KEYED, NOT DERIVED FROM PUBLIC MATERIAL. The
//      shuffled `options` bag IS the answer key expressed as a permutation, so
//      whoever can recompute the permutation can invert it and read the pairs
//      off with ZERO probes. Until 2026-08-19 the seed was
//      `${generationId}:${studentId}:${q.id}` — every component of which the
//      student holds (the id is in the URL they fetch, their own id is passed
//      into the player, the question ids are in the payload they receive) — and
//      Fisher–Yates' swap sequence depends only on (seed, n), never on the item
//      values. The seed is now an HMAC-SHA-256 under a SERVER-ONLY key; see
//      `optionOrderKey` for why it is a key and not a digest of the answers.
//
// No imports: this module is shared by a Route Handler and (types only) by a
// Client Component, so it must stay free of server-only dependencies. The HMAC
// uses Web Crypto off `globalThis`, which is a platform global in Node, in the
// Edge runtime and in browsers — a global, not a `node:crypto` import, so the
// rule above still holds.

// ── the raw artifact (answer key included) ──────────────────────────────────

export type RawQuestion =
  | { id: string; type: "fill_blank" | "short"; prompt: string; answer?: string; marks: number }
  | { id: string; type: "true_false"; prompt: string; answer?: boolean; marks: number }
  | { id: string; type: "match"; prompt: string; pairs: { left: string; right: string }[]; marks: number }
  | { id: string; type: "subjective"; prompt: string; answer_outline?: string; marks: number };

export type RawQuiz = { title: string; instructions: string; questions: RawQuestion[] };

// ── what a student is allowed to receive ────────────────────────────────────

/** A question with every marking-scheme field removed. `match` keeps the
 * left-hand prompts IN ORDER (the answer for pair i is submitted under key i)
 * and a SHUFFLED bag of right-hand options with the pairing never expressed:
 * no `pairs`, no parallel array, no index that lines the two sides up. */
export type StudentQuestion =
  | { id: string; type: "fill_blank" | "short" | "true_false" | "subjective"; prompt: string; marks: number }
  | { id: string; type: "match"; prompt: string; marks: number; left: string[]; options: string[] };

export type StudentQuizData = { title: string; instructions: string; questions: StudentQuestion[] };

// ── grading primitives (byte-for-byte the pre-fix client behaviour) ─────────

export const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** Deterministic PRNG so a student who reloads sees the same option order —
 * a reshuffle per render would be its own tell (options that move reveal
 * nothing, but options that DON'T move across a reload are what a normal
 * paper does). FNV-1a → mulberry32.
 *
 * NOT CRYPTOGRAPHIC, AND IT DOES NOT NEED TO BE — but the reason is narrower
 * than the one that used to be written here. What protects the pairing is that
 * the SEED is unguessable (`optionOrderSeed`, an HMAC under a server-only key),
 * not that this generator is strong. An attacker holding a permutation has no
 * way to test a candidate state, because testing one means already knowing the
 * pairing. Collapsing a 256-bit digest into 32 bits of state here is therefore
 * fine: it narrows which permutations are REACHABLE, not which are GUESSABLE,
 * and every reachable one is equally plausible to someone without the key. */
function seeded(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates over a copy. Duplicates are preserved: the option count must
 * keep matching the pair count, or a student can infer by arithmetic.
 *
 * The swap sequence is a function of (seed, length) ALONE — it never looks at
 * the values. That is what made the old public seed fatal, and it is why the
 * only thing that can be secret here is the seed. Callers building a STUDENT
 * payload must pass `optionOrderSeed()` output and nothing else. */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = items.slice();
  const rnd = seeded(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ── the option-order key: the one piece of server-only material ─────────────

/** Domain separator. Mixed into both the derived key and every message, so a
 * digest minted here can never collide with one minted by some future feature
 * that reaches for the same secret. Bump the version if the order must change
 * for every student at once. */
export const SHUFFLE_DOMAIN = "sketchcast:quiz:option-order:v1";

/** Resolve the HMAC key for the match-option order. Returns null when NO
 * server-only secret is available, and the caller must then REFUSE to serve a
 * paper — there is deliberately no fallback seed, because any fallback built
 * from material the student already holds is the bug this replaces.
 *
 * WHY A KEY AND NOT A DIGEST OF THE ANSWERS. Seeding from the pairs themselves
 * is tempting: the student does not hold the pairing, so it looks like free
 * secrecy with no new configuration. It is not secret. The student holds the
 * option MULTISET (that is what `options` is) and the count n, so they can
 * enumerate all n! candidate pairings, compute each candidate's seed, run the
 * shuffle, and keep the candidate that reproduces the order they were served.
 * The digest would be its own verification oracle. n is 3–6 in practice: 6 to
 * 720 candidates, milliseconds in a browser tab. Only material the student
 * cannot enumerate works, and that means a key.
 *
 * WHICH KEY, AND THE DEGRADATION. Preference order:
 *
 *   1. QUIZ_SHUFFLE_SECRET — an explicit, independently rotatable secret. Set
 *      it if you ever want to reshuffle every paper without touching Supabase.
 *      It is OPTIONAL; nothing breaks if it is never set.
 *   2. SUPABASE_SERVICE_ROLE_KEY, behind the domain separator. This is not a
 *      convenience default, it is the reason no new env var is REQUIRED: the
 *      quiz routes already cannot function without it (createAdminClient
 *      throws, and both handlers 500 before any paper is built), so "the key is
 *      missing but the paper is served" is not a reachable state. HMAC is
 *      one-way and only a permutation of ≤ n items ever leaves the server, so
 *      no practical amount of observed output constrains the key.
 *   3. Neither set → null → GET /api/quiz/{id} answers 500 "Quizzes are
 *      unavailable right now." Quizzes stop; no paper is ever served under a
 *      computable order. That is the whole degradation story, and it is loud
 *      by construction — a silent fall back to a public seed would reinstate
 *      the vulnerability exactly, so there is no such branch to reach. */
export function optionOrderKey(env: Record<string, string | undefined>): string | null {
  const explicit = env.QUIZ_SHUFFLE_SECRET?.trim();
  if (explicit) return explicit;
  const service = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (service) return `${SHUFFLE_DOMAIN}|${service}`;
  return null;
}

/** HMAC-SHA-256, hex. Web Crypto off `globalThis` — a platform global in Node,
 * in the Edge runtime and in browsers — so this file still imports nothing. */
async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const ck = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", ck, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The seed for ONE match question's option order.
 *
 * The message is domain ∥ scope ∥ question id ∥ option count, and NOTHING
 * ELSE. Each part is doing a job:
 *   * `scope` is `${generationId}:${studentId}`, so the order is stable for one
 *     student across reloads (requirement a) and differs between two children
 *     in the same class comparing screens (requirement b);
 *   * the question id separates questions inside one paper, so a repeated
 *     option set does not repeat its order;
 *   * the count keeps the digest tied to the shape actually being shuffled.
 *
 * The ANSWER MATERIAL IS ABSENT ON PURPOSE. Including it would buy nothing —
 * the key already makes the digest unguessable — while making the order depend
 * on something an attacker can enumerate, which is the self-verifying-oracle
 * hole described on `optionOrderKey`. Leaving it out also means a worker that
 * re-emits questions.json with the same ids does not silently reshuffle a
 * paper a student is halfway through.
 *
 * Throws on an empty key rather than degrading: see rule 3. */
export async function optionOrderSeed(key: string, scope: string, questionId: string, count: number): Promise<string> {
  if (!key) throw new Error("optionOrderSeed: refusing to shuffle without a server-only key");
  return hmacHex(key, `${SHUFFLE_DOMAIN}\n${scope}\n${questionId}\n${count}`);
}

/** Build the student-safe payload. Whitelist by construction — see rule 1.
 *
 * `key` is the server-only HMAC key; `scope` is the per-student, per-generation
 * label. Both are arguments rather than reads of `process.env`, so this module
 * stays free of ambient server state and a test can vary the key directly.
 *
 * NOTHING ELSE IN THIS PAYLOAD IS A FUNCTION OF THE ANSWERS. Audited field by
 * field: `title`, `instructions`, `prompt`, `id`, `type` and `marks` come off
 * the artifact untouched; question order is the artifact's order; `left` is the
 * pairs' left-hand side IN KEY ORDER, which is required (an answer is submitted
 * under the index of the left prompt it belongs to) and carries no information
 * about the right-hand side; `options` is the only answer-derived array and is
 * the permutation above. There is no sort anywhere — a stable sort would leak,
 * because equal sort keys preserve the input order and the input order IS the
 * key — and no index, count or id lines the two sides up. What genuinely cannot
 * be hidden: a one-pair match question has one option, and a two-pair one is
 * right half the time by construction. Both are properties of the question,
 * not of this code. */
export async function stripQuiz(raw: RawQuiz, key: string, scope: string): Promise<StudentQuizData> {
  const questions: StudentQuestion[] = [];
  for (const q of raw.questions ?? []) {
    const marks = typeof q.marks === "number" ? q.marks : 0;
    if (q.type === "match") {
      const pairs = Array.isArray(q.pairs) ? q.pairs : [];
      const rights = pairs.map((p) => String(p?.right ?? ""));
      questions.push({
        id: String(q.id),
        type: "match",
        prompt: String(q.prompt ?? ""),
        marks,
        left: pairs.map((p) => String(p?.left ?? "")),
        options: seededShuffle(rights, await optionOrderSeed(key, scope, String(q.id), rights.length)),
      });
    } else {
      questions.push({ id: String(q.id), type: q.type, prompt: String(q.prompt ?? ""), marks });
    }
  }
  return {
    title: String(raw.title ?? ""),
    instructions: String(raw.instructions ?? ""),
    questions,
  };
}

export type Score = { auto: number; max: number; needsReview: boolean };

/** The authoritative grader. Deliberately identical to what quiz-player.tsx
 * used to do in the browser, so no student's mark changes because of this fix:
 *   * fill_blank  — case/whitespace-insensitive exact match, blank never scores
 *   * true_false  — a real boolean equal to the key
 *   * match       — ONE mark per correctly matched pair (not q.marks)
 *   * short/subjective — never auto-scored; the whole paper goes to the teacher
 * `max` sums q.marks for every question, including the reviewed ones. */
export function scoreQuiz(questions: readonly RawQuestion[], answers: Record<string, unknown>): Score {
  let auto = 0;
  let max = 0;
  let needsReview = false;
  for (const q of questions) {
    max += q.marks || 0;
    if (q.type === "fill_blank") {
      if (norm(answers[q.id]) && norm(answers[q.id]) === norm(q.answer)) auto += q.marks || 1;
    } else if (q.type === "true_false") {
      if (typeof answers[q.id] === "boolean" && answers[q.id] === q.answer) auto += q.marks || 1;
    } else if (q.type === "match") {
      const picked = (answers[q.id] as Record<number, string>) || {};
      (q.pairs ?? []).forEach((p, i) => {
        if (norm(picked[i]) === norm(p.right)) auto += 1;
      });
    } else {
      needsReview = true; // short / subjective → teacher marks
    }
  }
  return { auto, max, needsReview };
}

/** Keep only answers that name a real question, so a submission can't be used
 * to stuff arbitrary jsonb into the row the teacher later reads. */
export function pickAnswers(
  questions: readonly { id: string }[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const known = new Set(questions.map((q) => String(q.id)));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(answers)) if (known.has(k)) out[k] = v;
  return out;
}

// ── injectable data access (mirrors utils/lemonsqueezy/claim.ts ClaimDb) ────

type Row = Record<string, unknown>;
type Rows = { data: Row[] | null };
type One = { data: Row | null };

/** PostgREST surfaces the SQLSTATE on `code`; the message alone is not a
 * contract. Both are read — see `lostTheRace`. */
export type WriteError = { message: string; code?: string } | null;

export type QuizFilter = {
  eq(col: string, v: unknown): QuizFilter;
  maybeSingle(): PromiseLike<One>;
} & PromiseLike<Rows>;

/** An UPDATE narrowed by `eq` filters. `select` is what makes it report which
 * rows it actually hit — without it PostgREST returns no body and a
 * compare-and-swap cannot tell "updated" from "matched nothing". */
export type QuizUpdate = {
  eq(col: string, v: unknown): QuizUpdate;
  select(cols: string): QuizUpdate;
} & PromiseLike<{ data: Row[] | null; error: WriteError }>;

export type QuizDb = {
  from(table: string): {
    select(cols: string): QuizFilter;
    insert(row: Row): PromiseLike<{ error: WriteError }>;
    update(row: Row): QuizUpdate;
  };
};

type Downloadable = { text(): Promise<string> };
export type QuizStore = QuizDb & {
  storage: {
    from(bucket: string): { download(path: string): PromiseLike<{ data: Downloadable | null; error: unknown }> };
  };
};

/** Is this generation actually assigned to this student? Mirrors the two live
 * RLS read paths on generation_shares (shares_child_read / shares_student_read)
 * and the entitlement shape of resolveTutorContext: a DIRECT share carrying the
 * student_id (parent portal / homeschool), or a share to a CLASS the student is
 * enrolled in. Nothing else — a student who merely knows a generation id gets
 * neither the paper nor a mark. */
export async function isAssignedToStudent(db: QuizDb, studentId: string, generationId: string): Promise<boolean> {
  const { data: direct } = await db
    .from("generation_shares")
    .select("id")
    .eq("generation_id", generationId)
    .eq("student_id", studentId)
    .maybeSingle();
  if (direct) return true;

  const { data: shares } = await db.from("generation_shares").select("class_id").eq("generation_id", generationId);
  const classIds = (shares ?? []).map((r) => r.class_id).filter((c): c is string => typeof c === "string" && !!c);
  if (classIds.length === 0) return false;

  const { data: enrolled } = await db.from("enrollments").select("class_id").eq("student_id", studentId);
  const mine = new Set((enrolled ?? []).map((r) => String(r.class_id)));
  return classIds.some((c) => mine.has(c));
}

/** Read questions.json for a generation with the service role. Returns null
 * when this generation has no interactive quiz (or the file is unreadable). */
export async function loadQuizArtifact(store: QuizStore, generationId: string): Promise<RawQuiz | null> {
  const { data: art } = await store
    .from("artifacts")
    .select("storage_path")
    .eq("generation_id", generationId)
    .eq("kind", "questions_json")
    .maybeSingle();
  const path = art?.storage_path;
  if (typeof path !== "string" || !path) return null;
  const dl = await store.storage.from("artifacts").download(path);
  if (dl.error || !dl.data) return null;
  try {
    const parsed = JSON.parse(await dl.data.text()) as RawQuiz;
    return Array.isArray(parsed?.questions) ? parsed : null;
  } catch {
    return null;
  }
}

// ── the two operations ──────────────────────────────────────────────────────

export type QuizFailure = { ok: false; status: number; error: string };
export type PaperResult = { ok: true; quiz: StudentQuizData } | QuizFailure;
export type SubmitResult =
  | ({ ok: true; attempt: number; attemptsLeft: number } & Score)
  | QuizFailure;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resubmit window, in ms. Same 10 s the 0076 duplicate_guard uses: it absorbs
 * the double-tap that produced two billed kits in production, and it puts a
 * floor under how fast the score endpoint can be interrogated (see the note on
 * the oracle in submitQuizWith). */
export const RESUBMIT_COOLDOWN_MS = 10_000;

/** How many times one student may answer one in-app quiz. THREE.
 *
 * WHY A CAP AT ALL. The response carries the total mark, and so does the
 * student's own submissions row (RLS sub_student_read; the diary shows it), so
 * the endpoint is a differencing oracle: change one answer, resubmit, read the
 * delta. That is not theoretical — a verifier measured a true_false key falling
 * in ONE probe and a four-pair `match` answer fully recovered in about TEN, at
 * the 10 s cooldown. A cooldown rate-limits an oracle; it does not close one.
 * Withholding the number from this response would be theatre while the row
 * still carries it, and refusing to write the score breaks the product. The
 * only lever that actually bounds the leak is the number of probes.
 *
 * WHY THREE, PEDAGOGICALLY. Retakes are real and this is a formative in-app
 * quiz: a first attempt, a second after rewatching the lesson, and one more for
 * the tab that closed / the answer misread / the phone that lost signal. Three
 * is more tries than a paper quiz gives and matches what a teacher would grant
 * without being asked. Beyond that the request is a conversation with a
 * teacher, not a button — and the refusal says so, rather than failing blank.
 *
 * WHY THREE, ADVERSARIALLY. N attempts yield at most N-1 differencing probes,
 * so the cap is a hard ceiling on what can be learned: 2 probes here. That is
 * an order of magnitude short of the ~10 the measured `match` recovery needed,
 * and short of the >=10 needed to sweep a ten-question paper. What survives is
 * "a student may confirm up to two answers, and spends every remaining attempt
 * doing it" — which is inside the noise of ordinary retake generosity, and
 * arrives with attempt_count = 3 sitting in front of the teacher.
 *
 * WHY IT IS ENFORCEABLE AT ALL. The cap is derived from attempt_count, and
 * attempt_count is only trustworthy because 0091 stops a student session from
 * overwriting its own interactive row with a clean file row. The two halves
 * hold each other up: without 0091 this constant is a suggestion. */
export const MAX_INTERACTIVE_ATTEMPTS = 3;

/** A concurrent write for the same (generation, student) beat us. Reported as
 * 429 — the honest reading is "you are already submitting", which is exactly
 * what the 0076 double-tap looks like from the server. */
const RACE_LOST: QuizFailure = {
  ok: false,
  status: 429,
  error: "This quiz is already being submitted — give it a moment before trying again.",
};

/** Unique-violation on (generation_id, student_id): someone inserted the row
 * between our read and our write. */
function lostTheRace(error: NonNullable<WriteError>): boolean {
  return error.code === "23505" || /duplicate key|unique constraint/i.test(error.message);
}

/** GET: the student's copy of the paper.
 *
 * `optionKey` is the server-only HMAC key from `optionOrderKey(process.env)`.
 * It is a REQUIRED argument with no default: a default is exactly how a
 * computable seed creeps back in, and the type system refusing to compile a
 * caller that forgot it is worth more than any runtime check. When it is
 * absent the paper is refused — never served under a weaker order. */
export async function loadPaperWith(
  store: QuizStore,
  studentId: string,
  generationId: string,
  optionKey: string | null,
): Promise<PaperResult> {
  if (!UUID.test(generationId)) return { ok: false, status: 404, error: "No such quiz." };
  // Checked BEFORE the assignment lookup so a misconfigured deploy fails the
  // same way for everyone instead of only for the students who reach a match
  // question, and so no answer key is ever downloaded on a doomed request.
  if (!optionKey) return { ok: false, status: 500, error: "Quizzes are unavailable right now." };
  if (!(await isAssignedToStudent(store, studentId, generationId)))
    return { ok: false, status: 403, error: "This quiz isn't assigned to you." };
  const raw = await loadQuizArtifact(store, generationId);
  if (!raw || raw.questions.length === 0) return { ok: false, status: 404, error: "No such quiz." };
  // Scoped per student so two children in one class don't compare option order
  // and read a pattern out of it — and KEYED so neither of them can compute it.
  return { ok: true, quiz: await stripQuiz(raw, optionKey, `${generationId}:${studentId}`) };
}

/** POST: grade and record. The caller has already proved who the student is
 * (session), so `studentId` is never taken from the request body.
 *
 * THE ORACLE, AND WHAT ACTUALLY CLOSES IT. The response carries the total mark,
 * and so does the student's own submissions row, so a student can resubmit with
 * one answer changed and difference the totals — measured at one probe for a
 * true_false key and ~10 for a four-pair `match`. Three things stand in the
 * way, and only the third is a bound rather than a friction:
 *   1. the cooldown below, which rate-limits probing;
 *   2. attempt_count, which makes probing VISIBLE to a teacher — and which is
 *      only tamper-proof because 0091 stops a student overwriting their own
 *      interactive row with a clean file row;
 *   3. MAX_INTERACTIVE_ATTEMPTS, a hard per-student cap. See its comment for
 *      why three, pedagogically and adversarially.
 *
 * THE WRITE IS A COMPARE-AND-SWAP, NOT AN UPSERT. The old code read `prev`,
 * then upserted — two round trips with no atomicity, so two concurrent first
 * submissions both saw prev=null and both wrote. That was survivable while
 * attempt_count was only evidence (the count under-reported). It is NOT
 * survivable with a cap: N parallel requests all read the same count, all pass
 * the cap check, and all get a score back — the cap would bound nothing. So:
 *   * no previous row  → INSERT, and treat a unique violation as a lost race;
 *   * previous row     → UPDATE guarded by `attempt_count = <the value we
 *     read>`, and treat "matched no rows" as a lost race.
 * attempt_count is the version column, and 0090 makes it strictly increasing on
 * every interactive write from any starting state (file rows sit at 0), so the
 * guard can never be satisfied twice by the same value. The loser gets 429 and
 * writes nothing. */
export async function submitQuizWith(
  store: QuizStore,
  studentId: string,
  generationId: string,
  answers: unknown,
  now: number = Date.now(),
): Promise<SubmitResult> {
  if (!UUID.test(generationId)) return { ok: false, status: 404, error: "No such quiz." };
  if (!answers || typeof answers !== "object" || Array.isArray(answers))
    return { ok: false, status: 400, error: "Those answers didn't look right — please try again." };

  if (!(await isAssignedToStudent(store, studentId, generationId)))
    return { ok: false, status: 403, error: "This quiz isn't assigned to you." };

  // One row per (generation, student) — a retake OVERWRITES, it does not add a
  // row — so this read serves three purposes at once: the cooldown window, the
  // attempt tally, and the value the swap below compares against.
  const { data: prev } = await store
    .from("submissions")
    .select("submitted_at, attempt_count, mode")
    .eq("generation_id", generationId)
    .eq("student_id", studentId)
    .maybeSingle();

  // The raw value we must swap against, whatever kind of row is there.
  const prevCount = Number(prev?.attempt_count ?? 0);
  // Attempts SPENT, which only an interactive row can have spent. A student who
  // filed a file submission first has taken no in-app attempt, and that row
  // sits at attempt_count = 0 by construction (0090 default + 0091 pin), so the
  // two readings agree — but say it explicitly rather than lean on the default.
  const prevInteractive = prev?.mode === "interactive";
  const used = prevInteractive ? prevCount : 0;

  // Scoped to interactive: uploading a file and then opening the quiz is a
  // normal sequence, not a double-tap, and must not be rate-limited as one.
  if (prevInteractive) {
    const prevAt = prev?.submitted_at ? Date.parse(String(prev.submitted_at)) : NaN;
    if (!Number.isNaN(prevAt) && now - prevAt < RESUBMIT_COOLDOWN_MS && now - prevAt >= 0)
      return { ok: false, status: 429, error: "You've just submitted this quiz — give it a moment before trying again." };
  }

  if (used >= MAX_INTERACTIVE_ATTEMPTS)
    return {
      ok: false,
      status: 409,
      error: `You've used all ${MAX_INTERACTIVE_ATTEMPTS} tries at this quiz. Ask your teacher if you need another one.`,
    };

  const raw = await loadQuizArtifact(store, generationId);
  if (!raw || raw.questions.length === 0) return { ok: false, status: 404, error: "No such quiz." };

  const kept = pickAnswers(raw.questions, answers as Record<string, unknown>);
  const score = scoreQuiz(raw.questions, kept);
  const attempt = used + 1;

  const row = {
    generation_id: generationId,
    student_id: studentId,
    mode: "interactive",
    answers: kept,
    file_path: null,
    auto_score: score.auto,
    max_score: score.max,
    // A retake must un-grade: the mark AND the written feedback both belonged
    // to answers that no longer exist.
    teacher_score: null,
    feedback: null,
    graded_by: null,
    graded_at: null,
    grade_status: score.needsReview ? "pending" : "auto",
    submitted_at: new Date(now).toISOString(),
    attempt_count: attempt,
  };

  if (!prev) {
    const { error } = await store.from("submissions").insert(row);
    if (error) return lostTheRace(error) ? RACE_LOST : { ok: false, status: 500, error: error.message };
  } else {
    const { data: hit, error } = await store
      .from("submissions")
      .update(row)
      .eq("generation_id", generationId)
      .eq("student_id", studentId)
      .eq("attempt_count", prevCount) // ← the compare half of the swap
      .select("id");
    if (error) return { ok: false, status: 500, error: error.message };
    if (!hit || hit.length === 0) return RACE_LOST;
  }

  return { ok: true, ...score, attempt, attemptsLeft: MAX_INTERACTIVE_ATTEMPTS - attempt };
}
