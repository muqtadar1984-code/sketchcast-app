"use client";

import { useRouter } from "next/navigation";
import { shiftDay } from "./diary/date-nav";

// The TEACHER diary's class picker + day navigator (chips, ‹ › steppers and a
// jump-anywhere date input — needs a client for the input, unlike the parent
// view's pure-link DateNav). Both picks are just URL state (?c= & ?d=): the
// server component refetches the day, so back/forward and shared links all
// land on the right page. `today` comes from the server (school-timezone civil
// date, date-nav's todayKey) so the client never re-derives it in the viewer's
// timezone.

export default function DiaryDay({
  classes,
  classId,
  date,
  today,
}: {
  classes: { id: string; name: string }[];
  classId: string;
  date: string;
  today: string;
}) {
  const router = useRouter();

  function go(cls: string, d: string) {
    router.push(`/dashboard/diary?c=${cls}&d=${d}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-5">
      {classes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {classes.map((cl) => (
            <button
              key={cl.id}
              onClick={() => go(cl.id, date)}
              className={`chip font-sans normal-case tracking-normal ${
                cl.id === classId ? "bg-[#E2F4F1] text-[#0C8175]" : "bg-[#EEF0EC] text-[#5B6470] hover:bg-[#E6E8E4]"
              }`}
            >
              {cl.name}
            </button>
          ))}
        </div>
      )}
      <div className="ml-auto flex items-center gap-2">
        <button onClick={() => go(classId, shiftDay(date, -1))} className="btn-ghost h-9 w-9 text-sm" aria-label="Previous day">
          ←
        </button>
        <input
          type="date"
          value={date}
          onChange={(e) => e.target.value && go(classId, e.target.value)}
          className="field h-9 px-2 text-sm"
          aria-label="Diary day"
        />
        <button onClick={() => go(classId, shiftDay(date, 1))} className="btn-ghost h-9 w-9 text-sm" aria-label="Next day">
          →
        </button>
        {date !== today && (
          <button onClick={() => go(classId, today)} className="text-sm font-medium text-[#0C8175] hover:underline ml-1">
            Today
          </button>
        )}
      </div>
    </div>
  );
}
