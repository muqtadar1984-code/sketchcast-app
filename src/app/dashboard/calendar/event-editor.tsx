"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

export type EditorClass = { id: string; name: string };
export type EditableEvent = {
  id: string;
  class_id: string | null;
  title: string;
  description: string | null;
  location: string | null;
  kind: string;
  audience: string;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
};

const KINDS = ["meeting", "exam", "holiday", "activity", "pd", "other"] as const;
const AUDIENCES: { value: string; label: string }[] = [
  { value: "staff", label: "Staff only" },
  { value: "school", label: "Whole school (incl. students & parents)" },
  { value: "leadership", label: "Leadership only" },
  { value: "class", label: "One class" },
];

// Times are entered and shown in SCHOOL time (Malaysia, fixed UTC+8, no DST) —
// never the browser's zone, or an admin travelling abroad would silently save
// shifted times that every on-site viewer sees wrong.
const TZ_OFFSET_MS = 8 * 3600000;

// Stored instant → "YYYY-MM-DDTHH:mm" school wall time (datetime-local value).
function toSchoolInput(iso: string): string {
  return new Date(new Date(iso).getTime() + TZ_OFFSET_MS).toISOString().slice(0, 16);
}
// School wall time input → stored instant.
function fromSchoolInput(input: string): string {
  return new Date(`${input}:00.000+08:00`).toISOString();
}

// Create or edit one calendar event. Writes go straight through the browser
// client — the RLS policies (0043) are the authorization: admins manage any
// native event in their school, teachers only 'class' events for classes they
// own. A denied write surfaces as an error, never a silent success.
export default function EventEditor({
  schoolId,
  isAdmin,
  classes,
  userId,
  existing,
}: {
  schoolId: string;
  isAdmin: boolean;
  classes: EditorClass[];
  userId: string;
  existing?: EditableEvent;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState(existing?.title ?? "");
  const [kind, setKind] = useState(existing?.kind ?? "meeting");
  const [audience, setAudience] = useState(existing?.audience ?? (isAdmin ? "staff" : "class"));
  const [classId, setClassId] = useState(existing?.class_id ?? classes[0]?.id ?? "");
  const [allDay, setAllDay] = useState(existing?.all_day ?? false);
  // All-day rows hold UTC-midnight civil dates — read the date straight off the
  // ISO string; timed rows convert the instant to school wall time.
  const initInput = (iso: string) => (existing?.all_day ? `${iso.slice(0, 10)}T00:00` : toSchoolInput(iso));
  const [start, setStart] = useState(existing ? initInput(existing.starts_at) : "");
  const [end, setEnd] = useState(existing?.ends_at ? initInput(existing.ends_at) : "");
  const [location, setLocation] = useState(existing?.location ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim() || !start) {
      setError("A title and a start time are required.");
      return;
    }
    const aud = isAdmin ? audience : "class";
    if (aud === "class" && !classId) {
      setError("Pick a class for a class event.");
      return;
    }
    setBusy(true);
    const supabase = createClient();
    // All-day events are CIVIL dates — stored as UTC midnight of that date so
    // the day survives every timezone. Timed events are SCHOOL time (+08:00).
    const toIso = (v: string) => (allDay ? `${v.slice(0, 10)}T00:00:00.000Z` : fromSchoolInput(v));
    const row = {
      school_id: schoolId,
      class_id: aud === "class" ? classId : null,
      title: title.trim(),
      description: description.trim() || null,
      location: location.trim() || null,
      kind,
      audience: aud,
      starts_at: toIso(start),
      ends_at: end ? toIso(end) : null,
      all_day: allDay,
    };
    const q = existing
      ? supabase.from("school_events").update(row).eq("id", existing.id).select("id")
      : supabase.from("school_events").insert({ ...row, created_by: userId }).select("id");
    const { data, error: err } = await q;
    setBusy(false);
    if (err || !data?.length) {
      setError(err?.message || "You can't save this event (check the audience/class).");
      return;
    }
    setOpen(false);
    router.refresh();
  }

  async function remove() {
    if (!existing) return;
    setBusy(true);
    const supabase = createClient();
    // .select() so an RLS-filtered no-op (0 rows) reads as failure, not success.
    const { data, error: err } = await supabase.from("school_events").delete().eq("id", existing.id).select("id");
    setBusy(false);
    if (err || !data?.length) {
      setError(err?.message || "You can't delete this event.");
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      {existing ? (
        <button onClick={() => setOpen(true)} className="btn-ghost h-8 px-2.5 text-xs">
          Edit
        </button>
      ) : (
        <button onClick={() => setOpen(true)} className="btn-primary h-10 px-4 text-sm">
          Add event
        </button>
      )}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <form
            onSubmit={save}
            onClick={(e) => e.stopPropagation()}
            className="card w-full max-w-md p-6 space-y-3 max-h-[90vh] overflow-y-auto"
          >
            <h2 className="text-lg">{existing ? "Edit event" : "New event"}</h2>
            <input
              required
              placeholder="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="field w-full h-10 px-3 text-sm"
              maxLength={120}
            />
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-[#5B6470]">
                Type
                <select value={kind} onChange={(e) => setKind(e.target.value)} className="field w-full h-10 px-2 text-sm mt-1">
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k === "pd" ? "PD / training" : k[0].toUpperCase() + k.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-[#5B6470]">
                Who sees it
                {isAdmin ? (
                  <select value={audience} onChange={(e) => setAudience(e.target.value)} className="field w-full h-10 px-2 text-sm mt-1">
                    {AUDIENCES.map((a) => (
                      <option key={a.value} value={a.value}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="field w-full h-10 px-3 text-sm mt-1 flex items-center bg-[#F5F6F3]">One class</div>
                )}
              </label>
            </div>
            {(isAdmin ? audience === "class" : true) && (
              <label className="text-xs text-[#5B6470] block">
                Class
                <select value={classId} onChange={(e) => setClassId(e.target.value)} className="field w-full h-10 px-2 text-sm mt-1">
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex items-center gap-2 text-sm text-[#5B6470]">
              <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
              All-day
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-[#5B6470]">
                Starts {allDay ? "" : "(school time, MYT)"}
                <input
                  required
                  type={allDay ? "date" : "datetime-local"}
                  value={allDay ? start.slice(0, 10) : start}
                  onChange={(e) => setStart(allDay ? `${e.target.value}T00:00` : e.target.value)}
                  className="field w-full h-10 px-2 text-sm mt-1"
                />
              </label>
              <label className="text-xs text-[#5B6470]">
                Ends (optional)
                <input
                  type={allDay ? "date" : "datetime-local"}
                  value={allDay ? end.slice(0, 10) : end}
                  onChange={(e) => setEnd(e.target.value ? (allDay ? `${e.target.value}T00:00` : e.target.value) : "")}
                  className="field w-full h-10 px-2 text-sm mt-1"
                />
              </label>
            </div>
            <input
              placeholder="Location (optional)"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="field w-full h-10 px-3 text-sm"
              maxLength={120}
            />
            <textarea
              placeholder="Details (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="field w-full px-3 py-2 text-sm min-h-[70px]"
              maxLength={1000}
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex items-center justify-between pt-1">
              {existing ? (
                <button type="button" onClick={() => void remove()} disabled={busy} className="text-sm text-[#B42318] hover:underline">
                  Delete
                </button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setOpen(false)} className="btn-ghost h-10 px-4 text-sm">
                  Cancel
                </button>
                <button type="submit" disabled={busy} className="btn-primary h-10 px-4 text-sm disabled:opacity-50">
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
