import type { CSSProperties } from "react";

// The brand's signature: hand-drawn strokes that draw on via stroke-dashoffset
// (the .ink-draw class in globals.css; it renders statically under reduced motion).

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

// A short hand-drawn arrow — for sequences / "next" cues.
export function InkArrow({ className, color = "#1FB8A6", delay = 0.2 }: MarkProps) {
  return (
    <svg viewBox="0 0 64 28" fill="none" aria-hidden className={className}>
      <path
        d="M3 15 C 22 9, 40 19, 56 13"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        className="ink-draw"
        style={{ "--ink-len": 80, "--ink-delay": `${delay}s` } as CSSProperties}
      />
      <path
        d="M48 7 L 58 13 L 49 20"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="ink-draw"
        style={{ "--ink-len": 40, "--ink-delay": `${delay + 0.35}s` } as CSSProperties}
      />
    </svg>
  );
}

// A loose circle drawn around emphasis.
export function InkCircle({ className, color = "#FFB020", delay = 0.2 }: MarkProps) {
  return (
    <svg viewBox="0 0 120 60" preserveAspectRatio="none" fill="none" aria-hidden className={className}>
      <path
        d="M60 5 C 104 5, 116 22, 113 32 C 110 50, 70 56, 46 55 C 14 53, 5 38, 9 26 C 13 11, 40 5, 70 6"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        className="ink-draw"
        style={{ "--ink-len": 360, "--ink-delay": `${delay}s` } as CSSProperties}
      />
    </svg>
  );
}
