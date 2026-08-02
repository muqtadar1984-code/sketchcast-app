"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// The PUBLISHING surface for school notices (0068) — the principal's and the
// coordinators' card. A notice IS a calendar event with an announcement's
// clothes on (a link, a deadline, a pin, an importance mark), which is why this
// lives beside event-editor.tsx: same table, same RLS, different intent.
//
// Two audiences only, in plain words. Everything a publisher chooses here has a
// consequence for somebody's evening, so the card states that consequence in a
// live line under the choice instead of hiding it in a tooltip:
//   Staff only            → staff are asked to confirm they have read it
//   Everyone + important  → parents are asked to acknowledge
//   Everyone (normal)     → it just appears, nobody is chased
//
// Writes go through POST /api/notices (not the browser client like
// event-editor) because the shaping rules — https-only links, a deadline that
// can't fall after its own event, a self-expiring pin — belong on the server
// where they can't be skipped. RLS remains the authority on who may publish.
//
// Gate the render at the CALL SITE; this component assumes it is allowed to be
// on screen. Its one call site is dashboard/calendar/page.tsx, which shows it
// to the school_admin and to coordinators — coordinators being the people
// HOLDING coordinator_scope rows, not the ones whose profiles.role happens to
// say "coordinator" (a real coordinator's role reads "teacher"). RLS
// (se_admin_write / se_coordinator_write) remains the actual authority; this
// gate only keeps a card off screens that could never use it.

const AUDIENCES = [
  { value: "school", label: "Everyone (teachers, parents, students)" },
  { value: "staff", label: "Staff only" },
] as const;

const KINDS = ["meeting", "exam", "holiday", "activity", "pd", "other"] as const;

// Dates are entered in SCHOOL time (Malaysia, fixed UTC+8, no DST) — never the
// browser's zone, or a principal writing from abroad would set a deadline every
// on-site reader sees shifted. Kept in step with calendar/event-editor.tsx
// rather than imported from it: that module is a component file.
const TZ_OFFSET_MS = 8 * 3600000;

/** School wall time ("YYYY-MM-DDTHH:mm") → stored instant. */
function fromSchoolInput(input: string): string {
  return new Date(`${input}:00.000+08:00`).toISOString();
}
/** Civil (UTC+8) date key n days from now: "2026-08-09". */
function schoolDayFromNow(days: number): string {
  return new Date(Date.now() + TZ_OFFSET_MS + days * 86400000).toISOString().slice(0, 10);
}

