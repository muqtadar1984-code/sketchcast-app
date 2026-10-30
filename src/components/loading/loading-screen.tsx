"use client";

import Spinner from "./spinner";
import { useLoadingLabel } from "./loading-indicator";

// What a route group's loading.tsx renders while its segment streams in: the
// shared ring, centred in the content area, announcing the localised label the
// root layout resolved for this request. A client component only so it can
// read that label from the provider — loading.tsx itself takes no props.
//
// The ring fades in after the same short delay as the global veil
// (.loading-veil), so a segment that streams in quickly shows nothing.
export default function LoadingScreen() {
  const label = useLoadingLabel();
  return (
    <div className="loading-veil flex min-h-[40vh] flex-1 items-center justify-center py-16" aria-busy="true" data-sk-loading="">
      <Spinner size="lg" label={label} />
    </div>
  );
}
