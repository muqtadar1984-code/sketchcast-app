"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  layoutTimes,
  minutesToTime,
  timeToMinutes,
  type BreakDef,
  type TimetableShape,
} from "@/utils/timetable";
import { DAY_KEYS, type TimetableMessages } from "./timetable-editor";
import { fmt } from "@/i18n/format";

// Principal-only structure settings. The day's TIMELINE IS DERIVED, never
// hand-typed: P1 starts at school start, every period runs `period length`
// minutes, each break pushes what follows it later, and school end is the
// last period's finish. Change the start or the length and the whole
// schedule re-flows — no way to produce a P2 that starts before P1. What's
// stored (via the settings API, sanitized by shapeFromConfig) is the
// computed times, so the grid and every other page just read them as before.
export default function SettingsPanel({ shape, t }: { shape: TimetableShape; t: TimetableMessages }) {
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
      setErr(t.settings.invalidStart);
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
        setErr(json.error ?? t.settings.saveFailed);
      } else {
        baseline.current = snapshot();
        setMsg(
          json.orphaned ? fmt(t.settings.savedOrphaned, { n: json.orphaned }) : t.settings.saved,
        );
        router.refresh();
      }
    } catch {
      setErr(t.settings.networkError);
    }
    setBusy(false);
  }

  const fieldCls = "field h-9 px-2 text-sm";

  return (
    <div className="card mt-4 p-4 print:hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between text-start">
        <span className="font-medium text-sm">⚙ {t.settings.title}</span>
        <span className="text-xs text-[#5B6470]">{open ? t.hide : t.show}</span>
      </button>
      {open && (
        <div className="mt-3">
          <div className="flex flex-wrap gap-3">
            <label className="text-xs text-[#5B6470]">
              {t.settings.startLabel}
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
              {t.settings.periodLength}
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
              {t.settings.endLabel}
              <input value={computed.end} readOnly disabled className={`${fieldCls} block w-24 mt-1 bg-[#F5F6F3] text-[#5B6470]`} />
            </label>
            <label className="text-xs text-[#5B6470]">
              {t.settings.daysPerWeek}
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
              {t.settings.maxPerDay}
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
          <p className="text-[11px] text-[#98A0A9] mt-2">{fmt(t.settings.computedNote, { min: periodLen })}</p>

          <div className="mt-4">
            <div className="text-xs font-medium text-[#5B6470] mb-1">{t.settings.periods}</div>
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
                  {t.settings.remove}
                </button>
              </div>
            ))}
            {periods.length < 12 && (
              <button
                onClick={() => setPeriods((prev) => [...prev, { label: `P${prev.length + 1}` }])}
                className="text-xs text-[#0C8175] hover:underline"
              >
                {t.settings.addPeriod}
              </button>
            )}
          </div>

          <div className="mt-4">
            <div className="text-xs font-medium text-[#5B6470] mb-1">{t.settings.breaks}</div>
            {breaks.map((b, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 mb-1">
                <input
                  value={b.label}
                  onChange={(e) => setBreaks((prev) => prev.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  placeholder={t.settings.breakPlaceholder}
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
                  title={t.settings.breakLength}
                  className={`${fieldCls} w-20`}
                />
                <label className="text-xs text-[#5B6470] flex items-center gap-1">
                  {t.settings.after}
                  <select
                    value={Math.min(b.afterPeriod, periods.length)}
                    onChange={(e) => setBreaks((prev) => prev.map((x, j) => (j === i ? { ...x, afterPeriod: Number(e.target.value) } : x)))}
                    className={`${fieldCls}`}
                  >
                    <option value={0}>{t.settings.startOfDay}</option>
                    {periods.map((p, pi) => (
                      <option key={pi} value={pi + 1}>
                        {p.label || `P${pi + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
                <button onClick={() => setBreaks((prev) => prev.filter((_, j) => j !== i))} className="text-xs text-[#B42318] hover:underline">
                  {t.settings.remove}
                </button>
              </div>
            ))}
            {breaks.length < 6 && (
              <button
                onClick={() => setBreaks((prev) => [...prev, { label: "", minutes: 15, afterPeriod: 0 }])}
                className="text-xs text-[#0C8175] hover:underline"
              >
                {t.settings.addBreak}
              </button>
            )}
          </div>

          <p className="text-[11px] text-[#98A0A9] mt-3">
            {fmt(t.settings.weekNote, {
              days: DAY_KEYS.slice(0, days)
                .map((k) => t.days[k])
                .join(", "),
            })}
          </p>
          {msg && <p className="text-sm text-[#0C8175] mt-2">{msg}</p>}
          {err && <p className="text-sm text-red-600 mt-2">{err}</p>}
          <div className="mt-3 flex items-center gap-3">
            <button onClick={() => void save()} disabled={busy} className="btn-primary h-10 px-4 text-sm disabled:opacity-50">
              {busy ? t.saving : t.settings.save}
            </button>
            {dirty && !busy && <span className="text-xs text-[#9A6400]">● {t.settings.unsaved}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
