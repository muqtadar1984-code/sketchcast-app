/**
 * countryFromHeaders (src/utils/geo.ts) — the edge's guess at where a request
 * came from, and the single source of every country_source='assumed' value.
 *
 * What must hold:
 *  • only an ASSIGNED alpha-2 code ever comes back, because whatever this
 *    returns is written to profiles.country, whose 0085 CHECK would otherwise
 *    reject it and fail a registration;
 *  • the edge's own placeholders for "we couldn't place this" (Vercel omits the
 *    header, Cloudflare sends XX and T1) come back as null and never as a
 *    country — this is the case that decides whether localhost and Tor users
 *    get a fabricated country;
 *  • null is a first-class answer, not an error.
 * Run: npx vitest run src/utils/__tests__/geo.test.ts
 */
import { describe, expect, it } from "vitest";
import { countryFromHeaders } from "@/utils/geo";

const h = (o: Record<string, string>) => new Headers(o);

describe("countryFromHeaders", () => {
  it("reads the Vercel header", () => {
    expect(countryFromHeaders(h({ "x-vercel-ip-country": "EG" }))).toBe("EG");
  });

  it("reads the Cloudflare header when Vercel's is absent", () => {
    expect(countryFromHeaders(h({ "cf-ipcountry": "MY" }))).toBe("MY");
  });

  it("prefers Vercel's when both are present", () => {
    // Vercel is the host; a Cloudflare header could only come from a proxy in
    // front of it, which is further from the reader.
    expect(countryFromHeaders(h({ "x-vercel-ip-country": "EG", "cf-ipcountry": "US" }))).toBe("EG");
  });

  it("normalises case and whitespace", () => {
    expect(countryFromHeaders(h({ "x-vercel-ip-country": " eg " }))).toBe("EG");
  });

  it("returns null when there is no header at all (localhost)", () => {
    expect(countryFromHeaders(h({}))).toBeNull();
  });

  it("rejects the edge's unknown/Tor placeholders", () => {
    // The whole point: XX and T1 are shaped exactly like country codes and
    // would sail through the 0085 CHECK, landing as a real-looking country for
    // a reader the edge explicitly could not place.
    expect(countryFromHeaders(h({ "cf-ipcountry": "XX" }))).toBeNull();
    expect(countryFromHeaders(h({ "cf-ipcountry": "T1" }))).toBeNull();
  });

  it("rejects anything that is not an assigned code", () => {
    for (const junk of ["", "  ", "MYS", "M", "ZZ", "12", "en-GB"]) {
      expect(countryFromHeaders(h({ "x-vercel-ip-country": junk }))).toBeNull();
    }
  });

  it("falls through a junk Vercel header to a good Cloudflare one", () => {
    expect(countryFromHeaders(h({ "x-vercel-ip-country": "XX", "cf-ipcountry": "MY" }))).toBe("MY");
  });
});
