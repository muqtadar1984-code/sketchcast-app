/**
 * Founding-places counter tests — the invariants a reviewer must see hold:
 *   * Lemon Squeezy is preferred, because LS is what ENFORCES the 50-place cap
 *   * LS down + DB up → the DB count is served, with NO cap invented
 *   * both down → "unknown", and the shape carries NO numeric keys at all —
 *     the one property that makes a fabricated "0 of 50" impossible downstream
 *   * a real zero is published as a zero (0 is a count, not a failure)
 *   * an unlimited / unusable / absurd cap becomes null rather than a number
 *   * remaining never goes negative, and is null exactly when max is
 *   * a throwing source is a failed source, never a 500
 *   * CORS echoes ONE exact allow-listed origin and never a wildcard
 * Run: npx vitest run
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearFoundingPlacesMemo,
  fetchLsFoundingSnapshot,
  resolveFoundingPlaces,
  resolveFoundingPlacesWith,
  type FoundingPlaces,
  type FoundingSnapshot,
} from "../founding-places";
import { marketingCors, marketingOrigins, marketingPreflightCors } from "@/utils/marketing/cors";

const AT = new Date("2026-08-19T00:00:00.000Z");

/** Build the injected source pair. `ls`/`db` accept a value, null (source
 * unavailable) or an Error (source threw). */
function sources(ls: FoundingSnapshot | null | Error, db: number | null | Error) {
  const settle = <T>(v: T | Error) => async () => {
    if (v instanceof Error) throw v;
    return v;
  };
  return { ls: settle(ls), db: settle(db), now: () => AT };
}

/** Narrowing helper — every numeric assertion below goes through this, so a
 * test can never assert on a field the "unknown" shape does not have. */
