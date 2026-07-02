import type { CSSProperties } from "react";

// The brand's signature: hand-drawn strokes that draw on via stroke-dashoffset
// (the .ink-draw class in globals.css; it renders statically under reduced motion).
// (InkArrow / InkCircle variants lived here too — removed as unused; git history
// has them if a drawn arrow or emphasis circle is ever needed again.)

type MarkProps = { className?: string; color?: string; delay?: number };

// A wobbly underline. Stretches to its container width (preserveAspectRatio none),
// so place it under a heading with `w-full`.
export function InkUnderline({ className, color = "#1FB8A6", delay = 0.15 }: MarkProps) {
  return (
    <svg viewBox="0 0 240 12" preserveAspectRatio="none" fill="none" aria-hidden className={className}>
      <path
        d="M3 8 C 46 3, 96 11, 150 6 S 214 4, 237 7"
        stroke={color}
        strokeWidth="3.5"
        strokeLinecap="round"
        className="ink-draw"
        style={{ "--ink-len": 290, "--ink-delay": `${delay}s` } as CSSProperties}
      />
    </svg>
  );
}
