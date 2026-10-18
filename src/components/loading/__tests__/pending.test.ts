import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPendingCounter,
  isRouteChangeClick,
  isRouteChangeHref,
  routeKey,
  trackPending,
} from "../pending";

// The app-wide loading indicator (founder, 2026-10-17: "a spinny circle …
// after clicking at a link or any other situation that calls for such a
// wait"). The counter is the whole of its logic; the provider is glue.

describe("createPendingCounter", () => {
  it("is idle until something begins, busy while anything is waiting, idle again after the last release", () => {
    const c = createPendingCounter();
    expect(c.busy()).toBe(false);
    const a = c.begin();
    const b = c.begin();
    expect(c.count()).toBe(2);
    a();
    expect(c.busy()).toBe(true); // b is still waiting
    b();
    expect(c.busy()).toBe(false);
    expect(c.count()).toBe(0);
  });

  it("a release is idempotent: releasing twice never hides someone else's wait or goes negative", () => {
    const c = createPendingCounter();
    const a = c.begin();
    const b = c.begin();
    a();
    a(); // a finally after an early return, an unmount after a release…
    expect(c.count()).toBe(1);
    b();
    b();
    expect(c.count()).toBe(0);
  });

  it("notifies on every real change and not on a no-op release; unsubscribe stops it", () => {
    const c = createPendingCounter();
    const seen: number[] = [];
    const off = c.subscribe((n) => seen.push(n));
    const a = c.begin();
    a();
    a();
    expect(seen).toEqual([1, 0]);
    off();
    c.begin();
    expect(seen).toEqual([1, 0]);
  });
});

describe("trackPending", () => {
  it("holds the wait while the work runs and releases it on success", async () => {
    const c = createPendingCounter();
    let resolve!: (v: string) => void;
    const p = trackPending(c, new Promise<string>((r) => (resolve = r)));
    expect(c.busy()).toBe(true);
    resolve("done");
    await expect(p).resolves.toBe("done");
    expect(c.busy()).toBe(false);
  });

  it("releases on failure too and passes the rejection through untouched", async () => {
    const c = createPendingCounter();
    const err = new Error("network");
    await expect(trackPending(c, Promise.reject(err))).rejects.toBe(err);
    expect(c.busy()).toBe(false);
  });

  it("accepts a thenable (a Supabase query builder is not a Promise)", async () => {
    const c = createPendingCounter();
    const thenable = { then: (ok: (v: number) => void) => ok(7) } as PromiseLike<number>;
    await expect(trackPending(c, thenable)).resolves.toBe(7);
    expect(c.busy()).toBe(false);
  });

  it("overlapping work keeps the indicator up until the last one settles", async () => {
    const c = createPendingCounter();
    const listener = vi.fn();
    c.subscribe(listener);
    let finishSlow!: () => void;
    const slow = trackPending(c, new Promise<void>((r) => (finishSlow = r)));
    await trackPending(c, Promise.resolve());
    expect(c.busy()).toBe(true);
    finishSlow();
    await slow;
    expect(c.busy()).toBe(false);
    expect(listener.mock.calls.map(([n]) => n)).toEqual([1, 2, 1, 0]);
  });
});

