"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// While any lesson is queued/processing, re-fetch the dashboard so status
// and download links update without a manual refresh.
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
