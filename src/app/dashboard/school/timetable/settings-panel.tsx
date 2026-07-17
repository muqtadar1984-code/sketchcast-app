"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DAY_NAMES,
  layoutTimes,
  minutesToTime,
  timeToMinutes,
  type BreakDef,
  type TimetableShape,
} from "@/utils/timetable";

// Principal-only structure settings. The day's TIMELINE IS DERIVED, never
// hand-typed: P1 starts at school start, every period runs `period length`
// minutes, each break pushes what follows it later, and school end is the
// last period's finish. Change the start or the length and the whole
// schedule re-flows — no way to produce a P2 that starts before P1. What's
// stored (via the settings API, sanitized by shapeFromConfig) is the
// computed times, so the grid and every other page just read them as before.
export default function SettingsPanel({ shape }: { shape: TimetableShape }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(shape.days);
  const [start, setStart] = useState(shape.start ?? "07:45");
  const [periodLen, setPeriodLen] = useState(shape.periodMinutes ?? 45);
  const [maxPerDay, setMaxPerDay] = useState(shape.maxPerTeacherPerDay ?? 6);
  const [periods, setPeriods] = useState(shape.periods.map((p) => ({ label: p.label })));
  const [breaks, setBreaks] = useState<{ label: string; minutes: number; afterPeriod: number }[]>(
    (shape.breaks ?? []).map((b) => ({ label: b.label, minutes: b.minutes ?? 15, afterPeriod: b.afterPeriod })),
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The last COMMITTED start (minutes) — the anchor while the field is mid-edit.
  const startBase = useRef(timeToMinutes(shape.start ?? "07:45") ?? 465);

  // The whole timeline, derived. While the start field is mid-typing
  // (invalid), the last committed value anchors the preview.
  const computed = useMemo(() => {
    const anchor = timeToMinutes(start) ?? startBase.current;
    return layoutTimes(anchor, periodLen, periods.length, breaks as BreakDef[]);
  }, [start, periodLen, periods.length, breaks]);

  function commitStart() {
    const next = timeToMinutes(start);
    if (next === null) {
      setStart(minutesToTime(startBase.current)); // revert half-typed input
      return;
    }
    startBase.current = next;
    setStart(minutesToTime(next)); // normalize "8:50" → "08:50"
  }

  // Unsaved-changes tracking: nothing here touches the timetable until Save.
  const snapshot = () => JSON.stringify({ days, start, periodLen, maxPerDay, periods, breaks });
  const baseline = useRef<string>("");
  if (!baseline.current) baseline.current = snapshot();
  const dirty = snapshot() !== baseline.current;

  async function save() {
    if (timeToMinutes(start) === null) {
      setErr("School start time isn't a valid hh:mm time.");
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch("/api/timetable/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timetable: {
            days,
            start,
            end: computed.end,
            periodMinutes: periodLen,
            maxPerTeacherPerDay: maxPerDay,
            periods: periods.map((p, i) => ({ label: p.label, time: computed.periodTimes[i] })),
            breaks: breaks.map((b, i) => ({ ...b, time: computed.breakTimes[i] || undefined })),
          },
        }),
      });
      const json = (await res.json()) as { error?: string; orphaned?: number };
      if (!res.ok) {
        setErr(json.error ?? "Save failed.");
      } else {
        baseline.current = snapshot();
        setMsg(
          json.orphaned
            ? `Saved. ⚠ ${json.orphaned} existing lesson(s) now sit outside the new shape (a removed day or period) — grow the shape back or clear them.`
            : "Saved — the timetable now shows the new times.",
        );
        router.refresh();
      }
    } catch {
      setErr("Network error — nothing saved.");
    }
    setBusy(false);
  }

  const fieldCls = "field h-9 px-2 text-sm";

  return (
    <div className="card mt-4 p-4 print:hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between text-left">
        <span className="font-medium text-sm">⚙ Timetable settings (hours, breaks, periods)</span>
        <span className="text-xs text-[#5B6470]">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="mt-3">
          <div className="flex flex-wrap gap-3">
            <label className="text-xs text-[#5B6470]">
              School starts (= Period 1)
              <input
                value={start}
                onChange={(e) => setStart(e.target.value)}
                onBlur={commitStart}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitStart();
                }}
                placeholder="07:45"
                className={`${fieldCls} block w-24 mt-1`}
              />
            </label>
            <label className="text-xs text-[#5B6470]">
              Period length (min)
              <input
                type="number"
                min={5}
                max={240}
                value={periodLen}
                onChange={(e) => setPeriodLen(Math.floor(Math.max(5, Math.min(240, Number(e.target.value) || 45))))}
                className={`${fieldCls} block w-24 mt-1`}
              />
            </label>
            <label className="text-xs text-[#5B6470]">
              School ends
              <input value={computed.end} readOnly disabled className={`${fieldCls} block w-24 mt-1 bg-[#F5F6F3] text-[#5B6470]`} />
            </label>
            <label className="text-xs text-[#5B6470]">
              Days / week
              <input
                type="number"
                min={1}
                max={7}
                value={days}
                onChange={(e) => setDays(Math.max(1, Math.min(7, Number(e.target.value) || 5)))}
                className={`${fieldCls} block w-20 mt-1`}
              />
            </label>
            <label className="text-xs text-[#5B6470]">
              Max lessons / teacher / day
              <input
                type="number"
                min={1}
                max={12}
                value={maxPerDay}
                onChange={(e) => setMaxPerDay(Math.max(1, Math.min(12, Number(e.target.value) || 6)))}
                className={`${fieldCls} block w-20 mt-1`}
              />
            </label>
          </div>
          <p className="text-[11px] text-[#98A0A9] mt-2">
            All times are computed: Period 1 starts when school starts, each period runs {periodLen} minutes,
            and every break pushes the rest of the day later. School ends when the last period does.
          </p>

          <div className="mt-4">
            <div className="text-xs font-medium text-[#5B6470] mb-1">Periods</div>
            {periods.map((p, i) => (
              <div key={i} className="flex items-center gap-2 mb-1">
                <input
                  value={p.label}
                  onChange={(e) => setPeriods((prev) => prev.map((x, j) => (j === i ? { label: e.target.value } : x)))}
                  className={`${fieldCls} w-24`}
                  maxLength={12}
                />
                <span className="w-16 text-sm text-[#5B6470] tabular-nums">{computed.periodTimes[i]}</span>
                <button
                  onClick={() => setPeriods((prev) => prev.filter((_, j) => j !== i))}
                  disabled={periods.length <= 1}
                  className="text-xs text-[#B42318] hover:underline disabled:opacity-30"
                >
                  Remove
                </button>
              </div>
            ))}
            {periods.length < 12 && (
              <button
                onClick={() => setPeriods((prev) => [...prev, { label: `P${prev.length + 1}` }])}
                className="text-xs text-[#0C8175] hover:underline"
              >
                + Add period
              </button>
            )}
          </div>

          <div className="mt-4">
            <div className="text-xs font-medium text-[#5B6470] mb-1">Breaks</div>
            {breaks.map((b, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 mb-1">
                <input
                  value={b.label}
                  onChange={(e) => setBreaks((prev) => prev.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  placeholder="Snack break"
                  className={`${fieldCls} w-32`}
                  maxLength={40}
                />
                <span className="w-14 text-sm text-[#5B6470] tabular-nums">{computed.breakTimes[i]}</span>
                <input
                  type="number"
                  min={1}
                  max={240}
                  value={b.minutes}
                  onChange={(e) =>
                    setBreaks((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, minutes: Math.max(1, Math.min(240, Number(e.target.value) || 15)) } : x)),
                    )
                  }
                  title="Break length (minutes)"
                  className={`${fieldCls} w-20`}
                />
                <label className="text-xs text-[#5B6470] flex items-center gap-1">
                  after
                  <select
                    value={Math.min(b.afterPeriod, periods.length)}
                    onChange={(e) => setBreaks((prev) => prev.map((x, j) => (j === i ? { ...x, afterPeriod: Number(e.target.value) } : x)))}
                    className={`${fieldCls}`}
                  >
                    <option value={0}>start of day</option>
                    {periods.map((p, pi) => (
                      <option key={pi} value={pi + 1}>
                        {p.label || `P${pi + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
                <button onClick={() => setBreaks((prev) => prev.filter((_, j) => j !== i))} className="text-xs text-[#B42318] hover:underline">
                  Remove
                </button>
              </div>
            ))}
            {breaks.length < 6 && (
              <button
                onClick={() => setBreaks((prev) => [...prev, { label: "", minutes: 15, afterPeriod: 0 }])}
                className="text-xs text-[#0C8175] hover:underline"
              >
                + Add break
              </button>
            )}
          </div>

          <p className="text-[11px] text-[#98A0A9] mt-3">
            Week: {DAY_NAMES.slice(0, days).join(", ")}. Removing periods or days never deletes lessons — anything
            stranded outside the new shape is reported so you can tidy up.
          </p>
          {msg && <p className="text-sm text-[#0C8175] mt-2">{msg}</p>}
          {err && <p className="text-sm text-red-600 mt-2">{err}</p>}
          <div className="mt-3 flex items-center gap-3">
            <button onClick={() => void save()} disabled={busy} className="btn-primary h-10 px-4 text-sm disabled:opacity-50">
              {busy ? "Saving…" : "Save settings"}
            </button>
            {dirty && !busy && (
              <span className="text-xs text-[#9A6400]">● Unsaved changes — the timetable updates after you save</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
