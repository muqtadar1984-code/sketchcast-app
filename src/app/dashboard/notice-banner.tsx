import NoticeBannerRotator from "./notice-banner-client";
import type { Notice } from "@/utils/notices";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";

// The featured-notice banner — the one thing above the fold that says "read
// this before you carry on". Only EXPLICIT pins on rows published AS notices
// reach it (0068's is_notice + featured_until, self-expiring, at most three);
// nothing is ever auto-featured, so the principal alone decides what interrupts
// a teacher's morning. The list arrives already filtered — utils/notices.ts is
// the single reader for both this and the Next-10 card.
//
// This file is the SERVER shell: it resolves the request's language and hands
// the rotator its words, so every dashboard that renders <NoticeBanner /> keeps
// passing nothing but the notices. Self-sufficient like the app header —
// resolveLocale is React-cached per request, so asking here costs nothing
// beyond what the layout already paid, and the dictionary stays on the server.
// The interactive half (rotation, dismissals, the ack receipt) lives in
// ./notice-banner-client.tsx.
export default async function NoticeBanner({ notices }: { notices: Notice[] }) {
  const t = await getDictionary(await resolveLocale());
  return <NoticeBannerRotator notices={notices} t={t.comms.notices.banner} />;
}
