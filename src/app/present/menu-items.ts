// The Board's menu (Board UX 2026-10-28, founder: "no manual navigation on
// the Board"). The Board page has no app header — it sits above a lit panel in
// a dark room — so a compact menu in its top bar carries the portal's tabs for
// the current hat, exactly as page.tsx computes them with tabsForHat/tabsFor.
//
// PURE: tabs in, an ordered list out. "Back to dashboard" leads; the Board's
// own tab is dropped (she is standing on it); duplicates by href collapse.
// The labels arrive already translated — this module never composes words.

export type MenuItem = { href: string; label: string };

/**
 * `home` first, then `tabs` in their own order, de-duplicated by href, with
 * `/present` (and any of its sub-routes) and the home href itself removed
 * from the tabs. Hrefs are compared after trimming; labels are kept as given.
 */
export function menuItemsFor(tabs: ReadonlyArray<MenuItem>, home: MenuItem): MenuItem[] {
  const seen = new Set<string>([home.href]);
  const out: MenuItem[] = [home];
  for (const t of tabs) {
    const href = (t.href ?? "").trim();
    if (!href || !t.label) continue;
    if (href === "/present" || href.startsWith("/present/") || href.startsWith("/present?")) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ href, label: t.label });
  }
  return out;
}
