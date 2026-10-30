/**
 * The Library's in-app lesson player (lesson-player.tsx): a stored MP4 plays
 * in the <video> it always did; a YouTube link — reaching it only as the
 * FALLBACK for a lesson with no stored MP4 (founder 2026-10-30: "the quality
 * matters in the app so lets use stored mp4 wherever possible") — plays in
 * YouTube's embedded player, captions off by default (cc_load_policy=0).
 * Run: node node_modules/vitest/vitest.mjs run src/app/dashboard/__tests__/lesson-player.test.ts
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LessonPlayer } from "../lesson-player";

const render = (src: string) => renderToStaticMarkup(createElement(LessonPlayer, { src, title: "Chapter 1", closeLabel: "Close", onClose: () => {} }));

describe("LessonPlayer", () => {
  it("a stored MP4 plays in the <video>, no YouTube anywhere", () => {
    const html = render("https://x.supabase.co/storage/v1/object/sign/artifacts/u/lesson.mp4?token=t");
    expect(html).toMatch(/<video[^>]*src="https:\/\/x\.supabase\.co\/storage\/v1\/object\/sign\/artifacts\/u\/lesson\.mp4\?token=t"/);
    expect(html).not.toContain("<iframe");
  });

  it("the YouTube fallback plays in the embedded player with captions off by default", () => {
    const html = render("https://www.youtube.com/watch?v=AAAAAAAAAA1");
    expect(html).not.toContain("<video");
    expect(html).toMatch(/<iframe[^>]*src="https:\/\/www\.youtube\.com\/embed\/AAAAAAAAAA1\?cc_load_policy=0&amp;[^"]*"/);
    expect(html).toContain('title="Chapter 1"');
  });
});
