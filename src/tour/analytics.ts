import type { TourEvent } from "./types";

// The single swappable telemetry seam. Today it posts to /api/tour/event, which
// records to the `tour_events` table (the app logs product events to Postgres —
// there is no analytics SDK). To move to PostHog/etc. later, change ONLY this
// function; every call site stays the same. Never throws — telemetry must never
// break the product.
export function emitTourEvent(evt: TourEvent): void {
  try {
    const body = JSON.stringify(evt);
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon("/api/tour/event", new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch("/api/tour/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    });
  } catch {
    /* best-effort */
  }
}