function ok(r: FoundingPlaces) {
  if (r.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r;
}

describe("founding places — source resolution", () => {
  it("prefers Lemon Squeezy, and reports the cap LS itself enforces", async () => {
    const r = ok(await resolveFoundingPlacesWith(sources({ claimed: 7, max: 50 }, 999)));
    expect(r.source).toBe("lemonsqueezy");
    expect(r.claimed).toBe(7);
    expect(r.max).toBe(50);
    expect(r.remaining).toBe(43);
    expect(r.asOf).toBe(AT.toISOString());
  });

  it("never blends the two sources — a live LS answer ignores the DB entirely", async () => {
    // The DB count is a proxy that can lag a webhook; mixing it into an exact
    // number would corrupt the only figure we can actually stand behind.
    const r = ok(await resolveFoundingPlacesWith(sources({ claimed: 3, max: 50 }, 41)));
    expect(r.claimed).toBe(3);
  });

  it("falls back to the database when LS is unavailable — and invents no cap", async () => {
    const r = ok(await resolveFoundingPlacesWith(sources(null, 12)));
    expect(r.source).toBe("database");
    expect(r.claimed).toBe(12);
    expect(r.max).toBeNull();
    expect(r.remaining).toBeNull();
  });

  it("falls back when LS THROWS, not merely when it returns null", async () => {
    const r = ok(await resolveFoundingPlacesWith(sources(new Error("ECONNRESET"), 12)));
    expect(r.source).toBe("database");
    expect(r.claimed).toBe(12);
  });

  it("returns unknown when both sources are down — with no numeric keys at all", async () => {
    const r = await resolveFoundingPlacesWith(sources(null, null));
    expect(r).toEqual({ status: "unknown" });
    // THE ANTI-FABRICATION INVARIANT. A consumer doing
    // `typeof data.claimed === "number"` must fail here — an unknown response
    // must not be able to render as "0 of 50 claimed".
    const loose = r as Record<string, unknown>;
    expect(loose.claimed).toBeUndefined();
    expect(loose.max).toBeUndefined();
    expect(loose.remaining).toBeUndefined();
  });

  it("returns unknown when both sources throw", async () => {
    const r = await resolveFoundingPlacesWith(sources(new Error("ls"), new Error("db")));
    expect(r.status).toBe("unknown");
  });
});

describe("founding places — what counts as a usable number", () => {
  it("publishes a real zero (0 claimed is a measurement, not a failure)", async () => {
    const r = ok(await resolveFoundingPlacesWith(sources({ claimed: 0, max: 50 }, null)));
    expect(r.claimed).toBe(0);
    expect(r.remaining).toBe(50);
    expect(r.status).toBe("ok");
  });

  it("treats an unlimited discount as no cap rather than as a cap of zero", async () => {
    const r = ok(await resolveFoundingPlacesWith(sources({ claimed: 4, max: null }, null)));
    expect(r.max).toBeNull();
    expect(r.remaining).toBeNull();
    expect(r.claimed).toBe(4);
  });

  it("rejects a nonsensical claimed count and falls through to the DB", async () => {
    for (const bad of [-1, 1.5, Number.NaN, "9" as unknown as number]) {
      const r = ok(await resolveFoundingPlacesWith(sources({ claimed: bad, max: 50 }, 6)));
      expect(r.source).toBe("database");
      expect(r.claimed).toBe(6);
    }
  });

  it("rejects a nonsensical cap but keeps the good count", async () => {
    for (const bad of [0, -50, 12.5, Number.NaN]) {
      const r = ok(await resolveFoundingPlacesWith(sources({ claimed: 2, max: bad }, null)));
      expect(r.source).toBe("lemonsqueezy");
      expect(r.claimed).toBe(2);
      expect(r.max).toBeNull();
    }
  });

  it("floors remaining at zero when the cap is exactly full", async () => {
    expect(ok(await resolveFoundingPlacesWith(sources({ claimed: 50, max: 50 }, null))).remaining).toBe(0);
  });

  it("drops a cap SMALLER than the count rather than publishing a contradiction", async () => {
    // Reachable: the founder lowers max_redemptions in the LS dashboard after
    // redemptions have happened. "30 of 25 claimed" is a sentence no reader can
    // believe, so the count is published alone and the consumer keeps its own
    // static cap line.
    const r = ok(await resolveFoundingPlacesWith(sources({ claimed: 53, max: 50 }, null)));
    expect(r.claimed).toBe(53);
    expect(r.max).toBeNull();
    expect(r.remaining).toBeNull();
  });

  it("rejects a nonsensical DB count and reports unknown rather than a guess", async () => {
    const r = await resolveFoundingPlacesWith(sources(null, -3));
    expect(r.status).toBe("unknown");
  });
});

/* -- the LS wire format ------------------------------------------------------
 * Everything above injects stubs, which tests the DECISION but not the PARSER —
 * and the parser is what actually produces the number printed next to a paid
 * CTA. These drive the real fetchLsFoundingSnapshot against a stubbed
 * global.fetch, because the one thing a live probe cannot tell us today is
 * whether the discount filter works: with zero redemptions in the store, a
 * correctly-filtered query and an ignored one both answer 0.
 * -------------------------------------------------------------------------- */

type LsStub = { redemptionsTotal?: unknown; discount?: unknown | null; redemptionsStatus?: number; redemptionsBody?: unknown };

/** Stand in for the two LS endpoints, recording every URL asked for. */
function stubLs(stub: LsStub) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    const json = (body: unknown, status = 200) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
    if (url.includes("/discount-redemptions")) {
      if (stub.redemptionsStatus && stub.redemptionsStatus >= 400) return json({}, stub.redemptionsStatus);
      if (stub.redemptionsBody !== undefined) return json(stub.redemptionsBody);
      return json({ data: [], meta: { page: { total: stub.redemptionsTotal } } });
    }
    if (stub.discount === null) return json({}, 404);
    return json({ data: { attributes: stub.discount } });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("LEMONSQUEEZY_API_KEY", "test-key");
  vi.stubEnv("LEMONSQUEEZY_FOUNDING_DISCOUNT_ID", "1054010");
  return { urls, fetchMock };
}

