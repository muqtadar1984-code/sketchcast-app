"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// While work is in flight, re-fetch the SERVER page so status, progress and
// download links update without a manual refresh; the interval is torn down
// the moment `active` goes false, so an idle page costs nothing.
//
// Lives in components/ rather than under one feature because two of them use
// it: the teacher dashboard (a lesson building) and the catalogue library (an
// article or a kit building). It renders nothing.
export default function AutoRefresh({
  active,
  seconds = 6,
}: {
  active: boolean;
  seconds?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [active, seconds, router]);
  return null;
}
