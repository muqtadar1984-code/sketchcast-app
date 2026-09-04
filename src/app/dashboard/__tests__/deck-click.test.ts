/**
 * The student's deck click asks /api/deck before the row records anything.
 *
 * THE FINDING (adversarial pass 4, 2026-09-05). The row's control was an
 * anchor straight to /api/deck/{genId} with an onClick that wrote
 * "Completed". The route can refuse — 401 (session gone), 403 (unassigned
 * between render and click), 404 (no deck file), 500 (no service role), 502
 * (signing failed) — and every refusal is a JSON body. Followed by an anchor,
 * that JSON was DOWNLOADED: the student got a file called deck (or a browser
 * tab of `{"error":"This deck isn't assigned to you."}`), no message on
 * screen, and a row that already said Completed. Trying again bumped
 * revision_count, because a completed row's second open is a revision.
 *
 * The fix is this predicate plus the wiring pinned in assignable.test.ts: the
 * click probes with `redirect: "manual"`, and only an agreeing route lets the
 * row write.
 *
 * Run: npx vitest run src/app/dashboard/__tests__/deck-click.test.ts
 */

import { describe, expect, it } from "vitest";
import { deckRouteAgreed } from "../deck-click";

/** What `fetch(url, { redirect: "manual" })` hands back for a same-origin 302:
 * an opaque-redirect response — status 0, unreadable body — whose very opacity
 * is the proof that the redirect happened. */
const opaqueRedirect = { type: "opaqueredirect", status: 0 };

describe("deckRouteAgreed", () => {
  it("agrees when the route redirected — the opaque response IS the 302", () => {
    expect(deckRouteAgreed(opaqueRedirect)).toBe(true);
  });

  it("refuses every answer /api/deck gives instead of the file", () => {
    // Each of these is a real branch of the handler, and each used to arrive
    // in the student's Downloads folder as JSON while the row said Completed.
    for (const status of [401, 403, 404, 500, 502]) {
      expect(deckRouteAgreed({ type: "basic", status }), `${status}`).toBe(false);
    }
  });

  it("refuses a status-0 response that is NOT an opaque redirect", () => {
    // A network-error or opaque response says nothing about the route having
    // been reached; only "opaqueredirect" does. Reading status alone here
    // (0 < 200) would already refuse, but the type is what carries the
    // meaning, so both are pinned.
    expect(deckRouteAgreed({ type: "error", status: 0 })).toBe(false);
    expect(deckRouteAgreed({ type: "opaque", status: 0 })).toBe(false);
    expect(deckRouteAgreed({ status: 0 })).toBe(false);
  });

  it("agrees with a 2xx or an unfiltered 3xx — a route that hands the file over is agreeing too", () => {
    // The handler answers 302 today; a future one that streamed the bytes
    // itself, or a runtime that surfaced the redirect unfiltered, is not a
    // refusal and must not be read as one.
    for (const status of [200, 204, 301, 302, 307]) {
      expect(deckRouteAgreed({ type: "basic", status }), `${status}`).toBe(true);
    }
  });

  it("treats a 4xx/5xx as a refusal even if something labels it a redirect type", () => {
    expect(deckRouteAgreed({ type: "basic", status: 403 })).toBe(false);
    expect(deckRouteAgreed({ type: "cors", status: 500 })).toBe(false);
  });
});
