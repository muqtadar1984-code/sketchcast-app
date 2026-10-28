import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import en from "@/i18n/messages/en.json";

// THE BOARD WITHOUT SK IS THE BOARD ON MAIN. These pin the two things the SK
// spike could have changed for a teacher who never meets SK: what renders, and
// what goes over the network.

const storage = {
  createSignedUrl: vi.fn(async () => ({ data: { signedUrl: "https://signed/x" } })),
  upload: vi.fn(async () => ({ error: null })),
};
const from = vi.fn(() => storage);
vi.mock("@/utils/supabase/client", () => ({ createClient: () => ({ storage: { from } }) }));

const { default: BoardSession, defaultIO } = await import("../board-session");

const session = {
  id: "11111111-1111-4111-8111-111111111111",
  teacherId: "22222222-2222-4222-8222-222222222222",
  bookId: "33333333-3333-4333-8333-333333333333",
  chapterNum: 4,
};
const kit = {
  units: [
    {
      part: 2,
      total: 3,
      video: { id: "gen-video", title: "V", urls: ["https://signed/lesson.mp4"] },
      docs: [{ id: "gen-ws", kind: "worksheet", projects: true, title: "W", download: null, questions: "https://signed/q.json" }],
    },
  ],
  picker: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("BoardSession with no SK props", () => {
  it("renders the original controls and nothing SK adds, with no network call", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const html = renderToString(
      createElement(BoardSession, { session, kit, t: en.present, onEnd: () => {} }),
    );
    for (const label of [
      en.present.doc.presentation,
      en.present.doc.worksheet,
      en.present.board.blank,
      en.present.board.pen,
      en.present.board.undo,
      en.present.board.exportPdf,
      en.present.board.endLesson,
      en.present.board.push,
    ]) {
      expect(html).toContain(label);
    }
    for (const sk of [
      en.present.board.moving,
      en.present.board.showAnswer,
      en.present.board.nextQuestion,
      en.present.board.prevQuestion,
    ]) {
      expect(html).not.toContain(sk);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("defaultIO — the real page's network, unchanged from main", () => {
  const db = { storage: { from } } as unknown as Parameters<typeof defaultIO>[0];

  it("each call hits exactly the original endpoint with the original body", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method ?? "GET", body: JSON.parse(String(init.body)) });
        return new Response("{}", { status: 200 });
      }),
    );
    const io = defaultIO(db, session.id);
    await io.sync([{ kind: "page", seq: 0, index: 1, background: { kind: "blank" } }]);
    await io.items([{ kind: "video", generationId: "gen-video", detail: { bookId: session.bookId, chapterNum: 4, part: 2 } }]);
    await io.recordRoll();
    expect(await io.close(3)).toBe(true);
    expect(calls).toEqual([
      { url: "/api/present/sync", method: "POST", body: { sessionId: session.id, records: [{ kind: "page", seq: 0, index: 1, background: { kind: "blank" } }] } },
      { url: "/api/present/items", method: "POST", body: { sessionId: session.id, items: [{ kind: "video", generationId: "gen-video", detail: { bookId: session.bookId, chapterNum: 4, part: 2 } }] } },
      { url: "/api/present/roll", method: "POST", body: { sessionId: session.id } },
      { url: "/api/present/session", method: "PATCH", body: { sessionId: session.id, pageCount: 3 } },
    ]);
  });

  it("storage goes to the artifacts bucket, signed for eight hours, upserted", async () => {
    const io = defaultIO(db, session.id);
    expect(await io.signFrame("a/b.jpg")).toBe("https://signed/x");
    await io.upload("a/b.jpg", new Blob(["x"]), "image/jpeg");
    expect(from).toHaveBeenCalledWith("artifacts");
    expect(storage.createSignedUrl).toHaveBeenCalledWith("a/b.jpg", 8 * 60 * 60);
    expect(storage.upload).toHaveBeenCalledWith("a/b.jpg", expect.any(Blob), { contentType: "image/jpeg", upsert: true });
  });

  it("failures surface as before: sync throws on !ok, close resolves false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const io = defaultIO(db, session.id);
    await expect(io.sync([])).rejects.toThrow(/sync 500/);
    await expect(io.recordRoll()).rejects.toThrow(/recording failed \(500\)/);
    expect(await io.close(1)).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await io.close(1)).toBe(false);
  });
});
