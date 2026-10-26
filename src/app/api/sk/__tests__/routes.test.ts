/**
 * The /api/sk route handlers: the FEATURE_SK gate (404, nothing else runs),
 * the signed-out branch (401), eventId validation, the idempotent envelope on
 * every mutating route (a repeated eventId returns the stored result and
 * performs no side effect), the SSE framing + replay of the turn route, and
 * the owner check on GET /session/:id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));

import { POST as openSession } from "@/app/api/sk/session/route";
import { GET as getSession } from "@/app/api/sk/session/[id]/route";
import { POST as command } from "@/app/api/sk/command/route";
import { POST as answer } from "@/app/api/sk/answer/route";
import { POST as turn } from "@/app/api/sk/turn/route";
import { __setSkDepsForTests } from "@/sk/server";
import { InMemorySessionStore } from "@/sk/store";
import { StaticItemBank } from "@/sk/items";
import { graph, U4_HITMAP_TARGETS, U4_SEGMENT } from "@/sk/__tests__/fixtures";

const STU = "22222222-2222-4222-8222-222222222222";
const signedIn = (id: string | null) => mocks.createClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: id ? { id } : null } }) } });
const req = (body: unknown) => new Request("http://x/api/sk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
let n = 0;
const eid = () => `0192f5c0-0000-7000-8000-${String(++n).padStart(12, "0")}`;

async function sse(res: Response): Promise<{ event: string; data: unknown }[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const event = /^event: (.*)$/m.exec(chunk)![1]!;
      const data = chunk.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      return { event, data: JSON.parse(data) };
    });
}

beforeEach(() => {
  process.env.FEATURE_SK = "true";
  __setSkDepsForTests({ store: new InMemorySessionStore(), items: new StaticItemBank(), graphs: [graph()], loadSegment: async () => U4_SEGMENT, loadHitmapElementIds: async () => U4_HITMAP_TARGETS, routerProvider: undefined, teacherProvider: undefined });
  signedIn(STU);
});
afterEach(() => {
  __setSkDepsForTests(null);
  delete process.env.FEATURE_SK;
  vi.clearAllMocks();
});

async function open(): Promise<{ sessionId: string; state: string }> {
  const res = await openSession(req({ eventId: eid(), productId: "test-product", chapter: 2 }));
  expect(res.status).toBe(200);
  return (await res.json()) as { sessionId: string; state: string };
}

describe("gate and auth", () => {
  it("404 when FEATURE_SK is off — before auth is even consulted", async () => {
    delete process.env.FEATURE_SK;
    const res = await openSession(req({ eventId: eid(), productId: "test-product", chapter: 2 }));
    expect(res.status).toBe(404);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("401 when signed out, on every route", async () => {
    signedIn(null);
    expect((await openSession(req({ eventId: eid(), productId: "test-product", chapter: 2 }))).status).toBe(401);
    expect((await command(req({ eventId: eid(), sessionId: "x", command: "continue" }))).status).toBe(401);
    expect((await answer(req({ eventId: eid(), sessionId: "x", itemId: "i", attemptNo: 1, response: "a" }))).status).toBe(401);
    expect((await turn(req({ eventId: eid(), sessionId: "x", utterance: { text: "hi" } }))).status).toBe(401);
    expect((await getSession(new Request("http://x"), { params: Promise.resolve({ id: "x" }) })).status).toBe(401);
  });
  it("400 on a missing or malformed eventId", async () => {
    expect((await openSession(req({ productId: "test-product", chapter: 2 }))).status).toBe(400);
    expect((await command(req({ eventId: "nope", sessionId: "x", command: "continue" }))).status).toBe(400);
  });
});

describe("session", () => {
  it("opens, is idempotent on eventId, resumes, and rehydrates for its owner only", async () => {
    const e = eid();
    const a = (await (await openSession(req({ eventId: e, productId: "test-product", chapter: 2 }))).json()) as { sessionId: string; state: string; cursor: { unitKey: string } };
    const b = (await (await openSession(req({ eventId: e, productId: "test-product", chapter: 2 }))).json()) as { sessionId: string };
    expect(a.state).toBe("PAUSED");
    expect(a.cursor.unitKey).toBe("u2");
    expect(b.sessionId).toBe(a.sessionId);
    const resumed = (await (await openSession(req({ eventId: eid(), productId: "test-product", chapter: 2, resume: true }))).json()) as { sessionId: string };
    expect(resumed.sessionId).toBe(a.sessionId);
    const got = await getSession(new Request("http://x"), { params: Promise.resolve({ id: a.sessionId }) });
    expect(got.status).toBe(200);
    expect(((await got.json()) as { sessionId: string }).sessionId).toBe(a.sessionId);
    signedIn("33333333-3333-4333-8333-333333333333");
    expect((await getSession(new Request("http://x"), { params: Promise.resolve({ id: a.sessionId }) })).status).toBe(404);
  });
  it("404 for a product with no graph", async () => {
    expect((await openSession(req({ eventId: eid(), productId: "nothing", chapter: 2 }))).status).toBe(404);
  });
});

describe("command", () => {
  it("applies a command once per eventId and refuses unknown commands and other students' sessions", async () => {
    const { sessionId } = await open();
    const e = eid();
    const r1 = (await (await command(req({ eventId: e, sessionId, command: "slower" }))).json()) as { rate: number; speech: string };
    const r2 = (await (await command(req({ eventId: e, sessionId, command: "slower" }))).json()) as { rate: number };
    expect(r1.rate).toBeCloseTo(0.85, 5);
    expect(r1.speech).toBe("I'll slow down a little.");
    expect(r2.rate).toBeCloseTo(0.85, 5); // replayed, not applied twice
    const r3 = (await (await command(req({ eventId: eid(), sessionId, command: "slower" }))).json()) as { rate: number };
    expect(r3.rate).toBeCloseTo(0.7, 5);
    expect((await command(req({ eventId: eid(), sessionId, command: "dance" }))).status).toBe(400);
    signedIn("33333333-3333-4333-8333-333333333333");
    expect((await command(req({ eventId: eid(), sessionId, command: "continue" }))).status).toBe(404);
  });
  it("route commands carry validated args only", async () => {
    const { sessionId } = await open();
    const r = (await (await command(req({ eventId: eid(), sessionId, command: "goto", args: { unitKey: "u5", evil: "<script>" } }))).json()) as { cursor: { unitKey: string }; bookmarks: unknown[] };
    expect(r.cursor.unitKey).toBe("u5");
    expect(r.bookmarks).toHaveLength(1);
    const bad = (await (await command(req({ eventId: eid(), sessionId, command: "goto", args: { unitKey: "../../etc" } }))).json()) as { speech: string };
    expect(bad.speech).toBe("Which unit do you mean?");
  });
});

describe("answer", () => {
  it("grades once per (itemId, attemptNo) and once per eventId; 409 when no question is open", async () => {
    const { sessionId } = await open();
    expect((await answer(req({ eventId: eid(), sessionId, itemId: "ch2-u4-c1", attemptNo: 1, response: "b" }))).status).toBe(409);
    await command(req({ eventId: eid(), sessionId, command: "practise", args: { n: 0 } }));
    const e = eid();
    const a = (await (await answer(req({ eventId: e, sessionId, itemId: "ch2-u4-c1", attemptNo: 1, response: "b", modality: "typed" }))).json()) as { outcome: string; replayed: boolean };
    const again = (await (await answer(req({ eventId: e, sessionId, itemId: "ch2-u4-c1", attemptNo: 1, response: "a", modality: "typed" }))).json()) as { outcome: string };
    expect(a).toMatchObject({ outcome: "correct", replayed: false });
    expect(again.outcome).toBe("correct"); // the stored result, not a re-grade of "a"
    const dup = (await (await answer(req({ eventId: eid(), sessionId, itemId: "ch2-u4-c1", attemptNo: 1, response: "a", modality: "typed" }))).json()) as { replayed: boolean; outcome: string };
    expect(dup).toMatchObject({ replayed: true, outcome: "correct" });
    expect((await answer(req({ eventId: eid(), sessionId, itemId: "ch2-u4-c1", attemptNo: 0, response: "a" }))).status).toBe(400);
    expect((await answer(req({ eventId: eid(), sessionId, itemId: "ch2-u4-c2", attemptNo: 1 }))).status).toBe(400); // no response
  });
});

describe("turn (SSE)", () => {
  it("streams meta → text → done, and a repeated eventId replays the stored events without running again", async () => {
    const { sessionId } = await open();
    const e = eid();
    const res = await turn(req({ eventId: e, sessionId, utterance: { text: "slower", modality: "typed" }, cursor: { unitKey: "u2", assetId: "u2-main", t: 1000 } }));
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const evs = await sse(res);
    expect(evs.map((x) => x.event)).toEqual(["meta", "text", "done"]);
    expect(evs[1]!.data).toBe("I'll slow down a little.");
    const view1 = (evs[2]!.data as { view: { rate: number } }).view;
    expect(view1.rate).toBeCloseTo(0.85, 5);
    const replay = await sse(await turn(req({ eventId: e, sessionId, utterance: { text: "slower", modality: "typed" } })));
    expect(replay.map((x) => x.event)).toEqual(["meta", "text", "done"]);
    expect((replay[2]!.data as { replayed: boolean; view: { rate: number } }).replayed).toBe(true);
    expect((replay[2]!.data as { view: { rate: number } }).view.rate).toBeCloseTo(0.85, 5); // not 0.7: nothing ran twice
    const fresh = await sse(await turn(req({ eventId: eid(), sessionId, utterance: { text: "slower", modality: "typed" } })));
    expect((fresh[2]!.data as { view: { rate: number } }).view.rate).toBeCloseTo(0.7, 5);
  });
  it("404 for another student's session; 400 without an utterance", async () => {
    const { sessionId } = await open();
    expect((await turn(req({ eventId: eid(), sessionId }))).status).toBe(400);
    signedIn("33333333-3333-4333-8333-333333333333");
    expect((await turn(req({ eventId: eid(), sessionId, utterance: { text: "hi" } }))).status).toBe(404);
  });
});