describe("which navigations show the indicator", () => {
  const here = new URL("https://app.sketchcast.app/dashboard/kits?topic=cells#top");
  const anchor = (href: string, extra: Partial<{ target: string; download: boolean }> = {}) => ({
    href,
    target: "",
    download: false,
    ...extra,
  });
  const left = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

  it("routeKey is path + query, never the hash", () => {
    expect(routeKey(here)).toBe("/dashboard/kits?topic=cells");
  });

  it("a plain click to another route of ours counts, path or query alike", () => {
    expect(isRouteChangeClick(anchor("/library/topics/abc"), left, here)).toBe(true);
    expect(isRouteChangeClick(anchor("/dashboard/kits?topic=atoms"), left, here)).toBe(true);
    expect(isRouteChangeClick(anchor("https://app.sketchcast.app/dashboard"), left, here)).toBe(true);
  });

  it("a click that waits for nothing does not: same route, a hash jump, another origin, a download, a new tab, a modified or middle click", () => {
    expect(isRouteChangeClick(anchor("/dashboard/kits?topic=cells"), left, here)).toBe(false);
    expect(isRouteChangeClick(anchor("#section-2"), left, here)).toBe(false);
    expect(isRouteChangeClick(anchor("https://youtube.com/watch?v=x"), left, here)).toBe(false);
    expect(isRouteChangeClick(anchor("mailto:help@sketchcast.app"), left, here)).toBe(false);
    expect(isRouteChangeClick(anchor("/api/deck/1", { download: true }), left, here)).toBe(false);
    expect(isRouteChangeClick(anchor("/library", { target: "_blank" }), left, here)).toBe(false);
    expect(isRouteChangeClick(anchor("/library"), { ...left, metaKey: true }, here)).toBe(false);
    expect(isRouteChangeClick(anchor("/library"), { ...left, ctrlKey: true }, here)).toBe(false);
    expect(isRouteChangeClick(anchor("/library"), { ...left, shiftKey: true }, here)).toBe(false);
    expect(isRouteChangeClick(anchor("/library"), { ...left, button: 1 }, here)).toBe(false);
  });

  it("router.push / replace: a relative or same-origin href elsewhere counts; the current route or another origin does not", () => {
    expect(isRouteChangeHref("/dashboard", here)).toBe(true);
    expect(isRouteChangeHref("?topic=atoms", here)).toBe(true);
    expect(isRouteChangeHref("/dashboard/kits?topic=cells", here)).toBe(false);
    expect(isRouteChangeHref("#top", here)).toBe(false);
    expect(isRouteChangeHref("https://example.com/", here)).toBe(false);
  });
});

// vitest collects no .tsx, so the wiring is pinned by reading the sources —
// the way premium-voices-threading and assignable do.
describe("the indicator is mounted once and reached by the shared post paths", () => {
  const src = (rel: string) => readFileSync(join(process.cwd(), "src", rel), "utf8");

  it("the root layout wraps the page tree in the provider with the localised label", () => {
    const layout = src("app/layout.tsx");
    expect(layout).toMatch(/<LoadingProvider label=\{loadingLabel\}>\{children\}<\/LoadingProvider>/);
    expect(layout).toMatch(/\.common\.loading/);
  });

  it("each main route group has a loading.tsx rendering the shared screen", () => {
    for (const group of ["dashboard", "library", "school", "console", "present"]) {
      expect(src(`app/${group}/loading.tsx`)).toMatch(/<LoadingScreen \/>/);
    }
  });

  it("the Library's useKitPost tracks the request and holds the wait through its refresh", () => {
    const panel = src("app/library/topics/[id]/kit-panel.tsx");
    expect(panel).toMatch(/await track\(/);
    expect(panel).toMatch(/useBusyWhile\(refreshing\)/);
    expect(panel).toMatch(/startRefresh\(\(\) => router\.refresh\(\)\)/);
  });

  it("the dashboard's generate, upload, delete and quiz-submit controls follow their own busy state", () => {
    for (const f of [
      "generate-button",
      "generate-all-button",
      "chapter-generate",
      "batch-generate",
      "exam-generate",
      "upload-book",
      "delete-lesson",
      "quiz-player",
    ]) {
      expect(src(`app/dashboard/${f}.tsx`)).toMatch(/useBusyWhile\(busy\);/);
    }
    expect(src("app/dashboard/generate-kit-button.tsx")).toMatch(/useBusyWhile\(busy \|\| adopting\);/);
    // delete-book holds busy across a native confirm(): only its calls are tracked
    const del = src("app/dashboard/delete-book.tsx");
    expect(del).toMatch(/await track\(supabase\.rpc\("my_book_impact"/);
    expect(del).toMatch(/await track\(fetch\(`\/api\/books\//);
    expect(del).not.toMatch(/useBusyWhile/);
  });

  it("the spinner is accessible: a status role, an sr-only label, and motion only when motion is welcome", () => {
    const spinner = src("components/loading/spinner.tsx");
    expect(spinner).toMatch(/role="status"/);
    expect(spinner).toMatch(/className="sr-only"/);
    expect(spinner).toMatch(/motion-safe:animate-spin/);
    expect(spinner).not.toMatch(/[\s"`]animate-spin/); // never an unconditional spin
  });
});
