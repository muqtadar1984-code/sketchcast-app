// Where a QUEUED job stands in line, and roughly when it starts — pure logic.
//
// Sara's Sci 7 (2026-10-22): ~250 kits sat "queued" for up to 143 min with no
// position and no estimate; etaLabel only ever spoke once a job was
// processing. This turns a silent chip into "37 ahead · ~40 min".
//
// Position is FIFO over every queued job (the worker claims oldest-first
// today). When fair-share claiming lands the real order changes — swap the
// `ahead` computation here, not at call sites. The estimate divides by the
// MEASURED finish rate of the last hour, never a constant: a burst slows the
// rate and the estimate has to say so.

export type QueueSpot = { ahead: number; etaMin: number };

/** ISO timestamp `min` minutes ago — the window start for a finish-rate count. */
export function isoMinutesAgo(min: number, now: number = Date.now()): string {
  return new Date(now - min * 60_000).toISOString();
}

/** Jobs finished per minute, from a count over a window. Floors at 0.2/min so
 *  a quiet hour (nothing finished, nothing to measure) can't divide by zero
 *  into an infinite estimate. */
export function finishRate(finishedInWindow: number, windowMin: number): number {
  const r = windowMin > 0 ? finishedInWindow / windowMin : 0;
  return Math.max(0.2, r);
}

/** How many queued jobs were created before `createdAt` (ISO strings sort). */
export function aheadOf(createdAt: string, queuedCreatedAts: readonly string[]): number {
  let n = 0;
  for (const c of queuedCreatedAts) if (c < createdAt) n++;
  return n;
}

/** Position + minutes until it STARTS (jobs ahead / finish rate), ≥ 1. */
export function queueSpot(createdAt: string, queuedCreatedAts: readonly string[], ratePerMin: number): QueueSpot {
  const ahead = aheadOf(createdAt, queuedCreatedAts);
  const etaMin = Math.max(1, Math.ceil(ahead / Math.max(0.2, ratePerMin)));
  return { ahead, etaMin };
}

/** "~40 min" / "~2 h" / "~2 h 15 min" — whole numbers, no false precision. */
export function etaText(etaMin: number, t: { minutes: string; hours: string; hoursMinutes: string }): string {
  if (etaMin < 60) return t.minutes.replace("{n}", String(etaMin));
  const h = Math.floor(etaMin / 60);
  const m = Math.round((etaMin % 60) / 5) * 5;
  if (m === 0 || m === 60) return t.hours.replace("{h}", String(m === 60 ? h + 1 : h));
  return t.hoursMinutes.replace("{h}", String(h)).replace("{m}", String(m));
}
