import { describe, expect, it } from "vitest";
import { batchSigner, type SignedUrlsClient } from "../storage/batch-sign";

type Call = { bucket: string; paths: string[]; expiresIn: number; download?: string | boolean };

/** A fake storage client: signs every path it "can read", refuses the rest per
 * item (as the real batch endpoint does), and records each request. */
function fakeClient(opts: { readable?: (p: string) => boolean; fail?: boolean; dropEcho?: boolean } = {}) {
  const calls: Call[] = [];
  const client: SignedUrlsClient = {
    storage: {
      from(bucket) {
        return {
          async createSignedUrls(paths, expiresIn, options) {
            calls.push({ bucket, paths, expiresIn, download: options?.download });
            if (opts.fail) throw new Error("network");
            return {
              data: paths.map((p) =>
                (opts.readable ?? (() => true))(p)
                  ? { error: null, path: opts.dropEcho ? null : p, signedUrl: `https://s/${p}${options?.download ? `?dl=${options.download}` : ""}` }
                  : { error: "Either the object does not exist or you do not have access to it", path: p, signedUrl: null },
              ),
              error: null,
            };
          },
        };
      },
    },
  };
  return { client, calls };
}

describe("batchSigner", () => {
  it("coalesces every call made in one tick into ONE request per download name", async () => {
    const { client, calls } = fakeClient();
    const sign = batchSigner(client, "artifacts", 3600);
    const urls = await Promise.all([
      sign("a/lesson.mp4"),
      sign("a/deck.pptx"),
      sign("a/doc.docx", "Worksheet.docx"),
      sign("b/doc.docx", "Worksheet.docx"),
      sign("c/paper.docx", "Test Paper.docx"),
    ]);
    expect(urls).toEqual([
      "https://s/a/lesson.mp4",
      "https://s/a/deck.pptx",
      "https://s/a/doc.docx?dl=Worksheet.docx",
      "https://s/b/doc.docx?dl=Worksheet.docx",
      "https://s/c/paper.docx?dl=Test Paper.docx",
    ]);
    expect(calls).toHaveLength(3);
    expect(calls.find((c) => c.download === undefined)?.paths).toEqual(["a/lesson.mp4", "a/deck.pptx"]);
    expect(calls.every((c) => c.bucket === "artifacts" && c.expiresIn === 3600)).toBe(true);
  });

  it("passes NO download option for an undisposed URL — a video must stay playable in-tab", async () => {
    const { client, calls } = fakeClient();
    const sign = batchSigner(client, "artifacts", 3600);
    await sign("v.mp4");
    await sign("w.mp4", "");
    expect(calls.map((c) => c.download)).toEqual([undefined, undefined]);
  });

  it("de-duplicates a path asked for twice, and answers both callers", async () => {
    const { client, calls } = fakeClient();
    const sign = batchSigner(client, "artifacts", 60);
    const [x, y] = await Promise.all([sign("same.mp4"), sign("same.mp4")]);
    expect(x).toBe("https://s/same.mp4");
    expect(y).toBe(x);
    expect(calls[0].paths).toEqual(["same.mp4"]);
  });

  it("a path the client may not read is null — the same answer the single call gave — and the rest still sign", async () => {
    const { client } = fakeClient({ readable: (p) => !p.startsWith("other-teacher/") });
    const sign = batchSigner(client, "artifacts", 3600);
    const [mine, theirs] = await Promise.all([sign("me/lesson.mp4"), sign("other-teacher/lesson.mp4")]);
    expect(mine).toBe("https://s/me/lesson.mp4");
    expect(theirs).toBeNull();
  });

  it("never rejects: a failed request resolves every waiter to null", async () => {
    const { client } = fakeClient({ fail: true });
    const sign = batchSigner(client, "artifacts", 3600);
    await expect(Promise.all([sign("a"), sign("b", "x.docx")])).resolves.toEqual([null, null]);
  });

  it("chunks a large batch so no single request carries more than `max` paths", async () => {
    const { client, calls } = fakeClient();
    const sign = batchSigner(client, "artifacts", 3600, { max: 2 });
    const urls = await Promise.all(["p1", "p2", "p3", "p4", "p5"].map((p) => sign(p)));
    expect(urls).toEqual(["p1", "p2", "p3", "p4", "p5"].map((p) => `https://s/${p}`));
    expect(calls.map((c) => c.paths)).toEqual([["p1", "p2"], ["p3", "p4"], ["p5"]]);
  });

  it("falls back to request order when the API does not echo the path", async () => {
    const { client } = fakeClient({ dropEcho: true });
    const sign = batchSigner(client, "artifacts", 3600);
    expect(await Promise.all([sign("one"), sign("two")])).toEqual(["https://s/one", "https://s/two"]);
  });

  it("calls in a later tick go in a new request — nothing waits on a batch that already left", async () => {
    const { client, calls } = fakeClient();
    const sign = batchSigner(client, "artifacts", 3600);
    await sign("first");
    await sign("second");
    expect(calls.map((c) => c.paths)).toEqual([["first"], ["second"]]);
  });
});
