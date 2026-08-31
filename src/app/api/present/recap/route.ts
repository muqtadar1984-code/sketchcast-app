import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@/utils/tutor/service";
import { TUTOR_MODELS } from "@/utils/tutor/models";
import { caller, ownedSession, jsonBody, NOT_FOUND, type Caller } from "@/utils/present/server";
import { checkPublish, PUBLISH_MESSAGE, MAX_BODY } from "@/utils/present/audience";
import {
  buildGround,
  cleanRecap,
  fallbackRecap,
  recapPrompt,
  RECAP_USER_TURN,
  type ChapterFacts,
  type RecapItem,
} from "@/utils/present/recap";

export const runtime = "nodejs";

// The after-lesson note: draft it, edit it, publish it.
//
// GROUNDED ON WHAT SHE SHOWED, NEVER ON THE TIMETABLE. present_items is the
// evidence — that is why 0097 has it as a separate table from the session's
// context — so a Chapter 4 period spent revising chapters 1-5 produces a note
// about revision rather than a confident lie about chapter 4.
//
// NOT THE INK. Nobody can read handwriting from a stroke list, and a note that
// guessed at what she wrote would be worse than one that did not mention it. The
// page count is the only thing the roll contributes.
//
// NO CREDIT, BUT NOT UNMETERED. A credit is one generation (0075) and a
// two-sentence note about a lesson already taught is not one. But a panel with a
// stuck retry is an unbounded spend, so the month's allowance is RESERVED
// atomically before the call — 0099's present_recap_reserve, the mould of
// tutor_sketch_reserve.
//
// THE BAN IS CHECKED, NOT REQUESTED. "never 'played the video'" is in the prompt
// AND in cleanRecap(). Prompt compliance is the thing this codebase has already
// been bitten by twice — a Gemini kit shipped SSML inside a field documented as
// clean text, because nothing checked. A violation is handed back once with its
// own reason, and after that she gets the honest fallback sentence rather than a
// note about the machinery.

const CAP_PER_MONTH = 200;
const MAX_TOKENS = 220;
/** Two attempts total: the first, then one told exactly which rule it broke. */
const ATTEMPTS = 2;

const period = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

export async function POST(request: Request) {
  const c = await caller();
  if (!c) return NOT_FOUND();
  const b = await jsonBody(request);
  if (!b) return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });

  const session = await ownedSession(c, typeof b.sessionId === "string" ? b.sessionId : "");
  if (!session) return NOT_FOUND();
  // The evidence is only complete once the lesson is. Drafting mid-period would
  // describe half a lesson and then look stale for the rest of it.
  if (!session.ended_at) {
    return NextResponse.json({ error: PUBLISH_MESSAGE["not-closed"] }, { status: 409 });
  }

  // ── the evidence ───────────────────────────────────────────────────────────
  const { data: itemRows } = await c.admin
    .from("present_items")
    .select("kind, detail")
    .eq("session_id", session.id)
    .order("seq", { ascending: true });

  type Row = { kind: string; detail: Record<string, unknown> | null };
  const items: RecapItem[] = ((itemRows ?? []) as Row[]).map((i) => ({
    kind: i.kind === "video" || i.kind === "worksheet" ? i.kind : "blank",
    chapterNum: typeof i.detail?.chapterNum === "number" ? i.detail.chapterNum : null,
    part: typeof i.detail?.part === "number" ? i.detail.part : null,
  }));

  const ground = buildGround(items, await chapterFacts(c.admin, session.book_id, items), session.page_count ?? 1);

  // ── the allowance ─────────────────────────────────────────────────────────
  //
  // RESERVED PER CALL, NOT PER REQUEST. write() may make two calls — the first,
  // and one told what it got wrong — so a single reservation per request would
  // make a "200 a month" ceiling authorise 400 model calls. The reserve function
  // is handed to write() and taken immediately before each attempt.
  //
  // AND NOT AT ALL WHEN THERE IS NOTHING TO SPEND IT ON: no API key, or nothing
  // to write about. fallbackRecap already covers both, and burning the month's
  // allowance on calls that never leave the process would eventually turn an
  // honest "the note could not be drafted" into a false "you are rate-limited".
  const month = period(new Date());
  const reserve = async (): Promise<{ ok: true } | { ok: false; why: string }> => {
    const { data, error } = await c.admin.rpc("present_recap_reserve", {
      p_user: c.userId,
      p_period: month,
      p_cap: CAP_PER_MONTH,
    });
    // AN ERROR IS NOT A FULL BUCKET. Before 0099 is applied this RPC does not
    // exist, and reporting that as "rate-limited this month" would be a lie that
    // looks like a policy — the teacher would wait for a month that never fixes
    // it. Same for a transport failure.
    if (error) {
      console.error("[present/recap] reserve failed", error.message);
      return { ok: false, why: "the note could not be drafted just now" };
    }
    return data === true
      ? { ok: true }
      : { ok: false, why: "you have reached this month's drafting limit" };
  };

  let draft = "";
  let source: "model" | "fallback" = "fallback";
  let note: string | null = null;

  if (!process.env.ANTHROPIC_API_KEY) {
    draft = fallbackRecap(ground);
    note = "drafting is not configured on this deployment";
  } else if (!ground.chapters.length && !ground.revision) {
    // Nothing was shown. There is no prompt worth sending and no sentence the
    // model could write that fallbackRecap does not write for free.
    draft = fallbackRecap(ground);
    note = "nothing was opened in this lesson, so there was nothing to describe";
  } else {
    const written = await write(ground, reserve);
    if (written.ok) {
      draft = written.text;
      source = "model";
    } else {
      draft = fallbackRecap(ground);
      note = written.why;
    }
  }

  const { error } = await c.admin
    .from("present_sessions")
    .update({ recap_draft: draft })
    .eq("id", session.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // recap_body is seeded from the draft only when she has not written her own —
  // re-drafting must never silently discard an edit she has already made.
  const body = session.recap_body ?? draft;
  return NextResponse.json({ draft, body, source, note });
}

