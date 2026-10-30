import LoadingScreen from "@/components/loading/loading-screen";

// Shown while this segment's page streams in — the same ring as the app-wide
// navigation indicator (components/loading), so a wait looks the same on
// every surface. Kept deliberately light: no data, no anchors.
//
// The wrapper marks the whole fallback busy for SK's walkthrough, which treats
// aria-busy="true" / [data-loading] / [data-sk-loading] as "still loading" and waits for the
// real page (and its data-tour targets) rather than pointing at this.
export default function Loading() {
  return (
    <div aria-busy="true" data-loading="" data-sk-loading="" className="contents">
      <LoadingScreen />
    </div>
  );
}
