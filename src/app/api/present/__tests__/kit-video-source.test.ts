/**
 * GET /api/present/kit — which video the Board plays (founder 2026-10-30:
 * "the quality matters in the app so lets use stored mp4 wherever possible").
 * A catalogue copy's lesson answers its SIGNED STORAGE MP4 even when its kit
 * is on YouTube (no `youtube` field, so the stage plays the file and its
 * frames can be captured); only a copy with no stored MP4 to sign answers
 * its kit's YouTube ids, the fallback. An uploaded book's lesson never has a
 * fallback.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/present/__tests__/kit-video-source.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const mocks = vi.hoisted(() => ({
  rows: [] as Row[],
  publications: [] as Row[],
  pubReads: 0,
  pubKitIds: [] as unknown[][],
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
function query(rows: Row[]) {
  const b: any = {};
  const keep: Array<(r: Row) => boolean> = [];
  b.select = () => b;
  b.eq = (col: string, v: unknown) => {
    keep.push((r) => r[col] === v);
    return b;
  };
  b.is = (col: string, v: unknown) => {
    keep.push((r) => (r[col] ?? null) === v);
    return b;
  };
  b.in = (col: string, vs: unknown[]) => {
    mocks.pubKitIds.push(vs);
    keep.push((r) => vs.includes(r[col]));
    return b;
  };
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve({ data: rows.filter((r) => keep.every((f) => f(r))), error: null }).then(res, rej);
  return b;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "teacher-1" } } }) },
    from: () => query(mocks.rows),
  }),
}));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== "topic_publications") throw new Error(`unexpected table ${table}`);
      mocks.pubReads++;
      return query(mocks.publications);
    },
    storage: {
      from: () => ({
        // a path whose object is gone signs nothing
        createSignedUrl: async (path: string) =>
          path.includes("missing") ? { data: null, error: { message: "Object not found" } } : { data: { signedUrl: `https://signed/${path}` } },
      }),
    },
  }),
}));
vi.mock("@/utils/present/entitlement", () => ({ presentEntitled: async () => ({ ok: true }) }));

import { GET } from "@/app/api/present/kit/route";
import { framesCapturable } from "@/app/present/board-session";
import { stageSource } from "@/app/present/youtube-video";

const KIT = "8c73897d-d9e3-47c8-a699-03662d84da3e";
const TOPIC_KIT = "11111111-2222-4333-8444-555555555555";
const base = { owner_id: "teacher-1", status: "done", withdrawn_at: null, book_id: null, chapter_ref: null };
const P = "Plant and Animal Cells Compared";

type Video = { id: string; urls: string[]; youtube?: string[] };
type Reply = { units: { video: Video | null }[] };

const lesson = (paths: string[], params: Record<string, unknown> = { catalogue_ref: { topic_kit_id: TOPIC_KIT } }) => [
  { ...base, id: KIT, kind: "presentation", title: `${P} · ${P}`, params, artifacts: paths.map((storage_path) => ({ kind: "video_mp4", storage_path })) },
];

async function video(): Promise<Video | null> {
  const res = await GET(new Request(`http://x/api/present/kit?kit=${KIT}`));
  expect(res.status).toBe(200);
  return ((await res.json()) as Reply).units[0].video;
}

beforeEach(() => {
  mocks.pubReads = 0;
  mocks.pubKitIds = [];
  mocks.publications = [
    { topic_kit_id: TOPIC_KIT, part: 1, youtube_video_id: "AAAAAAAAAA1", privacy: "public", superseded_by: null, channel_language: "en" },
    { topic_kit_id: TOPIC_KIT, part: 2, youtube_video_id: "AAAAAAAAAA2", privacy: "public", superseded_by: null, channel_language: "en" },
  ];
});

describe("the Board's lesson video: stored MP4 first", () => {
  it("a catalogue copy on YouTube WITH a stored MP4 → the signed MP4s in part order, no YouTube, no publications read", async () => {
    mocks.rows = lesson(["sys/k/lesson_part2.mp4", "sys/k/lesson.mp4"]);
    const v = await video();
    expect(v).toMatchObject({ id: KIT, urls: ["https://signed/sys/k/lesson.mp4", "https://signed/sys/k/lesson_part2.mp4"] });
    expect(v?.youtube).toBeUndefined();
    expect(mocks.pubReads).toBe(0);
    // the stage plays the file, and freeze-frame / the slide stills work on it
    expect(stageSource(v!.urls[0], v!.youtube?.[0])).toBe("file");
    expect(framesCapturable(v)).toBe(true);
  });

  it("a catalogue copy with NO stored MP4 to sign → its kit's YouTube ids, the fallback", async () => {
    mocks.rows = lesson(["sys/k/missing/lesson.mp4"]);
    const v = await video();
    expect(v).toMatchObject({ id: KIT, urls: [], youtube: ["AAAAAAAAAA1", "AAAAAAAAAA2"] });
    expect(mocks.pubKitIds).toEqual([[TOPIC_KIT]]);
    expect(stageSource(v!.urls[0], v!.youtube?.[0])).toBe("youtube");
    expect(framesCapturable(v)).toBe(false);
  });

  it("a SketchCast book's copy (product_ref) falls back the same way", async () => {
    mocks.rows = lesson(["sys/k/missing/lesson.mp4"], { product_ref: { topic_kit_id: TOPIC_KIT } });
    expect((await video())?.youtube).toEqual(["AAAAAAAAAA1", "AAAAAAAAAA2"]);
  });

  it("an uploaded book's lesson (no lineage) has no fallback: its MP4, or nothing", async () => {
    mocks.rows = lesson(["u/k/lesson.mp4"], {});
    expect(await video()).toMatchObject({ urls: ["https://signed/u/k/lesson.mp4"] });
    mocks.rows = lesson(["u/k/missing/lesson.mp4"], {});
    const v = await video();
    expect(v).toMatchObject({ urls: [] });
    expect(v?.youtube).toBeUndefined();
    expect(mocks.pubReads).toBe(0);
  });
});