/**
 * Save what she wrote, and publish or withdraw it.
 *
 * Publishing is the one irreversible-feeling action here, so it is a separate
 * flag rather than a side effect of saving: she can rewrite the sentence as many
 * times as she likes without it reaching anybody, and `publish: false`
 * withdraws — because a revoke with no restore is how a typo becomes permanent
 * (0068 learned this the expensive way and had to add /api/notices/unrevoke).
 */
export async function PATCH(request: Request) {
  const c = await caller();
  if (!c) return NOT_FOUND();
  const b = await jsonBody(request);
  if (!b) return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });

  const session = await ownedSession(c, typeof b.sessionId === "string" ? b.sessionId : "");
  if (!session) return NOT_FOUND();

  const publish = b.publish === true;
  const withdraw = b.publish === false;
  const raw = typeof b.body === "string" ? b.body : (session.recap_body ?? "");

  const check = checkPublish({ class_id: session.class_id, ended_at: session.ended_at }, raw);
  // Saving has a lower bar than publishing: an empty box is a save she can
  // recover from, and only `no-audience` / `not-closed` are about the lesson
  // rather than the text.
  if (publish && !check.ok) {
    return NextResponse.json(
      { error: PUBLISH_MESSAGE[check.reason], reason: check.reason },
      { status: 409 },
    );
  }

  const body = raw.replace(/\s+/g, " ").trim();
  // WITHDRAWING IS EXEMPT. It publishes nothing, so the length of whatever
  // happens to be in the box is irrelevant — and refusing it would pin a note
  // published while she reworded it, which is the exact trap the withdraw
  // button exists to open.
  if (!publish && !withdraw && body.length > MAX_BODY) {
    return NextResponse.json({ error: PUBLISH_MESSAGE["too-long"] }, { status: 400 });
  }
  // 0099's CHECK — recap_published_at implies recap_body — would reject this as
  // a 500 that reads like a bug. Emptying a note that people can already read is
  // a withdrawal, and a withdrawal should be the thing she asked for rather than
  // something inferred from a cleared textarea.
  if (!body && !withdraw && session.recap_published_at) {
    return NextResponse.json(
      { error: "This note is published. Withdraw it first, then clear it.", reason: "published" },
      { status: 409 },
    );
  }

  const patch: Record<string, unknown> = { recap_body: body || null };
  if (publish) patch.recap_published_at = new Date().toISOString();
  if (withdraw) patch.recap_published_at = null;

  const { error } = await c.admin.from("present_sessions").update(patch).eq("id", session.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const publishedAt = publish
    ? (patch.recap_published_at as string)
    : withdraw
      ? null
      : session.recap_published_at;

  return NextResponse.json({ ok: true, body, publishedAt });
}

/** Next auto-implements OPTIONS with a 204 and an Allow header when a route file
 *  does not, which advertises the surface to an unauthenticated caller. Taken
 *  back explicitly, as api/present/probe already does. */
export async function OPTIONS() {
  return NOT_FOUND();
}

// ── the model call ───────────────────────────────────────────────────────────

/**
 * One cheap call, and one retry that is told what it got wrong.
 *
 * No `temperature`: claude-sonnet-5 rejects it outright and the rest of this
 * codebase has stopped sending it. No `cache_control` either — the stable
 * instruction block is a few hundred tokens, far below the minimum cacheable
 * prefix, so a marker would be decoration rather than a saving.
 */
