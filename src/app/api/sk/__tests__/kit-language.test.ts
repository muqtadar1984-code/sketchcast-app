/**
 * The answer language on the student kit player (POST /api/sk/kit/turn,
 * founder 2026-10-30) — parity with the Shell:
 *   - "say that in Malay" typed as her question re-says SK's LAST explanation
 *     in Malay with ONE translation call, grounded on the original and the
 *     section's narration (a changed number is stripped), METERED ONCE like
 *     an explain (one sk_usage live_turns; a resend replays, never twice);
 *   - the choice rides in the signed `state` and holds for the next explain
 *     (asked "in Bahasa Melayu"), until "back to English" (no model, no meter);
 *   - nothing explained yet → SK's line, no model, nothing metered;
 *   - an Arabic kit with an English UI explains in Arabic, RTL;
 *   - a forged state is ignored.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/__tests__/kit-language.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));

import { POST as turn } from "@/app/api/sk/kit/turn/route";
import { StubProvider } from "@/utils/assistant/providers/stub";
import type { GenerateOpts } from "@/utils/assistant/provider";
import { SupabaseEntitlements } from "@/sk/entitlement";
import { SupabaseItemBank } from "@/sk/items-supabase";
import { __setKitDepsForTests, type KitAdmin, type KitDeps } from "@/sk/kit-server";
import { ProductKits } from "@/sk/product-kits";
import { SupabaseSessionStore } from "@/sk/store-supabase";
import { LANG_NOTHING_TO_REPEAT, LANG_SWITCHED } from "@/sk/shell/language-lines";
import { kitManifest, kitWorld, NARRATION_0, SLUG, STUDENT, T0 } from "@/sk/__tests__/kit-fixtures";
import type { FakeDb } from "@/sk/__tests__/fake-supabase";

const EXPLAIN = "A cell is the smallest unit of life.";
const MALAY = "Sel ialah unit hidupan yang paling kecil.";

let n = 0;
const eid = () => `0192f5c0-0000-7000-8000-${String(++n).padStart(12, "0")}`;
type Frame = { event: string; data: unknown };
const frames = async (res: Response): Promise<Frame[]> =>
  (await res.text())
    .split("\n\n")
    .filter(Boolean)
    .map((c) => ({ event: /^event: (.*)$/m.exec(c)![1]!, data: JSON.parse(c.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n")) as unknown }));
type Done = { label?: string; metered?: { live_turns: number }; lang?: { lang: string; dir: string; speech: string; override: boolean }; state?: string; trimmed?: boolean; replayed?: boolean };
async function ask(question: string | undefined, state?: string, opts: { eventId?: string; locale?: string } = {}) {
  const res = await turn(
    new Request("http://x/api/sk/kit/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: opts.eventId ?? eid(), product: SLUG, chapter: "1", segment: "p1:s001", locale: opts.locale ?? "en", ...(question ? { question } : {}), ...(state ? { state } : {}) }),
    }),
  );
  const f = await frames(res);
  const done = f.find((e) => e.event === "done")!.data as Done;
  return { f, done, text: f.filter((e) => e.event === "text").map((e) => String(e.data)).join(""), state: done.state! };
}

let db: FakeDb;
let teacher: StubProvider;
function install(script: string[][], language: string | null = "en") {
  db = kitWorld();
  const admin: KitAdmin = { from: (t: string) => db.from(t), storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/x" }, error: null }) }) } };
  const read = vi.fn(async () => ({ status: "ready" as const, manifest: { ...kitManifest(), language }, builtAt: new Date(T0).toISOString() }));
  teacher = new StubProvider(script.map((text) => ({ text })));
  const entitlements = new SupabaseEntitlements(db);
  const deps: Partial<KitDeps> = {
    kits: new ProductKits(db, entitlements, () => new Date(T0)),
    admin: () => admin,
    read,
    derive: read,
    items: () => new SupabaseItemBank(db),
    store: new SupabaseSessionStore(db, { now: () => T0, pollMs: 1, inflightTimeoutMs: 500 }),
    entitlements,
    teacherProvider: teacher,
    now: () => T0,
  };
  __setKitDepsForTests(deps);
}
const liveTurns = () => (db.rows("sk_usage")[0] as { live_turns?: number } | undefined)?.live_turns ?? 0;
const userTurn = (o: GenerateOpts) => (o.messages[o.messages.length - 1] as { text?: string }).text ?? "";

beforeEach(() => {
  process.env.FEATURE_SK = "true";
  process.env.SK_SHELL_SECRET = "kit-language-test-secret-of-length";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  mocks.createClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: { id: STUDENT } } }) } });
});
afterEach(() => {
  __setKitDepsForTests(null);
  delete process.env.FEATURE_SK;
  delete process.env.SK_SHELL_SECRET;
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("the kit player: 'say that in Malay'", () => {
  it("explain → repeat in Malay (one call, one live turn) → the next explain is asked in Malay → back to English", async () => {
    install([[EXPLAIN], [MALAY], ["Sel membentuk semua benda hidup."]]);
    const first = await ask(undefined);
    expect(first.text).toBe(EXPLAIN);
    expect(first.done.lang).toEqual({ lang: "en", dir: "ltr", speech: "en-US", override: false });
    expect(liveTurns()).toBe(1);

    const rep = await ask("say that in Malay", first.state);
    expect(rep.text).toBe(MALAY);
    expect(rep.done).toMatchObject({ label: "grounded", metered: { live_turns: 1 }, lang: { lang: "ms", dir: "ltr", speech: "ms-MY", override: true } });
    expect(teacher.calls).toHaveLength(2);
    expect(teacher.calls[1]!.system).toContain(`<original data_only="true">\n${EXPLAIN}\n</original>`);
    expect(liveTurns()).toBe(2); // the repeat is ONE live turn, like the explain it came from

    const next = await ask(undefined, rep.state);
    expect(userTurn(teacher.calls[2]!)).toContain("in Bahasa Melayu (Malay)");
    expect(next.done.lang).toMatchObject({ lang: "ms", override: true });

    const back = await ask("back to English", next.state);
    expect(back.text).toBe(LANG_SWITCHED.en.replace("{language}", "English"));
    expect(back.done.lang).toEqual({ lang: "en", dir: "ltr", speech: "en-US", override: false });
    expect(teacher.calls).toHaveLength(3); // no model for "back to"
    expect(liveTurns()).toBe(3); // and nothing metered for it
  });

  it("a resent repeat (same eventId) replays: no second call, no second live turn", async () => {
    install([[EXPLAIN], [MALAY]]);
    const first = await ask(undefined);
    const id = eid();
    await ask("ulang dalam bahasa Melayu", first.state, { eventId: id });
    const again = await ask("ulang dalam bahasa Melayu", first.state, { eventId: id });
    expect(again.done.replayed).toBe(true);
    expect(again.text).toBe(MALAY);
    expect(teacher.calls).toHaveLength(2);
    expect(liveTurns()).toBe(2);
  });

  it("a translation that changes a number loses that sentence", async () => {
    install([["A cell is 1 unit of life. Every living thing is made of cells."], ["Sel ialah 2 unit hidupan. Semua benda hidup diperbuat daripada sel."]]);
    const first = await ask("is a cell 1 unit of life?");
    expect(first.text).toBe("A cell is 1 unit of life. Every living thing is made of cells.");
    const rep = await ask("say that in Malay", first.state);
    expect(rep.text).toBe("Semua benda hidup diperbuat daripada sel.");
    expect(rep.done.trimmed).toBe(true);
  });

  it("nothing explained yet → SK's line, no model, nothing metered", async () => {
    install([[EXPLAIN]]);
    const r = await ask("say that in Malay");
    expect(r.text).toBe(LANG_NOTHING_TO_REPEAT.en);
    expect(r.done.label).toBe("declined");
    expect(teacher.calls).toHaveLength(0);
    expect(liveTurns()).toBe(0);
  });

  it("a forged state is ignored (nothing to repeat)", async () => {
    install([[EXPLAIN]]);
    const first = await ask(undefined);
    const forged = `${first.state.split(".")[0]}.${"0".repeat(64)}`;
    const r = await ask("say that in Malay", forged);
    expect(r.text).toBe(LANG_NOTHING_TO_REPEAT.en);
  });
});

describe("the kit's own language", () => {
  it("an Arabic kit with an English UI explains in Arabic, right to left", async () => {
    install([["الخلية هي أصغر وحدة للحياة."]], "ar");
    const r = await ask(undefined);
    expect(userTurn(teacher.calls[0]!)).toContain("in Arabic");
    expect(r.done.lang).toEqual({ lang: "ar", dir: "rtl", speech: "ar-SA", override: false });
  });
  it("her choice beats the kit's language", async () => {
    install([["الخلية هي أصغر وحدة للحياة."], [EXPLAIN], ["Every living thing is made of cells."]], "ar");
    const first = await ask(undefined);
    const en = await ask("explain that again in English", first.state);
    expect(en.done.lang).toMatchObject({ lang: "en", override: true });
    await ask(undefined, en.state);
    expect(userTurn(teacher.calls[2]!)).toContain("in English");
  });
  it("the narration widens the repeat's support (its numbers and names stay allowed)", () => {
    expect(NARRATION_0).toContain("bacteria");
  });
});