export default function NoticeComposer() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [audience, setAudience] = useState<string>("school");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<string>("other");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [actionBy, setActionBy] = useState("");
  const [actionLabel, setActionLabel] = useState("");
  const [important, setImportant] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pinUntil, setPinUntil] = useState(schoolDayFromNow(7));

  // The live consequence line. Staff notices ALWAYS seek a confirmation;
  // Everyone notices only when they are marked important — otherwise nobody is
  // asked for anything and the card says so, so "important" stays meaningful.
  const consequence =
    audience === "staff"
      ? "Staff will be asked to confirm they have read it."
      : important
        ? "Parents will be asked to acknowledge. It also appears in each child's diary day."
        : "It appears on dashboards and in each child's diary day. Nobody is asked to acknowledge.";

  function reset() {
    setTitle("");
    setBody("");
    setLinkUrl("");
    setLinkLabel("");
    setStartsAt("");
    setActionBy("");
    setActionLabel("");
    setImportant(false);
    setPinned(false);
    setPinUntil(schoolDayFromNow(7));
  }

  async function publish() {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/notices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        body: body.trim() || undefined,
        audience,
        kind,
        link_url: linkUrl.trim() || undefined,
        link_label: linkLabel.trim() || undefined,
        startsAt: startsAt ? fromSchoolInput(startsAt) : undefined,
        actionBy: actionBy ? fromSchoolInput(actionBy) : undefined,
        actionLabel: actionLabel.trim() || undefined,
        importance: important ? "important" : "normal",
        // A pin runs to the END of the chosen school day — "until Friday" means
        // Friday, not Friday morning.
        featuredUntil: pinned && pinUntil ? fromSchoolInput(`${pinUntil}T23:59`) : undefined,
      }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "Could not publish the notice.");
      return;
    }
    reset();
    setDone(true);
    setTimeout(() => setDone(false), 1800);
    router.refresh(); // the notice appears in the calendar and on dashboards
  }

  return (
    <div className="card p-5 mb-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display font-medium">Publish a notice</h2>
          <p className="text-sm text-[#5B6470] mt-0.5">
            One announcement to the whole school or to the staff room — with a link, a deadline, or both.
          </p>
        </div>
        {!open && (
          <button onClick={() => setOpen(true)} className="btn-primary h-9 px-4 text-sm shrink-0">
            Write a notice
          </button>
        )}
      </div>

      {open && (
        <div className="mt-4 space-y-3">
          {/* ── Who it reaches, and what that costs them ─────────────────── */}
          <div>
            <div className="flex flex-wrap gap-1.5">
              {AUDIENCES.map((a) => (
                <button
                  key={a.value}
                  type="button"
                  onClick={() => setAudience(a.value)}
                  className={`chip font-sans normal-case tracking-normal ${
                    audience === a.value
                      ? "bg-[#E2F4F1] text-[#0C8175]"
                      : "bg-white border border-[#E6E8E4] text-[#5B6470] hover:bg-[#F5F6F3]"
                  }`}
                >
                  {a.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-[#5B6470] mt-1.5">{consequence}</p>
          </div>

          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title — e.g. Sports Day, 12 September"
            maxLength={120}
            className="field w-full h-10 px-3 text-sm"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="What people need to know. Keep it short — the details can live behind the link."
            className="field w-full px-3 py-2 text-sm"
          />

          {/* ── The link (https only — the server refuses anything else) ──── */}
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_180px] gap-2">
            <input
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="Link (optional) — https://…"
              maxLength={500}
              inputMode="url"
              className="field w-full h-10 px-3 text-sm"
            />
            <input
              value={linkLabel}
              onChange={(e) => setLinkLabel(e.target.value)}
              placeholder="Button text — Register"
              maxLength={60}
              className="field w-full h-10 px-3 text-sm"
            />
          </div>

          {/* ── The two clocks ────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="text-xs text-[#5B6470]">
              Happens on (school time, optional)
              <input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                className="field w-full h-10 px-2 text-sm mt-1"
              />
            </label>
            <label className="text-xs text-[#5B6470]">
              Action needed by (optional)
              <input
                type="datetime-local"
                value={actionBy}
                onChange={(e) => setActionBy(e.target.value)}
                className="field w-full h-10 px-2 text-sm mt-1"
              />
            </label>
          </div>
          {actionBy && (
            <input
              value={actionLabel}
              onChange={(e) => setActionLabel(e.target.value)}
              placeholder="What to call the deadline — Register by, Pay by, Reply by"
              maxLength={40}
              className="field w-full h-10 px-3 text-sm"
            />
          )}
          <p className="text-xs text-[#98A0A9]">
            The countdown shows the deadline first, then switches to the event date once the deadline passes. A notice
            can have just one of the two.
          </p>

          {/* ── Marks: importance, and the self-expiring banner pin ───────── */}
          <label className="flex items-center gap-1.5 text-sm text-[#5B6470]">
            <input
              type="checkbox"
              checked={important}
              onChange={(e) => setImportant(e.target.checked)}
              className="accent-[#0C8175]"
            />
            Mark important
            <span className="text-xs text-[#98A0A9]">
              — {audience === "staff" ? "stands out in the staff list" : "asks parents to acknowledge"}
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-1.5 text-sm text-[#5B6470]">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={pinned}
                onChange={(e) => setPinned(e.target.checked)}
                className="accent-[#0C8175]"
              />
              Feature this on dashboards until
            </label>
            <input
              type="date"
              value={pinUntil}
              onChange={(e) => setPinUntil(e.target.value)}
              disabled={!pinned}
              className="field h-9 px-2 text-sm disabled:opacity-50"
            />
            <span className="text-xs text-[#98A0A9]">— the pin lets go on its own; three notices show at most.</span>
          </div>

          <label className="text-xs text-[#5B6470] block">
            Type
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="field h-10 px-2 text-sm mt-1 ms-2">
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k === "pd" ? "PD / training" : k[0].toUpperCase() + k.slice(1)}
                </option>
              ))}
            </select>
          </label>

          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
              className="btn-ghost h-9 px-4 text-sm"
            >
              Cancel
            </button>
            <button onClick={publish} disabled={busy || !title.trim()} className="btn-primary h-9 px-4 text-sm">
              {done ? "Published ✓" : busy ? "Publishing…" : "Publish notice"}
            </button>
          </div>
        </div>
      )}
      {!open && done && <p className="text-xs text-[#0C8175] mt-2">Published ✓</p>}
    </div>
  );
}

// ── Revoke ────────────────────────────────────────────────────────────────────
// The principal's withdrawal, with the same inline two-tap confirm shape as
// DeleteStudentButton — and confirm copy that states the reach, because a
// notice has already travelled further than the app by the time anyone regrets
// it (dashboards, the diary, and every calendar that subscribed to the feed).
// Lives in this file rather than its own so the notices client surface stays
// one module; the school-admin review block imports it.
export function RevokeNoticeButton({ eventId, title }: { eventId: string; title: string }) {
  const router = useRouter();
  const [stage, setStage] = useState<"idle" | "confirm" | "busy">("idle");
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    setStage("busy");
    setError(null);
    const res = await fetch("/api/notices/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(json.error ?? "Could not withdraw the notice.");
      setStage("idle");
      return;
    }
    router.refresh(); // the row leaves the list with the re-render
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs">
      {error && <span className="text-red-600 min-w-0 [overflow-wrap:anywhere]">{error}</span>}
      {stage === "confirm" ? (
        <>
          <span className="text-[#5B6470]">
            Withdraw &ldquo;{title}&rdquo;? It leaves dashboards, class diaries and any subscribed calendar. The record
            is kept for your audit trail.
          </span>
          <button onClick={revoke} className="font-medium text-red-600 hover:underline">
            Yes, withdraw
          </button>
          <button onClick={() => setStage("idle")} className="font-medium text-[#5B6470] hover:underline">
            Cancel
          </button>
        </>
      ) : (
        <button
          onClick={() => {
            setError(null);
            setStage("confirm");
          }}
          disabled={stage === "busy"}
          className="font-medium text-red-600 hover:underline disabled:opacity-60"
        >
          {stage === "busy" ? "Withdrawing…" : "Revoke"}
        </button>
      )}
    </span>
  );
}
