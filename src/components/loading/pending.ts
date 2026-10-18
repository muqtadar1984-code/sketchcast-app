// The pending-actions counter behind the app-wide loading indicator.
//
// PURE — no React, no DOM — so it can be unit-tested and so the provider in
// loading-indicator.tsx is only the glue. Several things can be "waiting" at
// once (a Library post while a navigation is in flight, two dashboard buttons
// clicked in a row), so this is a COUNT, not a boolean: the spinner shows
// while the count is above zero and hides when the last waiter releases.
//
// Each begin() hands back ITS OWN release function, and that function is
// idempotent: a caller that releases twice (a finally block after an early
// return, a component that unmounts after it already released) never drives
// the count negative and never hides someone else's wait. That is the bug a
// plain increment/decrement pair has, and the reason this file exists.

export type Unsubscribe = () => void;

export type PendingCounter = {
  /** Mark one wait as started; call the returned function when it ends. */
  begin: () => () => void;
  /** How many waits are in flight right now. */
  count: () => number;
  /** True while anything is waiting. */
  busy: () => boolean;
  /** Called with the new count whenever it changes (not on no-op releases). */
  subscribe: (listener: (count: number) => void) => Unsubscribe;
};

export function createPendingCounter(): PendingCounter {
  let count = 0;
  const listeners = new Set<(count: number) => void>();
  const emit = () => {
    for (const l of listeners) l(count);
  };
  return {
    begin() {
      count += 1;
      emit();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        count -= 1;
        emit();
      };
    },
    count: () => count,
    busy: () => count > 0,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Run a promise under a counter: begin before, release after — whether it
 *  resolves or rejects. The promise's own outcome is passed through untouched,
 *  so a caller's error handling is exactly what it was. PromiseLike, so a
 *  Supabase query builder (a thenable, not a Promise) can be tracked as-is. */
export async function trackPending<T>(counter: PendingCounter, work: PromiseLike<T>): Promise<T> {
  const release = counter.begin();
  try {
    return await work;
  } finally {
    release();
  }
}

// ── Navigation targets ──────────────────────────────────────────────────────
// Which clicks and pushes count as "the user is now waiting for a page". Kept
// here, pure, so the rule is testable without a browser: the provider only
// feeds it the anchor's attributes and the current location.

export type AnchorLike = {
  href: string;
  target: string;
  /** the `download` attribute, present or not */
  download: boolean;
};

export type ClickLike = {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/** `pathname + search` of a URL, the part a route change changes. The hash is
 *  dropped on purpose: a same-page anchor jump is not a navigation and must
 *  never show a spinner that nothing will ever hide. */
export function routeKey(url: URL): string {
  return url.pathname + url.search;
}

/** True when following this anchor, with this click, will wait for a page of
 *  OURS to render: same origin, a different path or query, a plain left click
 *  that opens in this tab and is not a download. */
export function isRouteChangeClick(anchor: AnchorLike, click: ClickLike, current: URL): boolean {
  if (click.button !== 0) return false;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false;
  if (anchor.download) return false;
  if (anchor.target && anchor.target !== "_self") return false;
  let target: URL;
  try {
    target = new URL(anchor.href, current.href);
  } catch {
    return false;
  }
  if (target.origin !== current.origin) return false;
  if (!/^https?:$/.test(target.protocol)) return false;
  return routeKey(target) !== routeKey(current);
}

/** The same question for `router.push(href)` / `router.replace(href)`: a
 *  relative or same-origin href that lands somewhere other than here. */
export function isRouteChangeHref(href: string, current: URL): boolean {
  let target: URL;
  try {
    target = new URL(href, current.href);
  } catch {
    return false;
  }
  if (target.origin !== current.origin) return false;
  return routeKey(target) !== routeKey(current);
}
