// SK S3 slice B — the student's "explain this" on kit content: ONE model turn
// grounded on the section's own narration and points from the Kit Manifest.
//
// Same rules as the graph loop's question turn (src/sk/loop.ts runTurn):
//   - live help needs TUTOR access with allowance left (loadAccessFor →
//     liveAllowed); without it SK says so in its own words and no model runs;
//   - a turn that reached the model is METERED through the loop's own write
//     point (meterUsage → sk_usage, one live_turns), cancelled or not;
//   - the answer is buffered and held to the narration by groundingCheck
//     (§9.3): a sentence with a name or number the kit does not say is dropped,
//     and if nothing survives SK reads the section's heading and points.
// The narration reaches the model as DATA inside the TEACHING block
// (shell/teach.ts), exactly as the Board's explain does, and never the client.
//
// Server-only by use (it is handed a provider and a store); no I/O of its own.

import type { LLMProvider } from "@/utils/assistant/provider";
import { liveAllowed } from "./entitlement";
import { accessView, liveRefusalText, loadAccessFor, meterUsage, type AccessDeps } from "./loop";
import type { KitManifest } from "./manifest/derive";
import { groundingCheck } from "./shell/prompt";
import { supportFrom, TEACH_MAX_TOKENS, teachingBlock, teachingSupportTokens } from "./shell/teach";
import { NO_TEACHER_TEXT } from "./teacher";
import type { SseEvent } from "./types";

export type KitTurnDeps = AccessDeps & { teacherProvider?: LLMProvider };

export type KitTurnInput = {
  studentId: string;
  /** The product's slug (entitlements and sk_usage are keyed through it). */
  productSlug: string;
  manifest: KitManifest;
  /** The section, by manifest key ("p1:s003"). */
  segmentKey: string;
  /** The student's own question about the section; absent = "explain this". */
  question?: string;
  /** The locale's language name, for the reply ("English", "Bahasa Melayu"…). */
  language: string;
  signal?: AbortSignal;
};

export const KIT_TUTOR_SYSTEM = [
  "You are SK, a friendly tutor helping ONE student through a lesson video, section by section.",
  "Speak to the student directly and warmly, at their level. Plain text only: 2–4 short sentences, no headings, no lists, no markdown.",
  "Teach only from the TEACHING data below. You may rephrase and give a simple everyday comparison, but add no names, numbers, dates, definitions or formulae of your own.",
].join("\n");

export const NO_SECTION_TEXT = "I can't find that section of the lesson. Pick a section from the list and ask me again.";

/** The user turn for the call. The question is quoted as the student's words. */
export function kitTurnQuestion(heading: string, language: string, question?: string): string {
  const q = (question ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
  if (q) {
    return `The student asks about "${heading || "this section"}": "${q}". Answer in ${language}, from the narration in TEACHING. If TEACHING does not cover it, say this section does not cover it and say what it does cover.`;
  }
  return `Explain "${heading || "this section"}" to the student in ${language}, using only the narration in TEACHING.`;
}

/** What SK says when the model's words did not survive the grounding check:
 *  the section's own heading and points (kit text, so grounded by definition). */
export function captionLine(heading: string, points: string[]): string {
  const ps = points.filter(Boolean).slice(0, 4);
  return [heading, ...ps].filter(Boolean).join(". ").replace(/\.\./g, ".").trim();
}

export async function* runKitExplain(deps: KitTurnDeps, input: KitTurnInput): AsyncGenerator<SseEvent, void, void> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  let access = await loadAccessFor(deps, input.studentId, input.productSlug);
  const usage = { inputTokens: 0, outputTokens: 0 };
  let modelReached = false;
  let cancelled = false;
  let label: "grounded" | "declined" = "grounded";
  let trimmed = false;

  const sup = supportFrom(input.manifest, { segmentId: input.segmentKey });
  yield { event: "meta", data: { move: input.question ? "ask" : "explain", segment: input.segmentKey } };

  if (sup.status !== "ready") {
    label = "declined";
    yield { event: "text", data: NO_SECTION_TEXT };
  } else if (!liveAllowed(access)) {
    // Live help is what tutor access buys; the lesson itself plays on book access.
    label = "declined";
    yield { event: "text", data: liveRefusalText(access) };
  } else if (!deps.teacherProvider) {
    label = "declined";
    yield { event: "text", data: NO_TEACHER_TEXT };
  } else {
    const seg = sup.segments[0]!;
    const system = `${KIT_TUTOR_SYSTEM}\n${teachingBlock(sup)}`;
    const question = kitTurnQuestion(seg.heading, input.language, input.question);
    let full = "";
    modelReached = true;
    try {
      for await (const ev of deps.teacherProvider.stream({ system, messages: [{ role: "user", text: question }], maxTokens: TEACH_MAX_TOKENS, signal: input.signal })) {
        if (ev.type === "text") full += ev.text;
        else if (ev.type === "done") Object.assign(usage, ev.usage);
        else if (ev.type === "error") console.error("[sk] kit explain", ev.retryable ? "retryable" : "fatal", ev.message);
      }
    } catch (e) {
      if (input.signal?.aborted) cancelled = true;
      else console.error("[sk] kit explain failed:", (e as Error).message);
    }
    if (input.signal?.aborted) cancelled = true;
    // §9.3: every name and number must occur in the kit's words (or the student's question).
    const verdict = groundingCheck(full, teachingSupportTokens(sup), input.question ?? "");
    if (!verdict.ok) {
      trimmed = true;
      console.info("[sk] kit explain grounding", JSON.stringify({ segment: input.segmentKey, unsupported: verdict.unsupported }));
    }
    const text = (verdict.ok ? full.trim() : verdict.text.trim()) || captionLine(seg.heading, seg.points);
    if (!cancelled) yield { event: "text", data: text };
  }

  // B8 write point, unchanged: a turn that reached the model is one live turn.
  if (modelReached) access = await meterUsage(deps.store, input.studentId, access, { live_turns: 1, generated_segments: 0 }, input.productSlug);
  yield {
    event: "done",
    data: {
      latency: { totalMs: now() - t0 },
      usage,
      label,
      ...(trimmed ? { trimmed: true } : {}),
      ...(modelReached ? { metered: { live_turns: 1, generated_segments: 0 } } : {}),
      ...(cancelled ? { cancelled: true } : {}),
      access: accessView(access),
    },
  };
}
