"use client";

import { useState } from "react";

// A SketchCast book's cover on the Library's "My books" (moved out of
// my-books-strip.tsx when the strip became a server component). A client
// component only for the fallback: a cover that is missing, or that S3
// refuses, shows the title's first letter instead of a broken image.

export default function MyBookCover({ url, title }: { url: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <div
        data-testid="my-book-cover-fallback"
        aria-hidden="true"
        className="flex h-full w-full items-center justify-center bg-[#E2F4F1] font-display text-3xl text-[#0C8175]"
      >
        {Array.from(title.trim())[0]?.toUpperCase() ?? "📖"}
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- a short-lived presigned S3 link, not an optimisable asset
  return <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" onError={() => setFailed(true)} />;
}
