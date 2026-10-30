/**
 * The Ready-made kits gallery, server-rendered (react-dom/server, no DOM in
 * this suite): ~610 kits render ONE chunk of cards plus a "Show more", a
 * `?topic=` highlight past the chunk is rendered and ringed, and the cards
 * still carry what they used to — the in-app player for a translated kit,
 * piece labels, and no tour anchor (the page renders that above the gallery).
 * Run: node node_modules/vitest/vitest.mjs run src/app/dashboard/kits
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/i18n/messages/en.json";
import { fmt } from "@/i18n/format";
import type { LibraryMessages } from "../../labels";
import KitsGallery, { type KitView } from "../kits-gallery";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, prefetch: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  usePathname: () => "/dashboard/kits",
}));

const tLib = { ...en.library, common: en.common, utils: en.utils } as unknown as LibraryMessages;
const view = (i: number, over: Partial<KitView> = {}): KitView => ({
  topicId: `t${i}`,
  kitId: `k${i}`,
  slug: `topic-${i}`,
  title: `Topic ${i}`,
  subject: "Biology",
  language: "en",
  youtubeId: `yt${i}`,
  videoGenerationId: null,
  questionCount: 10,
  unlocked: false,
  pieces: [
    { kind: "presentation", generationId: `p${i}` },
    { kind: "worksheet", generationId: `w${i}` },
  ],
  ...over,
});
const render = (kits: KitView[], highlight: string | null = null) =>
  renderToStaticMarkup(
    createElement(KitsGallery, { kits, canUnlock: true, resetsLabel: "3 Nov", highlight, classes: [], childTargets: null, t: en.kits, tLib }),
  );
const cards = (html: string) => html.match(/<article /g)?.length ?? 0;

describe("KitsGallery renders in chunks", () => {
  const ALL = Array.from({ length: 610 }, (_, i) => view(i));

  it("~610 kits: 24 cards, the full count on the All chip, and a Show more for the next 24", () => {
    const html = render(ALL);
    expect(cards(html)).toBe(24);
    expect(html).toContain(`${en.kits.filterAll} · 610`);
    expect(html).toContain(fmt(en.kits.showMore, { n: 24 }));
    expect(html).toContain('data-kits-more="586"');
    expect(html).not.toContain("kits-allowance");
  });

  it("a highlighted topic past the first chunk is rendered and ringed", () => {
    const html = render(ALL, "topic-300");
    expect(cards(html)).toBe(301);
    expect(html).toMatch(/<article id="kit-topic-300"[^>]*class="[^"]*ring-2/);
  });

  it("a short gallery has no Show more", () => {
    const html = render(ALL.slice(0, 5));
    expect(cards(html)).toBe(5);
    expect(html).not.toContain("data-kits-more");
  });

  it("a translated kit (no YouTube id) still opens the in-app player, framed from storage; piece labels come from the Library's words", () => {
    const html = render([view(1, { youtubeId: null, videoGenerationId: "pres-1", language: "ms" })]);
    expect(html).toContain("/api/catalogue/file?gen=pres-1&amp;kind=thumbnail_png");
    expect(html).toMatch(/<button type="button" class="relative block w-full aspect-video/);
    expect(html).toContain(`<span class="sr-only">${(en.library.kinds as Record<string, string>).worksheet}</span>`);
  });

  it("a kit on YouTube WITH a stored lesson opens the in-app player too (stored MP4 first) — no link out to YouTube", () => {
    const html = render([view(2, { videoGenerationId: "pres-2" })]);
    expect(html).toMatch(/<button type="button" class="relative block w-full aspect-video/);
    expect(html).not.toContain("https://www.youtube.com/watch?v=yt2");
    // the card's frame is still YouTube's (no storage read per card)
    expect(html).toContain("https://i.ytimg.com/vi/yt2/mqdefault.jpg");
    // only a kit with no presentation at all links out
    expect(render([view(3)])).toContain("https://www.youtube.com/watch?v=yt3");
  });
});
