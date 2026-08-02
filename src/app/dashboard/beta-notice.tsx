"use client";

import { Fragment, useEffect, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";

// Dismissible beta-welcome banner for beta teachers: states the trial's shape
// upfront so limits are expectations, not collisions. localStorage-dismissed.
// The client half of ./beta-banner, which resolves the words server-side.
const KEY = "sc-beta-banner-dismissed";

export default function BetaNotice({
  t,
  dismissLabel,
}: {
  t: Dictionary["app"]["betaBanner"];
  /** The ✕'s accessible name — the shared "Close" from the common slice. */
  dismissLabel: string;
}) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(KEY)) return;
    const t = setTimeout(() => setShow(true), 50); // deferred: avoids setState-in-effect cascades
    return () => clearTimeout(t);
  }, []);

  if (!show) return null;

  // The body is one sentence with the trial's shape emphasised inside it, so it
  // stays ONE message and the emphasis is spliced back in at {trial} — a
  // translator moves the clause, never rebuilds the sentence from fragments.
  const body = t.body.split(/(\{trial\})/);

  return (
    <div className="mb-6 rounded-xl border border-[#BDE8E2] bg-[#E2F4F1] px-4 py-3 flex items-start justify-between gap-3">
      <p className="text-sm text-[#0C8175]">
        <span className="font-medium">{t.welcome}</span>{" "}
        {body.map((piece, i) =>
          piece === "{trial}" ? (
            <span key={i} className="font-medium text-[#14181F]">
              {t.trial}
            </span>
          ) : (
            <Fragment key={i}>{piece}</Fragment>
          ),
        )}{" "}
        <a href="mailto:hello@sketchcast.app" className="underline">hello@sketchcast.app</a>
      </p>
      <button
        onClick={() => {
          localStorage.setItem(KEY, "1");
          setShow(false);
        }}
        aria-label={dismissLabel}
        className="text-[#0C8175] hover:text-[#14181F] text-lg leading-none shrink-0"
      >
        ×
      </button>
    </div>
  );
}
