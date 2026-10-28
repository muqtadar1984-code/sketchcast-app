import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// The SK M2 harness must not exist outside `next dev`. vitest runs with
// NODE_ENV=test, which is exactly "not development".

vi.mock("@/i18n/dictionaries", () => ({ getDictionary: async () => ({ present: {} }) }));
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dev harness outside development", () => {
  for (const env of ["production", "test"]) {
    it(`${env}: video and questions routes answer 404, even with paths configured`, async () => {
      vi.stubEnv("NODE_ENV", env);
      vi.stubEnv("SK_M2_VIDEO_PATH", "C:\\x\\lesson.mp4");
      vi.stubEnv("SK_M2_QUESTIONS_PATH", "C:\\x\\q.json");
      const video = await import("../video/route");
      const questions = await import("../questions/route");
      expect((await video.GET(new Request("http://x/dev/sk-board/video"))).status).toBe(404);
      expect((await questions.GET()).status).toBe(404);
    });

    it(`${env}: the page calls notFound()`, async () => {
      vi.stubEnv("NODE_ENV", env);
      const page = await import("../page");
      await expect(page.default()).rejects.toThrow("NEXT_NOT_FOUND");
    });
  }

  it("nothing outside src/app/dev/sk-board names the harness's local inputs", () => {
    const root = path.resolve(__dirname, "../../../..");
    const hits: string[] = [];
    // Synchronous walk: the async version awaited every file and timed out
    // at 30 s under a full-suite run (seen twice on 2026-10-28).
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (p.includes(path.join("app", "dev", "sk-board"))) continue;
          walk(p);
        } else if (/\.(ts|tsx)$/.test(e.name)) {
          const src = readFileSync(p, "utf8");
          if (/SK_M2_|\/dev\/sk-board/.test(src)) hits.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  }, 30_000);
});
