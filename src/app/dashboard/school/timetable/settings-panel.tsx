"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DAY_NAMES, type BreakDef, type TimetableShape } from "@/utils/timetable";

// Principal-only structure settings: school hours, the period list, breaks
// (snack, lunch — label/time/length/position), days per week and the per-day
// teacher limit. Everything is stored in schools.config.timetable via the
// settings API (sanitized server-side by the same parser every page reads
// through), so a typo can't brick the grid — bad fields just fall back.
export default function SettingsPanel({ shape }: { shape: TimetableShape }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(shape.days);
  const [start, setStart] = useState(shape.start ?? "");
  const [end, setEnd] = useState(shape.end ?? "");
  const [maxPerDay, setMaxPerDay] = useState(shape.maxPerTeacherPerDay ?? 6);
  const [periods, setPeriods] = useState(shape.periods.map((p) => ({ label: p.label, time: p.time ?? "" })));
  const [breaks, setBreaks] = useState<BreakDef[]>((shape.breaks ?? []).map((b) => ({ ...b })));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
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
            end,
            maxPerTeacherPerDay: maxPerDay,
            periods: periods.map((p) => ({ label: p.label, time: p.time || undefined })),
            breaks,
          },
        }),
      });
      const json = (await res.json()) as { error?: string; orphaned?: number };
      if (!res.ok) {
        setErr(json.error ?? "Save failed.");
      } else {
        setMsg(
          json.orphaned
            ? `Saved. ⚠ ${json.orphaned} existing lesson(s) now sit outside the new shape (a removed day or period) — grow the shape back or clear them.`
            : "Saved.",
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
              School starts
              <input value={start} onChange={(e) => setStart(e.target.value)} placeholder="07:45" className={`${fieldCls} block w-24 mt-1`} />
            </label>
            <label className="text-xs text-[#5B6470]">
              School ends
              <input value={end} onChange={(e) => setEnd(e.target.value)} placeholder="14:45" className={`${fieldCls} block w-24 mt-1`} />
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

          <div className="mt-4">
            <div className="text-xs font-medium text-[#5B6470] mb-1">Periods</div>
            {periods.map((p, i) => (
              <div key={i} className="flex items-center gap-2 mb-1">
                <input
                  value={p.label}
                  onChange={(e) => setPeriods((prev) => prev.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  className={`${fieldCls} w-24`}
                  maxLength={12}
                />
                <input
                  value={p.time}
                  onChange={(e) => setPeriods((prev) => prev.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)))}
                  placeholder="hh:mm"
                  className={`${fieldCls} w-24`}
                />
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
                onClick={() => setPeriods((prev) => [...prev, { label: `P${prev.length + 1}`, time: "" }])}
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
                <input
                  value={b.time ?? ""}
                  onChange={(e) => setBreaks((prev) => prev.map((x, j) => (j === i ? { ...x, time: e.target.value || undefined } : x)))}
                  placeholder="10:45"
                  className={`${fieldCls} w-20`}
                />
                <input
                  type="number"
                  min={1}
                  max={240}
                  value={b.minutes ?? ""}
                  onChange={(e) =>
                    setBreaks((prev) => prev.map((x, j) => (j === i ? { ...x, minutes: Number(e.target.value) || undefined } : x)))
                  }
                  placeholder="min"
                  className={`${fieldCls} w-20`}
                />
                <label className="text-xs text-[#5B6470] flex items-center gap-1">
                  after
                  <select
                    value={b.afterPeriod}
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
                onClick={() => setBreaks((prev) => [...prev, { label: "", time: undefined, minutes: undefined, afterPeriod: 0 }])}
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
          <div className="mt-3">
            <button onClick={() => void save()} disabled={busy} className="btn-primary h-10 px-4 text-sm disabled:opacity-50">
              {busy ? "Saving…" : "Save settings"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
