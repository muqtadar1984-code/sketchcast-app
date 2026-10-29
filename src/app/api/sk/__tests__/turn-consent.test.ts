// SK S6 slice A — POST /api/sk/turn keeps the tutor's words only with
// `transcripts` consent (Final Plan §8.1, §9.5): with consent the history and
// the full stored replay are kept; without it the session's history stays
// empty and the replay guard stores the turn WITHOUT its words.
// Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/__tests__/turn-consent.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));

import { POST as openSession } from "@/app/api/sk/session/route";
import { POST as command } from "@/app/api/sk/command/route";
import { POST as turn } from "@/app/api/sk/turn/route";
import { __setSkDepsForTests } from "@/sk/server";
import { InMemorySessionStore } from "@/sk/store";
import { StaticItemBank } from "@/sk/items";
import { StubProvider } from "@/utils/assistant/providers/stub";
import { graph, U4_HITMAP_TARGETS, U4_SEGMENT } from "@/sk/__tests__/fixtures";

const STU = "22222222-2222-4222-8222-222222222222";
const req = (body: unknown) => new Request("http://x/api/sk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
let n = 0;
const eid = () => `0192f5c0-0000-7000-8000-${String(++n).padStart(12, "0")}`;
const events = async (res: Response) =>
  (await res.text())
    .split("\n\n")
    .filter(Boolean)
    .map((c) => /^event: (.*)$/m.exec(c)![1]!);

let store: InMemorySessionStore;
function install(consent: boolean) {
  store = new InMemorySessionStore();
  __setSkDepsForTests({
    store,
    items: new StaticItemBank(),
    graphs: [graph()],
    loadSegment: async () => U4_SEGMENT,
    loadHitmapElementIds: async () => U4_HITMAP_TARGETS,
    routerProvider: undefined,
    teacherProvider: new StubProvider([{ text: ["The eyepiece is the top lens."] }]),
    keepHistory: async () => consent,
  });
}

async function askOnce() {
  const { sessionId } = (await (await openSession(req({ eventId: eid(), productId: "test-product", chapter: 2 }))).json()) as { sessionId: string };
  await command(req({ eventId: eid(), sessionId, command: "continue" }));
  const e = eid();
  const first = await events(await turn(req({ eventId: e, sessionId, utterance: { text: "which lens is the eyepiece?" }, cursor: { unitKey: "u2", assetId: "u2-main", t: 20_000 } })));
  const replay = await events(await turn(req({ eventId: e, sessionId, utterance: { text: "which lens is the eyepiece?" } })));
  const stored = (await store.listEvents(sessionId)).find((x) => x.kind === "turn")!;
  return { sessionId, first, replay, stored };
}

beforeEach(() => {
  process.env.FEATURE_SK = "true";
  mocks.createClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: { id: STU } } }) } });
});
afterEach(() => {
  __setSkDepsForTests(null);
  delete process.env.FEATURE_SK;
  vi.clearAllMocks();
});

describe("POST /api/sk/turn and transcripts consent", () => {
  it("with consent: history kept, the stored replay keeps the words", async () => {
    install(true);
    const { sessionId, first, replay, stored } = await askOnce();
    expect(first).toContain("text");
    expect(replay).toContain("text");
    expect((stored.result as { event: string }[]).some((e) => e.event === "text")).toBe(true);
    expect((await store.getSession(sessionId))!.history).toHaveLength(2);
  });
  it("without consent: the student still gets the answer, but no history and no words are kept", async () => {
    install(false);
    const { sessionId, first, replay, stored } = await askOnce();
    expect(first).toContain("text"); // the tutor still works this turn
    expect(replay).not.toContain("text");
    expect(replay).toContain("done");
    expect((stored.result as { event: string }[]).map((e) => e.event)).not.toContain("text");
    expect((await store.getSession(sessionId))!.history).toEqual([]);
  });
});
