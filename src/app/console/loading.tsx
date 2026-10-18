import LoadingScreen from "@/components/loading/loading-screen";

// Shown while this segment's page streams in — the same ring as the app-wide
// navigation indicator (components/loading), so a wait looks the same on
// every surface.
export default function Loading() {
  return <LoadingScreen />;
}
