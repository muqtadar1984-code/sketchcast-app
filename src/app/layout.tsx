import type { Metadata } from "next";
import {
  Space_Grotesk,
  Inter,
  JetBrains_Mono,
  Noto_Kufi_Arabic,
  Noto_Sans_Arabic,
  Noto_Sans_Devanagari,
  Noto_Sans_Telugu,
} from "next/font/google";
import { dirFor, htmlLang } from "@/i18n/locales";
import { resolveLocale } from "@/i18n/resolve";
import "./globals.css";

// Live Ink type system: a geometric grotesk for display, Inter for body,
// JetBrains Mono for numbers/labels. Exposed as CSS vars bound in globals.css.
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  display: "swap",
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

// ── Script faces for the non-Latin locales ─────────────────────────────────
// The three faces above are Latin-only, so ar / ms-Arab / hi / mr / te were
// rendering in whatever the device happened to substitute. These four give
// each script a designed face; globals.css binds them per `lang`.
//
// `preload: false` IS the loading strategy, and it is load-bearing. Checked
// against next 16.2.9 rather than assumed, because the option names are
// misleading:
//
// · `subsets` does NOT subset the download. getGoogleFontsUrl() builds
//   `css2?family=…&display=…` with no subset parameter at all, so Google
//   returns — and Next self-hosts verbatim — the family's FULL set of
//   per-subset @font-face blocks, each keeping its own `unicode-range`.
//   Font files are therefore chosen by the browser at render time: a face is
//   fetched only when a codepoint inside its range is actually painted in
//   that family. An English reader never touches the Arabic or Telugu woff2.
// · What `subsets` really controls is PRELOADING. findFontFilesInCss() is
//   handed `preload ? subsets : undefined` and only flags matching files for
//   a <link rel="preload">. A preload tag is unconditional — it downloads
//   whether or not the page renders a single glyph of that script — and
//   because these calls live in the ROOT layout it would be emitted on every
//   route for every reader. That, not the @font-face text, is what would
//   make Latin users pay for Arabic. Turning preload off removes it.
// · With preload off, `subsets` is inert (validate-google-font-function-call
//   only reads it on the preload path), so it is omitted rather than left in
//   to imply a subsetting that does not happen.
//
// Cost of doing it this way: ~1KB of extra @font-face declarations in the
// shared stylesheet, and one extra round trip for a script reader, whose face
// is discovered when the text lays out instead of in <head>. `display: swap`
// keeps that text readable meanwhile. It is the smallest penalty available —
// next/font resolves these calls at BUILD time from static arguments, so the
// call itself can never be made conditional on the request's locale.

// Kufi carries the display role. Space Grotesk is a constructed, monolinear
// geometric grotesk, and Kufic is the Arabic script built on the same
// principles — angular, near-uniform stroke weight, historically the script
// of inscriptions and titles. It gives an Arabic headline the same composed,
// faintly technical voice, and it stays where it belongs: Kufi flattens the
// curves naskh relies on to tell letters apart, so it is a display face and
// never a body one.
const notoKufiArabic = Noto_Kufi_Arabic({
  variable: "--font-noto-kufi-arabic",
  preload: false,
  display: "swap",
});

// Naskh-derived and humanist — the body counterpart to Inter, and the face
// that carries running Arabic and Jawi at UI sizes.
const notoSansArabic = Noto_Sans_Arabic({
  variable: "--font-noto-sans-arabic",
  preload: false,
  display: "swap",
});

// Devanagari serves both Hindi and Marathi.
const notoSansDevanagari = Noto_Sans_Devanagari({
  variable: "--font-noto-sans-devanagari",
  preload: false,
  display: "swap",
});

const notoSansTelugu = Noto_Sans_Telugu({
  variable: "--font-noto-sans-telugu",
  preload: false,
  display: "swap",
});

// Every face's variable rides on <html>; declaring one costs nothing but the
// custom property. globals.css decides which of them the `lang` in force
// actually resolves to, and that decision is what keeps the bytes off.
const fontVars = [
  spaceGrotesk.variable,
  inter.variable,
  jetbrainsMono.variable,
  notoKufiArabic.variable,
  notoSansArabic.variable,
  notoSansDevanagari.variable,
  notoSansTelugu.variable,
].join(" ");

export const metadata: Metadata = {
  title: "SketchCast AI",
  description: "Turn a textbook chapter into a narrated lesson, deck and worksheets.",
};

// The document's language and writing direction are decided here, once, for
// every surface — so an Arabic or Jawi reader gets dir="rtl" on <html> and the
// whole tree mirrors through Tailwind 4's logical properties (ps-/pe-/ms-/me-/
// text-start/border-s/…) instead of each component re-deciding. Reading the
// locale is a request-time API (cookie + headers), which opts routes into
// dynamic rendering; the portal is auth-gated and dynamic already, and "/"
// merely redirects to /dashboard, so nothing static is given up.
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await resolveLocale();
  return (
    <html
      lang={htmlLang(locale)}
      dir={dirFor(locale)}
      className={`${fontVars} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
