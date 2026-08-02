"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LOCALES, isLocale, type Locale } from "@/i18n/locales";
import type { Dictionary } from "@/i18n/dictionaries";

// The interface-language picker, in the header beside the hat switcher.
//
// Every option is written in ITS OWN language (the labels come from the LOCALES
// registry, deliberately untranslated): this is the one control in the app a
// reader has to be able to find WITHOUT already understanding the language it
// is currently showing. Hence a plain native <select> — it is keyboard- and
// screen-reader-native, and on a phone it opens the OS list, which is where a
// parent's own language already reads correctly.
//
// The POST is what makes the choice DURABLE (the sc_locale cookie, plus
// profiles.ui_locale when there's a session — see /api/locale). The refresh is
// what makes it VISIBLE: every string is resolved on the server, so
// re-rendering the tree in place IS the translation. No navigation, so the
// reader stays on the page — and at the scroll position — they were already on.
//
// The type import is type-only, so the server-only dictionary module is erased
// here and never reaches the browser bundle.
export default function LanguageSwitcher({ locale, t }: { locale: Locale; t: Dictionary["common"] }) {
  const router = useRouter();
  // The optimistic pick: the picker must read in the NEW language the instant
  // it is chosen, not a round trip later. Cleared only if the write fails.
  const [pick, setPick] = useState<Locale | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const busy = saving || refreshing;
  const current = pick ?? locale;

  async function change(next: string) {
    if (!isLocale(next) || next === current || busy) return;
    setSaving(true);
    setFailed(false);
    setPick(next);
    try {
      const res = await fetch("/api/locale", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale: next }),
      });
      if (res.ok) {
        // The transition keeps the control disabled until the re-rendered
        // server tree actually lands, so a second pick can't race the first.
        startRefresh(() => router.refresh());
        setSaving(false);
        return;
      }
    } catch {
      /* offline, or the route is down — fall through and say so */
    }
    setPick(null);
    setFailed(true);
    setSaving(false);
  }

  return (
    <>
      <label className="flex items-center gap-1.5 text-sm">
        <span aria-hidden>🌐</span>
        <select
          value={current}
          disabled={busy}
          onChange={(e) => void change(e.target.value)}
          aria-label={t.chooseLanguage}
          aria-invalid={failed || undefined}
          title={failed ? t.languageChangeFailed : t.language}
          className={`h-9 w-[6.5rem] sm:w-[9.5rem] truncate rounded-lg border bg-white px-2 text-sm text-[#14181F] disabled:opacity-50 ${
            failed ? "border-[#B42318]" : "border-[#E6E8E4]"
          }`}
        >
          {LOCALES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      {/* Announced, not shown: the failure has to reach a screen reader, and the
          live region must already exist for it to be spoken. sr-only is
          position:absolute, so it is not a flex item and moves nothing. */}
      <span role="status" aria-live="polite" className="sr-only">
        {failed ? t.languageChangeFailed : ""}
      </span>
    </>
  );
}
