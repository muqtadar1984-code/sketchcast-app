// Numeric-aware marking of a fill_blank answer (2026-10-16).
//
// WHY. A maths worksheet's "calculate the circumference" items carry keys like
// "44", "9π", "56.52", "28π"; a student who typed "44", "9pi", "56.52", "28pi"
// (all correct) scored 0/10 until the teacher graded the paper by hand. The
// grader compared strings after trim + lower-case, so "9pi" ≠ "9π", "44 cm" ≠
// "44" and "56.520" ≠ "56.52". This module reads both sides as NUMBERS when
// they are numbers and leaves everything else to the exact match, so no prose
// answer is marked differently than before.
//
// No imports and no ambient state: shared by the route's grader (logic.ts) and
// the teacher's grade list (grade-list.tsx), so the two agree on what is right.

export type Numeric = { value: number; pi: boolean; unit: string | null };

/** A trailing unit: ONE token of letters, degree or percent, optionally
 * squared/cubed. One token, so "3 cats and a dog" is prose, not 3 cats. */
const UNIT = "([a-z°%]+(?:\\^?[23²³])?)?";
/** sign, number, "/den" (fraction), π, "/den" after π (9π/2), unit — with at
 * most one space between parts. */
const NUMERIC = new RegExp(`^([-+]?) ?(\\d+(?:\\.\\d+)?)? ?(?:/ ?(\\d+(?:\\.\\d+)?))? ?(pi)? ?(?:/ ?(\\d+(?:\\.\\d+)?))? ?${UNIT}$`);

/** Read "9π cm²", "9 pi", "22/7", "x = -3", "56.520", "45°" as a number — or
 * null for anything that is not one ("chlorophyll", "cm", "", "two"). A
 * number or a π is required; a unit alone is not a number. */
export function parseNumeric(raw: unknown): Numeric | null {
  let s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/π/g, "pi")
    .replace(/[−–]/g, "-")
    .replace(/[×·*]/g, "")
    .replace(/,(?=\d{3}\b)/g, "") // 1,000
    .replace(/,/g, ".") // 3,5 (decimal comma)
    .replace(/\s+/g, " ");
  s = s.replace(/^[a-z] ?= ?/, "").trim(); // "x = 3"
  if (!s) return null;
  const m = NUMERIC.exec(s);
  if (!m) return null;
  const [, sign, num, den, pi, pden, unit] = m;
  if (num === undefined && !pi) return null;
  if (unit === "pi" || unit === "e") return null;
  let value = num === undefined ? 1 : Number(num);
  if (den !== undefined) {
    const d = Number(den);
    if (!d) return null;
    value /= d;
  }
  if (pden !== undefined) {
    const d = Number(pden);
    if (!d) return null;
    value /= d;
  }
  if (sign === "-") value = -value;
  if (!Number.isFinite(value)) return null;
  return { value, pi: !!pi, unit: unit ? unit.replace(/\^?2$|²$/, "²").replace(/\^?3$|³$/, "³") : null };
}

/** Two numeric readings agree: same π-ness, same unit when BOTH name one
 * (a missing unit on either side is forgiven — "44" for "44 cm"), values
 * equal to a relative 1e-9 (56.52 = 56.520, 22/7 = 3.142857142857143). */
export function numericEqual(a: Numeric, b: Numeric): boolean {
  if (a.pi !== b.pi) return false;
  if (a.unit && b.unit && a.unit !== b.unit) return false;
  return Math.abs(a.value - b.value) <= 1e-9 * Math.max(1, Math.abs(b.value));
}

export const normAnswer = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** Is a fill_blank answer right? The exact match (trim + lower-case) against
 * the key or any `accept` alternative — unchanged for prose — then, only when
 * BOTH the given answer and a key read as numbers, the numeric comparison.
 * A blank never scores. */
export function fillBlankCorrect(key: unknown, accept: readonly unknown[] | undefined, given: unknown): boolean {
  const g = normAnswer(given);
  if (!g) return false;
  const keys = [key, ...(Array.isArray(accept) ? accept : [])];
  const exact = keys.map(normAnswer).filter(Boolean);
  if (exact.includes(g)) return true;
  const gn = parseNumeric(g);
  if (!gn) return false;
  for (const k of keys) {
    const kn = parseNumeric(k);
    if (kn && numericEqual(gn, kn)) return true;
  }
  return false;
}
