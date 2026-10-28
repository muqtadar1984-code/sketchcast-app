// The Shell's Context COLLECTOR (Final Plan 2026-10-28 §2.2, §5.4): the hint
// the client posts with every turn about WHERE the user is and WHAT is on
// screen. It is untrusted by design — the server rebuilds the Context from the
// session user and only takes place/selection from this — so it carries no
// ids it did not read off the URL and nothing permission-bearing.
//
// PURE: `location`, the clock and the page language are injected, so the
// collector is unit-tested without a DOM and the panel calls it with the real
// `window.location` / `new Date()` / `document.documentElement.lang`.

import type { SkCollector, SkSelection } from "../types";

export type CollectorLocation = { pathname: string; search: string };

export type CollectorInput = {
  location: CollectorLocation;
  now: Date;
  /** The `<html lang>` value the server wrote ("ms-Arab", "en", ...). */
  lang?: string | null;
  /** Board state, when the Shell is mounted on /present (not in S0). */
  board?: SkCollector["board"];
};

/** Query string → plain record (first value wins; keys kept as written). */
export function parseParams(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  const q = search.startsWith("?") ? search.slice(1) : search;
  if (!q) return out;
  for (const part of q.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawVal = eq === -1 ? "" : part.slice(eq + 1);
    let key: string;
    let val: string;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, " "));
      val = decodeURIComponent(rawVal.replace(/\+/g, " "));
    } catch {
      continue; // a malformed escape is dropped, never thrown
    }
    if (key && !(key in out)) out[key] = val;
  }
  return out;
}

/** What the URL alone says is selected. Only three sources, all from the
 * address bar: `?c=` (the class filter every class-scoped page uses), the
 * learner id path segment on /dashboard/reports/<learnerId>, and `?topic=`
 * (a catalogue topic slug). Nothing is read from the DOM. */
export function selectionFromUrl(pathname: string, params: Record<string, string>): SkSelection | undefined {
  const sel: SkSelection = {};
  if (params.c) sel.classId = params.c;
  if (params.topic) sel.productSlug = params.topic;
  const m = /^\/dashboard\/reports\/([^/?#]+)/.exec(pathname);
  if (m && m[1]) {
    try {
      sel.learnerId = decodeURIComponent(m[1]);
    } catch {
      sel.learnerId = m[1];
    }
  }
  return Object.keys(sel).length ? sel : undefined;
}

/** The browser's local clock in the shape timetable now/next wants:
 * day 1 = Monday … 7 = Sunday (ISO), minutes since local midnight, and the
 * instant as ISO-8601 so the server can sanity-check skew. */
export function clockFrom(now: Date): NonNullable<SkCollector["clock"]> {
  const jsDay = now.getDay(); // 0 = Sunday
  const day = jsDay === 0 ? 7 : jsDay;
  return { day, minutes: now.getHours() * 60 + now.getMinutes(), iso: now.toISOString() };
}

/** "ms-Arab" / "EN" → the lower-case locale code the dictionaries use. */
export function localeFromLang(lang: string | null | undefined): string | undefined {
  const v = (lang ?? "").trim().toLowerCase();
  return v || undefined;
}

export function collect(input: CollectorInput): SkCollector {
  const params = parseParams(input.location.search);
  const out: SkCollector = {
    path: input.location.pathname || "/",
    params,
    clock: clockFrom(input.now),
  };
  const selection = selectionFromUrl(out.path, params);
  if (selection) out.selection = selection;
  if (input.board) out.board = input.board;
  const locale = localeFromLang(input.lang);
  if (locale) out.locale = locale;
  return out;
}
