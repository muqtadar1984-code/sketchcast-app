/* The dashboard streams (2026-10-30, "speed up the page load"). These pins
 * keep the three things that make it fast — and the two that keep SK's
 * walkthrough honest — from drifting back. vitest collects no .tsx, so like
 * the other dashboard wiring tests these read the source. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (f: string) => readFileSync(resolve(__dirname, "..", f), "utf8");
const page = read("page.tsx");
const layout = read("layout.tsx");

/** The source of one top-level function in page.tsx, up to the next one. */
function fnBody(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  expect(at, name).toBeGreaterThan(0);
  const next = src.indexOf("\nasync function ", at + 1);
  const nextSync = src.indexOf("\nfunction ", at + 1);
  const ends = [next, nextSync].filter((n) => n > 0);
  return src.slice(at, ends.length ? Math.min(...ends) : undefined);
}

describe("the Library signs in batches, not one request per file", () => {
  it("page.tsx makes no single createSignedUrl call — every URL goes through batchSigner", () => {
    expect(page).not.toMatch(/\.createSignedUrl\(/);
    expect(page).toMatch(/import \{ batchSigner, type Signer \} from "@\/utils\/storage\/batch-sign";/);
  });

  it("keeps the same client per path: the session for the user's own, the service role only for catalogue copies and students", () => {
    expect(page).toMatch(/const userSign = batchSigner\(supabase, "artifacts", 3600\);/);
    expect(page).toMatch(/const sign = copySign && isCatalogueCopy\(\{ params: g\.params \}\) \? copySign : userSign;/);
    expect(page).toMatch(/const adminSign = admin \? batchSigner\(admin, "artifacts", 3600\) : null;/);
  });

  it("the student view builds its rows concurrently, so their URLs share one batch", () => {
    const student = fnBody(page, "StudentHome");
    expect(student).toMatch(/const items: Item\[\] = await Promise\.all\(pending\);/);
    // The documents and videos are ASKED for before the row's first await.
    const videos = student.indexOf("const videosP = Promise.all(videoPaths.map((p) => sign(p)));");
    const doc = student.indexOf("const docP =");
    const firstAwait = student.indexOf("await Promise.all(deckPaths.map((p) => sign(p)))");
    expect(videos).toBeGreaterThan(0);
    expect(videos).toBeLessThan(firstAwait);
    expect(doc).toBeLessThan(firstAwait);
  });
});

describe("streaming sections tell SK's walkthrough they are still loading", () => {
  it("every Suspense fallback on the page is the light <Pending> skeleton", () => {
    const fallbacks = page.match(/<Suspense fallback=\{[^}]*\}/g) ?? [];
    expect(fallbacks.length).toBeGreaterThanOrEqual(10);
    for (const f of fallbacks) expect(f).toMatch(/^<Suspense fallback=\{<Pending\b/);
  });

  it("<Pending> is busy (aria-busy, data-loading, data-sk-loading) and carries no anchors", () => {
    const pending = fnBody(page, "Pending");
    expect(pending).toMatch(/aria-busy="true"/);
    expect(pending).toMatch(/data-loading=""/);
    expect(pending).toMatch(/data-sk-loading=""/);
    expect(pending).not.toMatch(/data-tour|data-sk=/);
  });

  it("the tour anchors live in the STREAMED sections, on the same elements as before", () => {
    expect(fnBody(page, "ClassesSection")).toMatch(/<div data-tour="classes">\s*<ClassesCard/);
    expect(fnBody(page, "ClassesSection")).toMatch(/<div data-tour="branding">\s*<BrandingCard/);
    expect(fnBody(page, "LibrarySection")).toMatch(/<div className="space-y-8" data-tour="book-card">/);
    expect(fnBody(page, "StudentHome")).toMatch(/<div data-tour="assignments">\s*<StudentDashboard/);
  });

  it("the segment's loading.tsx is light and marked busy", () => {
    const loading = read("loading.tsx");
    expect(loading).toMatch(/<LoadingScreen \/>/);
    expect(loading).toMatch(/aria-busy="true"/);
    expect(loading).toMatch(/data-sk-loading=""/);
    expect(loading).not.toMatch(/await|createClient/);
  });
});

describe("the critical path holds only what decides the page", () => {
  it("the gates still run before anything renders: forced reset, then the hat", () => {
    const main = fnBody(page, "DashboardPage");
    const reset = main.indexOf('redirect("/auth/update-password")');
    const hat = main.indexOf("if (hatAway) redirect(hatAway);");
    const firstSection = main.indexOf("<Suspense");
    expect(reset).toBeGreaterThan(0);
    expect(reset).toBeLessThan(hat);
    expect(hat).toBeLessThan(firstSection);
  });

  it("one verified user per render: layout, page and header share currentUser", () => {
    expect(page).toMatch(/currentUser\(\)/);
    expect(layout).toMatch(/currentUser\(\)/);
    expect(read("app-header.tsx")).toMatch(/currentUser\(\)/);
    for (const src of [page, layout, read("app-header.tsx")]) expect(src).not.toMatch(/auth\.getUser\(\)/);
  });

  it("the layout's writes are started where they were and finished by after(), not awaited", () => {
    expect(layout).toMatch(/after\(stampAssumedCountry\(supabase, user\.id\)\);/);
    expect(layout).toMatch(/after\(claimLsPurchases\(user\.id, user\.email\)\);/);
    expect(layout).not.toMatch(/await stampAssumedCountry|await claimLsPurchases/);
    // Still BELOW the onboarding redirect, for the reasons the layout spells out.
    const gate = layout.indexOf('redirect("/onboarding")');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(layout.indexOf("after(stampAssumedCountry("));
    expect(gate).toBeLessThan(layout.indexOf("after(claimLsPurchases("));
  });

  it("the claim is still adults-only with a verified email", () => {
    expect(layout).toMatch(/if \(adult && user\.email && user\.email_confirmed_at\) \{\s*after\(claimLsPurchases/);
  });
});
