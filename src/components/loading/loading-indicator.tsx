"use client";

import {
  Suspense,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Spinner from "./spinner";
import {
  createPendingCounter,
  isRouteChangeClick,
  isRouteChangeHref,
  routeKey,
  trackPending,
} from "./pending";

// The app-wide "you are waiting" indicator — mounted ONCE, in the root layout,
// so every surface (dashboard, Library, school portal, console, quiz) gets it
// without per-page work. Founder, 2026-10-17: "a spinny circle to show a
// screen loading … after clicking at a link or any other situation that calls
// for such a wait … all instances of such clicks and not just library."
//
// Two layers feed ONE counter (./pending.ts):
//
//  1. NAVIGATION. A wait begins when a route change starts and ends when the
//     new route has rendered. The App Router has no "navigation started"
//     event, so the start is observed three ways: a capture-phase click
//     listener on the document (every <Link> and every plain internal <a>,
//     whichever component rendered it), the router singleton's push/replace
//     (every useRouter() caller: the hat switcher, the login forms, the
//     inbox's j/k keys…), and popstate (back/forward). The END is the one
//     signal the router does give: usePathname / useSearchParams change only
//     once the new segment has committed, so a changed route key releases the
//     wait. A fallback timer releases it anyway if the URL never changes (a
//     click a handler cancelled after we saw it, a navigation the server
//     redirected back to the same page).
//
//  2. ACTIONS. A client component awaiting a fetch marks itself busy with
//     useBusy() / useBusyWhile() / <Busy> below. Per-button disabled states
//     and labels stay exactly as they are; this only adds the global ring.
//
// router.refresh() is deliberately NOT wrapped: AutoRefresh polls it every six
// seconds while a lesson builds, and a ring pulsing on every poll would be
// noise. A hook that wants its own refresh to count (useKitPost does) runs it
// in a transition and holds the wait while the transition is pending.
//
// WHAT IS SHOWN. A hairline progress bar across the top, then a centred ring
// over a small white disc. Both fade in by CSS animation-delay (globals.css,
// .loading-bar ~150 ms, .loading-veil ~300 ms), so a wait that ends inside
// that window paints nothing at all — no flash on a fast prefetched route.
// The overlay never takes pointer events: the page stays usable, nothing is
// blocked, the ring only says "still working".

/** One counter for the whole document. Module-level rather than in React
 *  state so every hook instance, and the router wrap, share it. */
const counter = createPendingCounter();

/** How long a navigation may stay "pending" before we stop believing it. */
const NAVIGATION_FALLBACK_MS = 8000;

const LabelContext = createContext<string>("Loading…");

/** The localised "Loading…" the root layout handed down — for a loading.tsx
 *  or any client component that renders its own Spinner. */
export function useLoadingLabel(): string {
  return useContext(LabelContext);
}

const subscribe = (onChange: () => void) => counter.subscribe(onChange);
const getBusy = () => counter.busy();
const getServerBusy = () => false;

/** The global wait, for a client component that awaits something.
 *
 *    const { track } = useBusy();
 *    const res = await track(fetch(...));   // the ring shows until it settles
 *
 *    const release = begin(); try { … } finally { release(); }
 *
 *  `busy` is whether ANYTHING is waiting, across the whole app. */
export function useBusy() {
  const busy = useSyncExternalStore(subscribe, getBusy, getServerBusy);
  const begin = useCallback(() => counter.begin(), []);
  const track = useCallback(<T,>(work: PromiseLike<T>) => trackPending(counter, work), []);
  return { busy, begin, track };
}

/** Hold the global wait for as long as `active` is true — for a component that
 *  already keeps its own `busy` state and only needs the ring to follow it. */
export function useBusyWhile(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return counter.begin(); // the release IS the cleanup
  }, [active]);
}

/** The same, as an element: `<Busy active={busy} />` beside an existing
 *  button. Renders nothing. */
export function Busy({ active }: { active: boolean }) {
  useBusyWhile(active);
  return null;
}

// ── Layer 1: navigation ─────────────────────────────────────────────────────

/** The router singleton, marked once it has been wrapped. The object
 *  useRouter() returns is ONE module-level instance in Next 16
 *  (app-router-instance.js, publicAppRouterInstance), which is what lets a
 *  single wrap reach every call site; the flag stops a remount from wrapping
 *  the wrapper. */
type PatchableRouter = ReturnType<typeof useRouter> & { __scLoadingPatched?: true };

/** The begin() the router wrap calls. A module-level slot rather than a
 *  closure, so the wrap installed by the first mount keeps working after a
 *  remount replaces the watcher. */
let beginNavigation: (() => void) | null = null;