const LIMITED_50 = { is_limited_redemptions: true, max_redemptions: 50, test_mode: false };

describe("founding places — reading Lemon Squeezy off the wire", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearFoundingPlacesMemo();
  });

  it("filters redemptions BY DISCOUNT ID and reads the count out of the pagination meta", async () => {
    // The filter is the whole reason this number is about our offer and not
    // about every discount the store has ever issued. An unfiltered query would
    // answer 0 today too, so only the URL can prove it.
    const { urls } = stubLs({ redemptionsTotal: 7, discount: LIMITED_50 });
    const snap = await fetchLsFoundingSnapshot();
    expect(snap).toEqual({ claimed: 7, max: 50 });
    expect(urls.some((u) => u.includes("/discount-redemptions?filter[discount_id]=1054010"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/discounts/1054010"))).toBe(true);
  });

  it("reports the cap ONLY when LS says the discount is actually limited", async () => {
    const { urls } = stubLs({ redemptionsTotal: 3, discount: { is_limited_redemptions: false, max_redemptions: 50 } });
    expect(await fetchLsFoundingSnapshot()).toEqual({ claimed: 3, max: null });
    expect(urls.length).toBe(2);
  });

  it("refuses to publish a count for a discount LS did not confirm exists", async () => {
    // A deleted or mistyped id 404s, and its redemption total is 0 — which is
    // indistinguishable from a real zero. Requiring the discount object is what
    // stops "0 of 50 claimed - 50 left" being published about nothing.
    const { fetchMock } = stubLs({ redemptionsTotal: 0, discount: null });
    expect(await fetchLsFoundingSnapshot()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a TEST-MODE discount in production — a test ledger is not the ledger", async () => {
    // The failure this prevents: the store is activated, the live discount is a
    // NEW object with a new id, the env var still points at the test one, and
    // it answers 0 forever while real places are being consumed.
    stubLs({ redemptionsTotal: 0, discount: { ...LIMITED_50, test_mode: true } });
    vi.stubEnv("NODE_ENV", "production");
    expect(await fetchLsFoundingSnapshot()).toBeNull();
  });

  it("accepts a test-mode discount outside production, so the path is exercisable", async () => {
    stubLs({ redemptionsTotal: 0, discount: { ...LIMITED_50, test_mode: true } });
    vi.stubEnv("NODE_ENV", "development");
    expect(await fetchLsFoundingSnapshot()).toEqual({ claimed: 0, max: 50 });
  });

  it("treats a non-2xx, a reshaped meta block and a thrown transport alike: no answer", async () => {
    stubLs({ discount: LIMITED_50, redemptionsStatus: 500 });
    expect(await fetchLsFoundingSnapshot()).toBeNull();
    vi.unstubAllGlobals();

    // The shape LS would hand us if it renamed its pagination meta — the count
    // becomes undefined, which must degrade rather than publish as a number.
    stubLs({ discount: LIMITED_50, redemptionsBody: { data: [], meta: { pagination: { total: 7 } } } });
    expect(await fetchLsFoundingSnapshot()).toBeNull();
    vi.unstubAllGlobals();

    stubLs({ redemptionsTotal: 7, discount: LIMITED_50 });
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET");
    });
    expect(await fetchLsFoundingSnapshot()).toBeNull();
  });

  it("asks LS nothing at all when the key or the discount id is missing", async () => {
    const { fetchMock } = stubLs({ redemptionsTotal: 7, discount: LIMITED_50 });
    vi.stubEnv("LEMONSQUEEZY_FOUNDING_DISCOUNT_ID", "");
    expect(await fetchLsFoundingSnapshot()).toBeNull();
    vi.stubEnv("LEMONSQUEEZY_FOUNDING_DISCOUNT_ID", "1054010");
    vi.stubEnv("LEMONSQUEEZY_API_KEY", "");
    expect(await fetchLsFoundingSnapshot()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("collapses concurrent cache misses onto ONE resolve (single flight)", async () => {
    // The abuse this closes: a distinct query string is a distinct CDN cache
    // key, so `?t=1&t=2...` fired concurrently all miss the CDN and all land in
    // the function. Memoising only the settled value leaves the whole
    // round-trip window uncovered, and the key being hammered is the same one
    // that opens paid checkouts.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { fetchMock } = stubLs({ redemptionsTotal: 7, discount: LIMITED_50 });
    const slow = vi.fn(async (input: unknown) => {
      await gate;
      return fetchMock(input);
    });
    vi.stubGlobal("fetch", slow);
    clearFoundingPlacesMemo();

    const all = Promise.all([resolveFoundingPlaces(), resolveFoundingPlaces(), resolveFoundingPlaces(), resolveFoundingPlaces()]);
    release!();
    const results = await all;

    expect(slow).toHaveBeenCalledTimes(2); // the pair, once — not the pair four times
    for (const r of results) expect(ok(r).claimed).toBe(7);
    // ...and the settled memo then serves the next caller with no call at all.
    expect(ok(await resolveFoundingPlaces()).claimed).toBe(7);
    expect(slow).toHaveBeenCalledTimes(2);
  });
});

describe("marketing CORS", () => {
  it("echoes the exact allow-listed origin and never a wildcard", () => {
    const h = marketingCors("https://sketchcast.app");
    expect(h["Access-Control-Allow-Origin"]).toBe("https://sketchcast.app");
    expect(h["Access-Control-Allow-Origin"]).not.toBe("*");
    expect(h.Vary).toBe("Origin");
  });

  it("covers the www host the marketing site also answers on", () => {
    expect(marketingCors("https://www.sketchcast.app")["Access-Control-Allow-Origin"]).toBe("https://www.sketchcast.app");
  });

  it("sends nothing for a look-alike origin or no origin at all", () => {
    expect(marketingCors("https://sketchcast.app.evil.example")).toEqual({});
    expect(marketingCors("http://sketchcast.app")).toEqual({}); // scheme is part of an origin
    expect(marketingCors(null)).toEqual({});
  });

  it("never grants credentials — the page fetches with credentials omitted", () => {
    expect(marketingCors("https://sketchcast.app")["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  it("answers a preflight with the headers it was ASKED about, or the GET never fires", () => {
    const h = marketingPreflightCors("https://sketchcast.app", "x-client, content-type");
    expect(h["Access-Control-Allow-Headers"]).toBe("x-client, content-type");
    expect(h["Access-Control-Allow-Origin"]).toBe("https://sketchcast.app");
    // Nothing to allow when nothing was asked for, and never a header grant to
    // an origin that gets no CORS at all.
    expect(marketingPreflightCors("https://sketchcast.app", null)["Access-Control-Allow-Headers"]).toBeUndefined();
    expect(marketingPreflightCors("https://evil.example", "x-client")).toEqual({});
  });

  it("filters a hand-rolled preflight value down to header-name characters", () => {
    // Nothing but a header-name list can reach a response header from here.
    const h = marketingPreflightCors("https://sketchcast.app", "x-ok\r\nSet-Cookie: a=b");
    expect(h["Access-Control-Allow-Headers"]).toBe("x-okSet-Cookie ab");
  });

  it("normalises env-supplied origins so a trailing slash still matches", () => {
    const prev = process.env.MARKETING_ORIGINS;
    process.env.MARKETING_ORIGINS = "https://preview.sketchcast.pages.dev/, not a url";
    try {
      expect(marketingOrigins()).toContain("https://preview.sketchcast.pages.dev");
      // …and the built-ins survive whatever is in the env var.
      expect(marketingOrigins()).toContain("https://sketchcast.app");
    } finally {
      if (prev === undefined) delete process.env.MARKETING_ORIGINS;
      else process.env.MARKETING_ORIGINS = prev;
    }
  });
});
