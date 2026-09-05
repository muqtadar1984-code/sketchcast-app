/** Copy for the activation reminder emails.
 *
 * English only, deliberately. These invite a reply and are signed personally —
 * at 36 teachers the value is in the conversation they start, not in reach, and
 * a machine-translated personal note reads worse than an English one. Revisit
 * when a non-English market has enough teachers to justify it.
 *
 * Plain text, also deliberately: better deliverability than HTML, and no RTL
 * layout problems if this is ever translated into Arabic or Jawi.
 */

import type { Segment } from "./segments";

export type EmailFields = {
  /** First name, or null — the template falls back to a neutral greeting. */
  firstName: string | null;
  /** Title of their most recent book. Only used by `no_generation`. */
  bookTitle: string | null;
  /** Where to send them. A plain link: they sign in normally. Never a
   *  session-granting magic link — an email that grants a session is a bearer
   *  token sitting in an inbox, and forwarding it hands over the account. */
  appUrl: string;
  unsubscribeUrl: string;
};

const SIGNOFF = ["Muqtadar", "SketchCast"].join("\n");

function footer(unsubscribeUrl: string): string {
  return [
    "---",
    "You're receiving this because you registered at sketchcast.app.",
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");
}

function greeting(firstName: string | null): string {
  return firstName ? `Hi ${firstName},` : "Hi there,";
}

export function renderEmail(
  segment: Segment,
  f: EmailFields,
): { subject: string; text: string } {
  if (segment === "no_book") {
    return {
      subject: "Your SketchCast account is ready — upload a textbook to start",
      text: [
        greeting(f.firstName),
        "",
        "You created a SketchCast account a few days ago but haven't uploaded a",
        "textbook yet.",
        "",
        "Here's what happens when you do. You upload the whole textbook once.",
        "Then pick any chapter, and SketchCast builds a narrated video lesson",
        "plus a slide deck and five documents you can take straight into",
        "class — lesson plan, worksheet, activity, exam paper and case study.",
        "",
        "It takes about five minutes, and you don't need to prepare anything",
        "first.",
        "",
        "Open SketchCast:",
        f.appUrl,
        "",
        "If something didn't work, or it isn't what you expected, just reply to",
        "this email. It comes to me directly.",
        "",
        SIGNOFF,
        "",
        footer(f.unsubscribeUrl),
      ].join("\n"),
    };
  }

  // no_generation — they have a book and have never tried to make anything.
  const book = f.bookTitle ? `"${f.bookTitle}"` : "your textbook";
  return {
    subject: "Your textbook is ready — create your first lesson",
    text: [
      greeting(f.firstName),
      "",
      `You uploaded ${book} to SketchCast, but haven't created a lesson from it`,
      "yet.",
      "",
      "Pick any chapter and SketchCast will build a narrated video lesson plus",
      "a slide deck and five documents for that chapter — lesson plan,",
      "worksheet, activity, exam paper and case study. It runs in the",
      "background, so you can close the tab and come back to it.",
      "",
      "Open your library:",
      f.appUrl,
      "",
      "If something got in the way, reply and tell me — it comes to me directly,",
      "and it's genuinely useful to know.",
      "",
      SIGNOFF,
      "",
      footer(f.unsubscribeUrl),
    ].join("\n"),
  };
}

/**
 * The one-time welcome email (founder-approved copy, 2026-08-17). Sent on a
 * new account's first dashboard visit — for most signups (Google OAuth) this
 * is the ONLY email that would otherwise ever reach their inbox, so its real
 * job is to exist there as an easy way back in.
 */
export function welcomeEmail(f: {
  firstName: string | null;
  appUrl: string;
  unsubscribeUrl: string;
}): { subject: string; text: string } {
  return {
    subject: "Your SketchCast account is ready",
    text: [
      greeting(f.firstName),
      "",
      "Welcome to SketchCast — your account is set up and ready to use.",
      "",
      "SketchCast turns the textbook you already teach from into a complete",
      "teaching kit: a narrated video lesson, an editable slide deck,",
      "worksheet, test paper, lesson plan, activities and a case study —",
      "in the language you teach in.",
      "",
      "Getting started takes two steps:",
      "",
      "1. Upload your textbook (a PDF, or scanned pages straight from your phone)",
      "2. Pick a chapter and press Generate",
      "",
      `Log in any time: ${f.appUrl}/login`,
      "",
      "If anything is unclear or doesn't work the way you expect, just reply",
      "to this email — a real person reads every reply.",
      "",
      "— The SketchCast team",
      "",
      "---",
      `Prefer fewer emails? Unsubscribe: ${f.unsubscribeUrl}`,
    ].join("\n"),
  };
}
