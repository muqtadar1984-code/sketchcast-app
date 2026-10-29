// Getting the deck's rendered pages to the Board: ask, ask the worker if they
// are not there, wait. PURE — the fetch, the clock and the sleep are injected —
// so the rail button and SK's `load_deck` share one tested path
// (/api/present/deck-pages is the other side).
//
// The render is ~30 s on the worker (LibreOffice → PDF → PNG). Polled every
// 3 s for at most 3 minutes; after that she is told it failed rather than left
// watching "Preparing…" for ever. A deck asked for once and still `missing` on
// the next look is a worker that refused it — nothing to wait for.

import type { DeckPageBackground } from "@/board/model";
import type { DeckPagesReply, DeckSlideRef } from "@/utils/present/deck-pages";

export type { DeckPagesReply, DeckSlideRef };

export type DeckFetch = (generationId: string, method: "GET" | "POST") => Promise<DeckPagesReply>;
export type DeckStatus = "none" | "missing" | "building" | "ready" | "loaded" | "failed";

export const DECK_POLL_MS = 3000;
export const DECK_MAX_MS = 180_000;

export type PrepareDeckResult =
  | { status: "ready"; slides: DeckSlideRef[]; map: string | null; mapUrl: string | null }
  | { status: "failed"; reason: "missing" | "timeout" | "aborted" | "error" };

export async function prepareDeck(
  fetchReply: DeckFetch,
  generationId: string,
  opts: { pollMs?: number; maxMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; onStatus?: (s: DeckStatus) => void; signal?: AbortSignal } = {},
): Promise<PrepareDeckResult> {
  const pollMs = opts.pollMs ?? DECK_POLL_MS;
  const maxMs = opts.maxMs ?? DECK_MAX_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const t0 = now();
  let asked = false;
  let method: "GET" | "POST" = "GET";
  for (;;) {
    if (opts.signal?.aborted) return { status: "failed", reason: "aborted" };
    let reply: DeckPagesReply;
    try {
      reply = await fetchReply(generationId, method);
    } catch {
      opts.onStatus?.("failed");
      return { status: "failed", reason: "error" };
    }
    method = "GET";
    if (reply.status === "ready") {
      if (!reply.slides.length) {
        opts.onStatus?.("failed");
        return { status: "failed", reason: "missing" };
      }
      opts.onStatus?.("ready");
      return { status: "ready", slides: reply.slides, map: reply.map, mapUrl: reply.mapUrl };
    }
    if (reply.status === "missing") {
      if (asked) {
        opts.onStatus?.("failed");
        return { status: "failed", reason: "missing" };
      }
      asked = true;
      method = "POST";
      // Ask straight away: no point sleeping before the request that starts the work.
      opts.onStatus?.("building");
      continue;
    }
    opts.onStatus?.("building");
    if (now() - t0 >= maxMs) {
      opts.onStatus?.("failed");
      return { status: "failed", reason: "timeout" };
    }
    await sleep(pollMs);
  }
}

/** One slide as the page background the roll keeps: the STORAGE PATH (the
 *  host re-signs it on load), the slide's number, size and title, and the
 *  deck's text map by path. */
export function deckPageOf(generationId: string, s: Pick<DeckSlideRef, "n" | "path" | "w" | "h" | "title">, map: string | null): DeckPageBackground {
  return {
    kind: "deckPage",
    generationId,
    n: s.n,
    src: s.path,
    w: s.w,
    h: s.h,
    ...(s.title ? { title: s.title } : {}),
    ...(map ? { map } : {}),
  };
}
