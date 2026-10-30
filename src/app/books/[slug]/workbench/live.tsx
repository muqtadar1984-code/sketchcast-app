"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// While a run is queued or running, the workbench refreshes itself every 10 seconds so stages move on their own.
export default function Live({ on }: { on: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(t);
  }, [on, router]);
  return null;
}