function NavigationWatcher() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  // The route the page is showing — compared with where a popstate landed,
  // and watched for the change that means the new route has rendered.
  const query = searchParams.toString();
  const key = query ? `${pathname}?${query}` : pathname;
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
  }, [key]);

  const releaseRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const end = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    releaseRef.current?.();
    releaseRef.current = null;
  }, []);

  const begin = useCallback(() => {
    // One wait per navigation, however many signals report it (a <Link>
    // click reaches both the click listener and router.push). A second start
    // only restarts the fallback clock.
    if (!releaseRef.current) releaseRef.current = counter.begin();
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(end, NAVIGATION_FALLBACK_MS);
  }, [end]);

  // The new route has rendered: the key moved. (Also runs on mount, where
  // there is nothing to release.) Unmount releases too.
  useEffect(() => {
    end();
  }, [key, end]);
  useEffect(() => end, [end]);

  useEffect(() => {
    beginNavigation = begin;
    return () => {
      if (beginNavigation === begin) beginNavigation = null;
    };
  }, [begin]);

  // Clicks on internal links, whoever rendered them. Capture phase so a
  // handler that stops propagation cannot hide the click from us; the URL
  // comparison in isRouteChangeClick does the filtering (same origin, a
  // different route, plain left click, this tab, not a download).
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as Element | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (
        isRouteChangeClick(
          { href: anchor.href, target: anchor.target, download: anchor.hasAttribute("download") },
          e,
          new URL(window.location.href),
        )
      ) {
        begin();
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [begin]);

  // Back / forward. popstate fires once the URL has changed and before the
  // router has rendered that entry, so the location already differs from the
  // key on screen; a hash-only pop compares equal and is ignored.
  useEffect(() => {
    const onPop = () => {
      if (routeKey(new URL(window.location.href)) !== keyRef.current) begin();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [begin]);

  // Programmatic navigation: wrap push / replace on the shared instance, once.
  useEffect(() => {
    watchRouterNavigations(router);
  }, [router]);

  return null;
}

/** Wrap push / replace on the router singleton so every useRouter() caller's
 *  navigation starts the wait. Idempotent (the flag), and never undone: the
 *  instance outlives any component, and the wrap reads beginNavigation at call
 *  time, so a remounted watcher is picked up without re-wrapping.
 *
 *  Kept outside the component on purpose. The react-hooks immutability rule
 *  forbids mutating a hook's return value inside a component, because a
 *  per-render React value must not be edited in place. This object is not one:
 *  it is Next's single module-level router (see PatchableRouter), the same
 *  object on every render, and it is changed exactly once, from an effect. */
function watchRouterNavigations(router: ReturnType<typeof useRouter>): void {
  const r = router as PatchableRouter;
  if (r.__scLoadingPatched) return;
  const wrap =
    (orig: PatchableRouter["push"]): PatchableRouter["push"] =>
    (href, options) => {
      if (isRouteChangeHref(href, new URL(window.location.href))) beginNavigation?.();
      return orig(href, options);
    };
  r.push = wrap(r.push.bind(r));
  r.replace = wrap(r.replace.bind(r));
  r.__scLoadingPatched = true;
}

// ── The overlay ─────────────────────────────────────────────────────────────

function Overlay({ label }: { label: string }) {
  const { busy } = useBusy();

  // aria-busy on <body>: the document as a whole is being updated. Assistive
  // tech that honours it (and any test) reads the state from one place.
  useEffect(() => {
    if (!busy) return;
    document.body.setAttribute("aria-busy", "true");
    return () => document.body.removeAttribute("aria-busy");
  }, [busy]);

  if (!busy) return null;
  return (
    <>
      <div aria-hidden className="loading-bar pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5 overflow-hidden">
        <div className="loading-bar-fill h-full bg-[#1FB8A6]" />
      </div>
      <div className="loading-veil pointer-events-none fixed inset-0 z-[60] flex items-center justify-center">
        <div className="rounded-full bg-white/95 p-3 shadow-card ring-1 ring-[#E6E8E4]">
          <Spinner size="lg" label={label} />
        </div>
      </div>
    </>
  );
}

/** Mounted once in the root layout around the page tree. `label` is
 *  `t.common.loading` for the request's locale. */
export default function LoadingProvider({ label, children }: { label: string; children: ReactNode }) {
  return (
    <LabelContext.Provider value={label}>
      {children}
      {/* useSearchParams wants a Suspense boundary above it so a statically
          rendered route is not forced to the client; the watcher renders
          nothing, so the fallback is nothing too. */}
      <Suspense fallback={null}>
        <NavigationWatcher />
      </Suspense>
      <Overlay label={label} />
    </LabelContext.Provider>
  );
}
