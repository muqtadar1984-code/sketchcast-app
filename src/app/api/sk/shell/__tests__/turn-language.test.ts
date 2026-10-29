/**
 * The answer language through POST /api/sk/shell/turn (founder 2026-10-30):
 *   - "say that in Malay" re-says SK's LAST explanation in Malay with ONE
 *     translation call (Haiku 5.5), grounded on the original (a changed
 *     number is stripped), and SK keeps answering in Malay — the prompt's
 *     rule 6, the `lang` event (direction + voice + dictation) — until "back
 *     to English";
 *   - nothing said yet → SK's line in the current language, no model; an
 *     unknown language → "I can speak …";
 *   - an Arabic kit on the Board with an English UI → SK answers in Arabic
 *     (rule 6, the lang event, the teaching question); an override beats it;
 *   - a teacher's repeat is counted as a Shell turn (usage once), nothing metered.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/shell/__tests__/turn-language.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StubTurn } from "@/utils/assistant/providers/stub";
import type { GenerateOpts, StreamEvent } from "@/utils/assistant/provider";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  cookies: {} as Record<string, string>,
  queue: [] as unknown[][],
  constructed: [] as string[],
  opts: [] as GenerateOpts[],
  manifest: { status: "missing" } as unknown,
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (mocks.cookies[n] ? { value: mocks.cookies[n] } : undefined) }) }));
vi.mock("@/utils/platform-admin", () => ({ founderEmails: () => [], staffUserIds: async () => new Set<string>() }));
vi.mock("@/utils/assistant/providers/anthropic", async () => {
  const { StubProvider } = await import("@/utils/assistant/providers/stub");
  return {
    AnthropicProvider: class extends StubProvider {
      constructor(model: string) {
        super((mocks.queue.shift() ?? [{ text: ["(unscripted)"] }]) as StubTurn[]);
        mocks.constructed.push(model);
      }
      async *stream(opts: GenerateOpts): AsyncGenerator<StreamEvent, void, void> {
        mocks.opts.push(opts);
        yield* super.stream(opts);
      }
    },
  };
});
vi.mock("@/sk/manifest/store", async () => {
  const real = await vi.importActual<typeof import("@/sk/manifest/store")>("@/sk/manifest/store");
  return { ...real, readManifest: async () => mocks.manifest };
});

import { POST } from "@/app/api/sk/shell/turn/route";
import { LANG_CAN_SPEAK, LANG_NOTHING_TO_REPEAT, LANG_SWITCHED } from "@/sk/shell/language-lines";
import { canSpeakList } from "@/sk/shell/language";
import { verifyMemory } from "@/sk/shell/memory";
import { SCHOOL_ID, TEACHER_ID, fakeAdmin, fakeManifest, fakeSession, readEvents } from "@/sk/shell/__tests__/fixtures";

const ENV = ["FEATURE_SK", "SK_ROLES", "SK_ALLOWED_EMAILS", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_CONSUMER", "SK_SHELL_SECRET", "FEATURE_ROLE_HATS", "SK_SHELL_MODEL", "SK_TRANSLATE_MODEL", "SK_AUDIT", "PRESENT_ALLOWED_EMAILS"];
const saved: Record<string, string | undefined> = {};
const USER = { id: TEACHER_ID, email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" };
const tables = () => ({
  profiles: [{ role: "teacher", school_id: SCHOOL_ID }],
  schools: [{ config: {} }],
  coordinator_scope: [],
  parent_links: [],
  classes: [{ id: "c7b", name: "7B", teacher_id: TEACHER_ID, school_id: SCHOOL_ID }],
  enrollments: [],
  books: [],
});

type Ev = Record<string, unknown> & { type: string };
const req = (body: unknown) => new Request("http://x/api/sk/shell/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const turn = (text: string, memory?: string, collector: Record<string, unknown> = { path: "/dashboard", locale: "en" }) => ({
  turnId: `t-${Math.random().toString(36).slice(2)}`,
  text,
  modality: "text",
  collector,
  ...(memory ? { memory } : {}),
});
async function say(text: string, memory?: string, collector?: Record<string, unknown>): Promise<{ ev: Ev[]; memory: string; text: string; done: Ev }> {
  const ev = (await readEvents(await POST(req(turn(text, memory, collector))))) as Ev[];
  const done = ev.find((e) => e.type === "done")!;
  return { ev, done, memory: done.memory as string, text: ev.filter((e) => e.type === "text").map((e) => e.text).join("") };
}
const userTurnOf = (o: GenerateOpts) => {
  const m = o.messages[o.messages.length - 1] as { text?: string };
  return m.text ?? "";
};

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
  process.env.SK_ROLES = "teacher";
  process.env.FEATURE_SK_SHELL_ALL_SCHOOLS = "true";
  process.env.SK_SHELL_SECRET = "route-test-secret-of-adequate-length";
  process.env.FEATURE_ROLE_HATS = "true";
  mocks.cookies = { sc_hat: "teacher" };
  mocks.queue = [];
  mocks.constructed = [];
  mocks.opts = [];
  mocks.manifest = { status: "missing" };
  mocks.createAdminClient.mockReturnValue(fakeAdmin("school"));
  mocks.createClient.mockResolvedValue(fakeSession(tables(), { user: USER }));
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
});

const EXPLANATION = "Diffusion is the movement of particles from a high concentration to a low one. It needs no energy, and it slows down as the 2 sides even out.";
const MALAY = "Resapan ialah pergerakan zarah dari kepekatan tinggi ke kepekatan rendah. Ia tidak memerlukan tenaga, dan ia menjadi perlahan apabila 2 bahagian menjadi sama.";

describe("an English explanation, then 'say that in Malay'", () => {
  it("ONE translation call on the LAST answer (Haiku 5.5), a Malay lang event, the override kept until 'back to English'", async () => {
    mocks.queue.push([{ text: [EXPLANATION] }]);
    const first = await say("what is diffusion across 2 sides");
    expect(first.text).toBe(EXPLANATION);
    expect(first.ev.some((e) => e.type === "lang")).toBe(false); // the page's language needs no event
    // A long answer is kept WHOLE (the turns keep 400 characters each).
    expect(verifyMemory(first.memory)!.lastAnswer).toEqual({ text: EXPLANATION, lang: "en", label: "supplementary", sources: [] });

    mocks.queue.push([{ text: [MALAY] }]);
    const second = await say("say that in Malay", first.memory);
    expect(second.ev.map((e) => e.type)).toEqual(["meta", "lang", "text", "done"]);
    expect(second.ev[0]).toMatchObject({ intent: "lang" });
    expect(second.ev[1]).toEqual({ type: "lang", lang: "ms", dir: "ltr", speech: "ms-MY", override: true });
    expect(second.text).toBe(MALAY);
    expect(second.done).toMatchObject({ label: "supplementary", sources: ["sk.repeat"], usage: { inputTokens: 100, outputTokens: 50 } });
    // Exactly one model, the translation model, no tools, the ORIGINAL as data.
    expect(mocks.constructed).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
    const t = mocks.opts[1]!;
    expect(t.tools).toBeUndefined();
    expect(t.system).toContain(`<original data_only="true">\n${EXPLANATION}\n</original>`);
    expect(t.system).toContain("Translate faithfully into Bahasa Melayu (Malay)");
    expect(userTurnOf(t)).toBe("Say the ORIGINAL again in Bahasa Melayu (Malay).");
    const mem = verifyMemory(second.memory)!;
    expect(mem.langOverride).toBe("ms");
    expect(mem.lastAnswer?.text).toBe(EXPLANATION); // the repeat never replaces the original

    // The next turn: still Malay — rule 6 and the lang event.
    mocks.queue.push([{ text: ["Osmosis ialah resapan air."] }]);
    const third = await say("what is osmosis", second.memory);
    expect(third.ev.find((e) => e.type === "lang")).toEqual({ type: "lang", lang: "ms", dir: "ltr", speech: "ms-MY", override: true });
    expect(mocks.opts[2]!.system).toContain("6. Answer in Bahasa Melayu — the user asked for Bahasa Melayu");

    // "now in Arabic" translates the ORIGINAL — whatever the last turn said.
    mocks.queue.push([{ text: ["الانتشار هو حركة الجسيمات من تركيز عالٍ إلى تركيز منخفض."] }]);
    const fourth = await say("now in Arabic", third.memory);
    expect(fourth.ev.find((e) => e.type === "lang")).toEqual({ type: "lang", lang: "ar", dir: "rtl", speech: "ar-SA", override: true });
    expect(mocks.opts[3]!.system).toContain("Osmosis ialah resapan air.");

    // "back to English": the override clears; SK says so in English; the next turn has no lang event.
    const back = await say("back to English", fourth.memory);
    // Back on the page's own language: no lang event (the panel resets dictation on every meta).
    expect(back.ev.some((e) => e.type === "lang")).toBe(false);
    expect(back.text).toBe(LANG_SWITCHED.en.replace("{language}", "English"));
    expect(verifyMemory(back.memory)!.langOverride).toBeUndefined();
    mocks.queue.push([{ text: ["Active transport needs energy."] }]);
    const after = await say("what is active transport", back.memory);
    expect(after.ev.some((e) => e.type === "lang")).toBe(false);
    expect(mocks.opts[mocks.opts.length - 1]!.system).toContain("6. Answer in the user's language (English)");
  });

  it("a translation that changes a number loses that sentence (grounded on the original)", async () => {
    mocks.queue.push([{ text: [EXPLANATION] }]);
    const first = await say("what is diffusion across 2 sides");
    mocks.queue.push([{ text: ["Resapan ialah pergerakan zarah dari kepekatan tinggi ke kepekatan rendah. ", "Ia menjadi perlahan apabila 3 bahagian menjadi sama."] }]);
    const second = await say("ulang dalam bahasa Melayu", first.memory);
    expect(second.text).toBe("Resapan ialah pergerakan zarah dari kepekatan tinggi ke kepekatan rendah.");
    expect(second.done).toMatchObject({ trimmed: true });
  });

  it("the same language again: the original, no model", async () => {
    mocks.queue.push([{ text: [EXPLANATION] }]);
    const first = await say("what is diffusion across 2 sides");
    const again = await say("explain that again in English", first.memory);
    expect(again.text).toBe(EXPLANATION);
    expect(mocks.constructed).toHaveLength(1);
  });

  it("nothing said yet → SK's line in the current language, no model, no override", async () => {
    const r = await say("say that in Malay");
    expect(r.text).toBe(LANG_NOTHING_TO_REPEAT.en);
    expect(r.done).toMatchObject({ label: "declined" });
    expect(mocks.constructed).toEqual([]);
    expect(verifyMemory(r.memory)!.langOverride).toBeUndefined();
    // A Malay page: the line in Malay.
    const ms = await say("say that in Arabic", undefined, { path: "/dashboard", locale: "ms" });
    expect(ms.text).toBe(LANG_NOTHING_TO_REPEAT.ms);
  });

  it("an unknown language → I can speak …, no model", async () => {
    mocks.queue.push([{ text: [EXPLANATION] }]);
    const first = await say("what is diffusion across 2 sides");
    const r = await say("say that in Tamil", first.memory);
    expect(r.text).toBe(LANG_CAN_SPEAK.en.replace("{list}", canSpeakList()));
    expect(r.text).toContain("中文");
    expect(mocks.constructed).toHaveLength(1);
  });

  it("Chinese: an answer language with no UI dictionary — the model answers in Chinese, the lines fall back to English", async () => {
    mocks.queue.push([{ text: [EXPLANATION] }]);
    const first = await say("what is diffusion across 2 sides");
    mocks.queue.push([{ text: ["扩散是粒子从高浓度向低浓度的运动。它不需要能量，当2边趋于平衡时会变慢。"] }]);
    const zh = await say("用中文再说一遍", first.memory);
    expect(zh.ev.find((e) => e.type === "lang")).toEqual({ type: "lang", lang: "zh", dir: "ltr", speech: "zh-CN", override: true });
    expect(zh.text).toContain("扩散");
    mocks.queue.push([{ text: ["渗透是水的扩散。"] }]);
    await say("what is osmosis", zh.memory);
    expect(mocks.opts[mocks.opts.length - 1]!.system).toContain("6. Answer in Simplified Chinese (zh-CN)");
  });
});

// ── An Arabic kit on the Board, an English UI ───────────────────────────────

const NARR = "تحمل خلايا الدم الحمراء الأكسجين إلى أنحاء الجسم.";
const AR_MANIFEST = { ...fakeManifest([{ id: "s1", heading: "مقدمة", narration: "مقدمة الدرس." }, { id: "s2", heading: "خلايا الدم الحمراء", narration: NARR }], [{ id: "c1", name: "red blood cell", segmentIds: ["s2"] }]), language: "ar" };
const BOARD = {
  sessionId: "sess-1",
  manifestId: "man-1",
  generationId: "gen-1",
  k: 1,
  segmentId: "s2",
  t: 40,
  paused: true,
  language: "ar",
  segments: [
    { k: 0, id: "s1", heading: "مقدمة" },
    { k: 1, id: "s2", heading: "خلايا الدم الحمراء" },
  ],
  concepts: [{ id: "c1", name: "red blood cell", segmentIds: ["s2"] }],
};
const onBoard = { path: "/present", locale: "en", board: BOARD };

describe("an Arabic kit on the Board with an English UI", () => {
  it("the model answers in Arabic by default: rule 6, and an RTL lang event before the text", async () => {
    mocks.queue.push([{ text: ["هذا الدرس عن خلايا الدم."] }]);
    const r = await say("what is this lesson about?", undefined, onBoard);
    expect(r.ev.map((e) => e.type).slice(0, 2)).toEqual(["meta", "lang"]);
    expect(r.ev[1]).toEqual({ type: "lang", lang: "ar", dir: "rtl", speech: "ar-SA", override: false });
    expect(mocks.opts[0]!.system).toContain("6. Answer in Arabic, the language of the lesson material");
  });

  it("explain on the Board: the teaching call is asked in Arabic (the manifest's language)", async () => {
    mocks.manifest = { status: "ready", manifest: AR_MANIFEST, builtAt: "2026-10-30T00:00:00Z" };
    mocks.queue.push([{ text: [NARR] }]);
    const r = await say("explain red blood cells", undefined, onBoard);
    expect(r.text).toBe(NARR);
    expect(userTurnOf(mocks.opts[0]!)).toContain("in Arabic, using only the narration in TEACHING");
    expect(verifyMemory(r.memory)!.lastAnswer).toMatchObject({ text: NARR, lang: "ar" });
  });

  it("her override beats the kit's language", async () => {
    mocks.manifest = { status: "ready", manifest: AR_MANIFEST, builtAt: "2026-10-30T00:00:00Z" };
    mocks.queue.push([{ text: [NARR] }]);
    const first = await say("explain red blood cells", undefined, onBoard);
    mocks.queue.push([{ text: ["Red blood cells carry oxygen around the body."] }]);
    const en = await say("say that in English", first.memory, onBoard);
    expect(en.text).toBe("Red blood cells carry oxygen around the body.");
    expect(en.ev.find((e) => e.type === "lang")).toEqual({ type: "lang", lang: "en", dir: "ltr", speech: "en-US", override: true });
    // "back to English" over an Arabic kit keeps English (an explicit override).
    expect(verifyMemory(en.memory)!.langOverride).toBe("en");
    mocks.queue.push([{ text: ["They have no nucleus."] }]);
    await say("what else?", en.memory, onBoard);
    expect(mocks.opts[mocks.opts.length - 1]!.system).toContain("6. Answer in English — the user asked for English");
    // "use my language" over the Arabic kit: English, still explicit.
    const mine = await say("use my language", en.memory, onBoard);
    expect(verifyMemory(mine.memory)!.langOverride).toBe("en");
    // "back to Arabic" — the kit's own language — clears the override.
    const ar = await say("back to Arabic", en.memory, onBoard);
    expect(verifyMemory(ar.memory)!.langOverride).toBeUndefined();
    expect(ar.ev.find((e) => e.type === "lang")).toEqual({ type: "lang", lang: "ar", dir: "rtl", speech: "ar-SA", override: false });
  });

  it("a kit in a language SK cannot answer in: the UI locale, said once per conversation", async () => {
    const tamil = { ...onBoard, board: { ...BOARD, language: "ta" } };
    mocks.queue.push([{ text: ["This lesson is about blood cells."] }]);
    const first = await say("what is this lesson about?", undefined, tamil);
    expect(first.text.startsWith("This material is in a language I can't answer in yet (ta), so I'll answer in English. ")).toBe(true);
    mocks.queue.push([{ text: ["They carry oxygen."] }]);
    const second = await say("what do they do?", first.memory, tamil);
    expect(second.text).toBe("They carry oxygen.");
  });
});
