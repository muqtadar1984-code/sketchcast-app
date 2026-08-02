import type { Metadata } from "next";
import { Space_Grotesk, Inter, JetBrains_Mono } from "next/font/google";
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
      className={`${spaceGrotesk.variable} ${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
