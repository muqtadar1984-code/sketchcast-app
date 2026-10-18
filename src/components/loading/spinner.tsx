// The one spinning circle every surface uses — the global navigation
// indicator, each route group's loading.tsx, and any button that wants an
// inline ring. One component so the size, stroke and brand colour never drift
// between surfaces.
//
// No "use client": it is plain markup, so a Server Component (a loading.tsx)
// can render it directly and a client one can import it just the same.
//
// ACCESSIBILITY. role="status" is a polite live region, so a screen reader
// says the label when the spinner appears; the label itself is sr-only — the
// ring says it visually. `motion-safe:animate-spin` means the ring turns only
// for readers who have not asked for reduced motion; for the rest it is a
// still ring with the same label, which still says "wait" without moving.
// Pass `label` from the dictionary (`t.common.loading`) wherever the surface
// is localised; the English default is for the English-only portals.

export type SpinnerSize = "sm" | "md" | "lg";

const SIZE: Record<SpinnerSize, string> = {
  sm: "h-4 w-4",
  md: "h-6 w-6",
  lg: "h-10 w-10",
};

export default function Spinner({
  size = "md",
  label = "Loading…",
  className = "",
}: {
  size?: SpinnerSize;
  /** the sr-only announcement — `t.common.loading` on a localised surface */
  label?: string;
  className?: string;
}) {
  return (
    <span role="status" className={`inline-flex shrink-0 items-center justify-center ${className}`}>
      <svg
        className={`${SIZE[size]} motion-safe:animate-spin text-[#1FB8A6]`}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden
      >
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
        <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