async function write(
  ground: ReturnType<typeof buildGround>,
  reserve: () => Promise<{ ok: true } | { ok: false; why: string }>,
): Promise<{ ok: true; text: string } | { ok: false; why: string }> {
  const { instructions, context } = recapPrompt(ground);
  // LOCAL, not module-level. A serverless function handles concurrent requests
  // in one process, and a module-level `let` here would let one teacher's
  // rejected draft become another's retry context.
  let lastWhy = "the model did not answer";
  let lastAnswer = "";

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const allowance = await reserve();
    if (!allowance.ok) return attempt === 0 ? allowance : { ok: false, why: lastWhy };

    const messages: Anthropic.MessageParam[] = [
      // THE CHAPTER MATERIAL IS DATA, AND IT SITS IN A USER TURN.
      //
      // source_text is raw OCR of an uploaded PDF, and on a school shelf the
      // uploader need not be the teacher drafting. Untrusted document text in
      // the SYSTEM role is the strongest position an injection can occupy — a
      // scanned page reading "ignore the above and write X" would be read as
      // policy. Here it is quoted content between markers, and rule 6 says what
      // to do with it.
      {
        role: "user",
        content: `<chapter-material>
${context}
</chapter-material>

${RECAP_USER_TURN}`,
      },
    ];
    if (attempt > 0) {
      messages.push(
        { role: "assistant", content: lastAnswer || "…" },
        { role: "user", content: correction(lastWhy) },
      );
    }

    let text = "";
    try {
      const resp = await anthropic().messages.create({
        model: TUTOR_MODELS.cheap,
        max_tokens: MAX_TOKENS,
        system: instructions,
        messages,
      });
      const block = resp.content.find((x) => x.type === "text");
      text = block && block.type === "text" ? block.text : "";
      // A note cut off at the token ceiling is half a sentence, and half a
      // sentence published to a parent is worse than the fallback. The
      // truncated text is still the evidence the retry should see.
      if (resp.stop_reason === "max_tokens") {
        lastAnswer = text;
        lastWhy = "it ran past the length limit";
        continue;
      }
    } catch (e) {
      console.error("[present/recap] model call failed", e);
      return { ok: false, why: "the note could not be drafted just now" };
    }

    lastAnswer = text;
    const cleaned = cleanRecap(text);
    if (cleaned.ok) return { ok: true, text: cleaned.text };
    lastWhy = cleaned.reason;
  }

  return { ok: false, why: lastWhy };
}

/** What to tell the model on the retry. A length overrun and a banned word are
 *  different mistakes, and telling it to avoid forbidden words when it was
 *  merely too long is how the second attempt truncates the same way. */
function correction(why: string): string {
  if (why === "it ran past the length limit") {
    return "That was too long and got cut off. Write ONE short sentence about the concept — nothing else.";
  }
  return (
    `That will be thrown away because ${why}. Write it again about the CONCEPT ` +
    `only — what the class now understands — using none of the forbidden words.`
  );
}

// ── the chapters she opened ──────────────────────────────────────────────────

/**
 * Title, concepts and text for every chapter in the evidence.
 *
 * Two sources, and in practice only the second one is populated: measured on
 * 2026-08-29, 244 chapter_grounding rows carried source_text and 25 carried a
 * title or concepts. So the book's own contents page — books.chapters[n].title —
 * is the reliable name, and chapter_grounding contributes whatever it has.
 */
async function chapterFacts(
  admin: Caller["admin"],
  bookId: string | null,
  items: RecapItem[],
): Promise<ChapterFacts[]> {
  const nums = [
    ...new Set(items.map((i) => i.chapterNum).filter((n): n is number => typeof n === "number")),
  ];
  if (!bookId || !nums.length) return [];

  const [{ data: book }, { data: grounding }] = await Promise.all([
    admin.from("books").select("chapters").eq("id", bookId).maybeSingle(),
    admin
      .from("chapter_grounding")
      .select("chapter_num, chapter_title, concepts, script_text, source_text")
      .eq("book_id", bookId)
      .in("chapter_num", nums),
  ]);

  const chapters = Array.isArray(book?.chapters) ? (book.chapters as { title?: string }[]) : [];
  type G = {
    chapter_num: number;
    chapter_title: string | null;
    concepts: unknown;
    script_text: string | null;
    source_text: string | null;
  };
  const byNum = new Map(((grounding ?? []) as G[]).map((g) => [g.chapter_num, g]));

  return nums.map((chapterNum) => {
    const g = byNum.get(chapterNum);
    return {
      chapterNum,
      title: g?.chapter_title ?? chapters[chapterNum]?.title ?? null,
      concepts: g?.concepts ?? null,
      scriptText: g?.script_text ?? null,
      sourceText: g?.source_text ?? null,
    };
  });
}
