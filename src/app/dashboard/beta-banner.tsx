"use client";

import { useEffect, useState } from "react";

// Dismissible beta-welcome banner for beta teachers: states the trial's shape
// upfront so limits are expectations, not collisions. localStorage-dismissed.
const KEY = "sc-beta-banner-dismissed";

export default function BetaBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(KEY)) return;
    const t = setTimeout(() => setShow(true), 50); // deferred: avoids setState-in-effect cascades
    return () => clearTimeout(t);
  }, []);

  if (!show) return null;
  return (
    <div className="mb-6 rounded-xl border border-[#BDE8E2] bg-[#E2F4F1] px-4 py-3 flex items-start justify-between gap-3">
      <p className="text-sm text-[#0C8175]">
        <span className="font-medium">Welcome to SketchCast!</span> Your free trial includes{" "}
        <span className="font-medium text-[#14181F]">
          1 book and the full kit — video lesson, plan, activities, worksheet, test paper and case study —
          for one part of one chapter
        </span>
        . Classes, assigning, reviewing, and analytics are all unlimited. Questions?{" "}
        <a href="mailto:hello@sketchcast.app" className="underline">hello@sketchcast.app</a>
      </p>
      <button
        onClick={() => {
          localStorage.setItem(KEY, "1");
          setShow(false);
        }}
        aria-label="Dismiss"
        className="text-[#0C8175] hover:text-[#14181F] text-lg leading-none shrink-0"
      >
        ×
      </button>
    </div>
  );
}
