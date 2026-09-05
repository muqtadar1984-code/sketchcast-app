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
 * THE SECOND FINDING (adversarial pass 5, 2026-09-05). The fix made the probe
 * the doorman: `if (!deckRouteAgreed(res)) return;` plus a catch that showed
 * the load-failure line. That is fail-CLOSED on the navigation — a thrown
 * fetch, or any browser where `redirect: "manual"` does not filter the way
 * this code assumed, withheld a deck the student was perfectly entitled to,
 * with a message blaming a load that never failed. So the decision is now TWO
 * gates that fail in opposite directions, and this file pins both:
 *
 *   deckRouteRefused — the NAVIGATION gate, fail-OPEN. Only a readable
 *   4xx/5xx stops the student.
 *   deckRouteAgreed  — the RECORDING gate, fail-CLOSED. Only a proven
 *   success writes progress.
 *
 * The wiring (which gate guards which side, and a thrown fetch reaching
 * neither) is pinned in assignable.test.ts.
 *
 * Run: npx vitest run src/app/dashboard/__tests__/deck-click.test.ts
 */

import { describe, expect, it } from "vitest";
import { deckRouteAgreed, deckRouteRefused, type DeckProbe } from "../deck-click";

/** What `fetch(url, { redirect: "manual" })` hands back for a same-origin 302:
 * an opaque-redirect response — status 0, unreadable body — whose very opacity
 * is the proof that the redirect happened. */
const opaqueRedirect = { type: "opaqueredirect", status: 0 };

/** Every refusal branch of the handler, as the browser reads it. */
const refusals = [401, 403, 404, 500, 502];

describe("deckRouteAgreed — the recording gate", () => {
  it("agrees when the route redirected — the opaque response IS the 302", () => {
    expect(deckRouteAgreed(opaqueRedirect)).toBe(true);
  });

  it("refuses every answer /api/deck gives instead of the file", () => {
    // Each of these is a real branch of the handler, and each used to arrive
    // in the student's Downloads folder as JSON while the row said Completed.
    for (const status of refusals) {
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

describe("deckRouteRefused — the navigation gate", () => {
  it("stops the student only on an answer the browser actually READ", () => {
    for (const status of refusals) {
      expect(deckRouteRefused({ type: "basic", status }), `${status}`).toBe(true);
    }
  });

  it("does NOT stop a student on an opaque redirect — that is the file arriving", () => {
    expect(deckRouteRefused(opaqueRedirect)).toBe(false);
  });

  it("does NOT stop a student on a response shape this code cannot place", () => {
    // THE PASS-5 FINDING, at its root. `redirect: "manual"` is specified to
    // produce an opaque-redirect response, but a browser, a service worker or
    // a proxy that produced something else would have made the old predicate
    // answer "not agreed" — and the old click read that as a refusal and
    // withheld the deck. None of these says the route said no, so none of
    // them keeps the student out; the route is asked for real by the
    // navigation that follows.
    expect(deckRouteRefused({ type: "opaque", status: 0 })).toBe(false);
    expect(deckRouteRefused({ type: "error", status: 0 })).toBe(false);
    expect(deckRouteRefused({ status: 0 })).toBe(false);
    expect(deckRouteRefused({ type: "cors", status: 0 })).toBe(false);
  });

  it("lets a success through, obviously", () => {
    for (const status of [200, 204, 301, 302, 307, 399]) {
      expect(deckRouteRefused({ type: "basic", status }), `${status}`).toBe(false);
    }
  });
});

describe("the two gates are not each other's negation", () => {
  it("leaves a deliberate middle: navigate, record nothing", () => {
    // This gap is the whole fix. Neither gate claims an unreadable probe, so
    // the click walks the student to the route (fail-open) while the badge
    // stays where it was (fail-closed). If someone ever collapses these back
    // into one predicate, this is the assertion that goes red.
    const unreadable: DeckProbe[] = [
      { type: "opaque", status: 0 },
      { type: "error", status: 0 },
      { status: 0 },
    ];
    for (const res of unreadable) {
      expect(deckRouteAgreed(res), `agreed ${res.type}`).toBe(false);
      expect(deckRouteRefused(res), `refused ${res.type}`).toBe(false);
    }
  });

  it("never says both at once — nothing is agreed AND refused", () => {
    const every: DeckProbe[] = [
      opaqueRedirect,
      { type: "basic", status: 200 },
      { type: "basic", status: 302 },
      { type: "basic", status: 401 },
      { type: "basic", status: 500 },
      { type: "opaque", status: 0 },
      { status: 0 },
    ];
    for (const res of every) {
      expect(deckRouteAgreed(res) && deckRouteRefused(res), `${res.type}/${res.status}`).toBe(false);
    }
  });
});
