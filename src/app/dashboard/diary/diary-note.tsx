"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LANGUAGES } from "@/utils/narration";
import { fmt } from "@/i18n/format";
import type { Dictionary } from "@/i18n/dictionaries";
import { TYPE_ICON, TYPE_STYLE, noteTypeLabel, type NoteTypeLabels } from "./note-types";

// Client-side consumers may keep importing these from here; server pages must
// use ./note-types directly (values in a "use client" module aren't readable
// through a client reference).
export { NOTE_TYPES, TYPE_STYLE } from "./note-types";

// One diary note card — SHARED across the teacher, parent, student and
// leadership diary views. The viewer's powers arrive as props, never derived
// here (the server components know the role; RLS is the real gate anyway):
//   · canReply  — participants (teacher/parent/student) get the reply box
//   · ack       — parents only: which child this card is signed FOR; acked
//                 state renders as the teal "Signed ✓" receipt chip
//   · signed    — teacher only: the "Signed N/M" receipt count (N parents
//                 signed, of M students with a linked parent account)
//   · mine      — per note AND per reply: the viewer WROTE this one, so the
//                 delete affordance shows (RLS's dn_author_delete /
//                 dr_author_delete is the real gate). Resolved server-side from
//                 author_id, the same comparison that already renders the "You"
//                 byline; omitted ⇒ no delete, which is how the read-only
//                 leadership page (dashboard/school/diary) stays read-only.
//   · t / lang  — every word this card renders, plus the tag its clocks format
//                 in. Composed by each server view (the dictionary is
//                 server-only; the strings cross the boundary, the file never
//                 does), so one note reads the same in four places.
// Translate is available to every viewer: /api/diary/translate re-proves the
// caller can read the target under THEIR session before serving the cache.
// The last-picked language is remembered (localStorage) so re-translating
// tomorrow's page is one click. That picker is a CONTENT-language list (the
// narration registry, each name in its own language) — unrelated to the
// interface language this card is written in.

export type DiaryReplyItem = {
  id: string;
  author: string; // display name, resolved server-side ("You" / "Teacher" / a child)
  body: string;
  createdAt: string;
  /** The viewer wrote this reply — offer to retract it. */
  mine?: boolean;
};

export type DiaryNoteItem = {
  id: string;
  type: string; // homework | reminder | praise | concern | health | general
  body: string;
  author: string;
  audience: string; // where it's addressed: a class name or a student's name
  parentsOnly: boolean;
  createdAt: string;
  /** The viewer wrote this note — offer to delete it (thread + signatures go
   * with it; the confirm copy says so). */
  mine?: boolean;
};

type Translated = { text: string; dir: string };

/** Every word this card renders: its own slice, the note-type vocabulary the
 * chip names, and the shared Cancel. Typed from the English dictionary, but the
 * import is type-only — the server-only module is erased here and no
 * translation file reaches the browser bundle. */
export type DiaryNoteMessages = Dictionary["comms"]["diary"]["note"] & {
  noteTypes: NoteTypeLabels;
  cancel: string;
};

// Last-picked translation language, shared across every note and visit.
const LANG_KEY = "diary-translate-lang";

export default function DiaryNote({
  note,
  replies,
  canReply = false,
  ack = null,
  signed = null,
  t,
  lang,
}: {
  note: DiaryNoteItem;
  replies: DiaryReplyItem[];
  canReply?: boolean;
  /** Parent-only: the child this card is signed for (null elsewhere). */
  ack?: { studentId: string; ackedAt: string | null } | null;
  /** Teacher-only: parent signatures so far (null hides the count). */
  signed?: { signed: number; total: number } | null;
  t: DiaryNoteMessages;
  /** BCP-47 tag for the two clocks below. Passed explicitly rather than left to
   * the runtime default, which is the SERVER's locale during the prerender and
   * the BROWSER's after hydration — two different times for the same note. */
  lang: string;
}) {
  const router = useRouter();

  // Times render in the SCHOOL's timezone (calendar doctrine — fixed UTC+8),
  // the same zone date-nav buckets the day into, so a page never shows two
  // clocks: a note filed at 9pm KL stays on its own day for a parent reading
  // abroad. The reader's LANGUAGE still decides how it is written. Make the
  // zone per-school config when a school outside MY signs up.
  const [timeFmt, stampFmt] = useMemo(
    () => [
      new Intl.DateTimeFormat(lang, {
        timeZone: "Asia/Kuala_Lumpur",
        hour: "2-digit",
        minute: "2-digit",
      }),
      new Intl.DateTimeFormat(lang, {
        timeZone: "Asia/Kuala_Lumpur",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
    ],
    [lang],
  );

  // ── Translate (cache-first server; "" = show originals) ─────────────────────
  // xlLang is the CONTENT language the reader asked this note to be turned into
  // — nothing to do with `lang` above, which is the interface the card itself is
  // written in.
  const [xlLang, setXlLang] = useState("");
  const [remembered, setRemembered] = useState<string | null>(null);
  const [xl, setXl] = useState<Record<string, Translated>>({}); // "note:id" / "reply:id" → text for the CURRENT lang
  const [xlBusy, setXlBusy] = useState(false);
  // What the last round couldn't deliver (failed OR came back partial), so the
  // note can offer a retry instead of silently mixing languages.
  const [xlGap, setXlGap] = useState<{ lang: string; missing: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Restore the remembered language AFTER mount (reading localStorage in the
  // initializer would make server and client render different markup). It only
  // surfaces a one-click shortcut — nothing translates until asked.
  useEffect(() => {
    const timer = setTimeout(() => {
      // deferred: avoids setState-in-effect cascades (the beta-banner idiom)
      try {
        const saved = localStorage.getItem(LANG_KEY);
        if (saved && LANGUAGES.some((l) => l.value === saved)) setRemembered(saved);
      } catch {
        /* private mode — no shortcut */
      }
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  // A note plus its thread is 1+N calls. They SETTLE INDIVIDUALLY: one failed
  // reply must not throw away the translated note (the old all-or-nothing
  // Promise.all did exactly that). Whatever landed is shown; whatever didn't —
  // a failure, or a {partial:true} half-translation the server couldn't finish
  // — keeps its ORIGINAL text and is counted into a retry line. A partial is
  // deliberately never cached in the UI: half a sentence reads like the whole
  // message, which is worse than the untranslated original.
  async function translateTo(next: string) {
    setXlLang(next);
    setError(null);
    setXlGap(null);
    if (!next) return; // back to originals
    setRemembered(next);
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {
      /* best-effort */
    }
    setXlBusy(true);
    const targets = [
      { kind: "note", id: note.id },
      ...replies.map((r) => ({ kind: "reply", id: r.id })),
    ];
    const settled = await Promise.allSettled(
      targets.map(async (target) => {
        const res = await fetch("/api/diary/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: target.kind, id: target.id, lang: next }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? "translate failed");
        if (json.partial === true) throw new Error("partial");
        return [
          `${target.kind}:${target.id}`,
          { text: json.text as string, dir: json.dir as string },
        ] as const;
      }),
    );
    const done = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const missing = settled.length - done.length;
    setXl(Object.fromEntries(done));
    setXlBusy(false);
    if (missing) setXlGap({ lang: next, missing, total: settled.length });
    if (!done.length) setXlLang(""); // nothing landed — back to the originals
  }

  const noteXl = xlLang ? xl[`note:${note.id}`] : undefined;

  // ── Acknowledge (parents: the "signed the diary" receipt) ───────────────────
  const [ackedAt, setAckedAt] = useState(ack?.ackedAt ?? null);
  const [ackBusy, setAckBusy] = useState(false);

  async function acknowledge() {
    if (!ack) return;
    setAckBusy(true);
    setError(null);
    const res = await fetch("/api/diary/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noteId: note.id, studentId: ack.studentId }),
    });
    const json = await res.json().catch(() => ({}));
    setAckBusy(false);
    if (!res.ok) {
      setError(json.error ?? t.signFailed);
      return;
    }
    setAckedAt(new Date().toISOString());
    router.refresh();
  }

  // ── Reply ───────────────────────────────────────────────────────────────────
  const [reply, setReply] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);

  async function sendReply(e: React.FormEvent) {
    e.preventDefault();
    if (!reply.trim()) return;
    setReplyBusy(true);
    setError(null);
    const res = await fetch("/api/diary/replies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noteId: note.id, body: reply.trim() }),
    });
    const json = await res.json().catch(() => ({}));
    setReplyBusy(false);
    if (!res.ok) {
      setError(json.error ?? t.replyFailed);
      return;
    }
    setReply("");
    router.refresh();
  }

  // ── Delete (authors only — RLS's dn_author_delete / dr_author_delete) ────────
  // Never a bare one-tap ✕: deleting a note takes its whole thread AND the
  // parents' signatures on it with it (0066 cascades), which is not what "✕"
  // looks like it does — so the confirm SAYS it in words first. Inline two-tap,
  // the same shape as DeleteStudentButton on the roster; no window.confirm.
  // Neither handler clears its busy flag on success: the row it belongs to
  // disappears with the refresh, and a re-armable control on a deleted note is
  // just a second way to see an error.
  const [confirmNote, setConfirmNote] = useState(false);
  const [noteBusy, setNoteBusy] = useState(false);
  const [confirmReply, setConfirmReply] = useState<string | null>(null);
  const [replyBusyId, setReplyBusyId] = useState<string | null>(null);

  async function removeNote() {
    setNoteBusy(true);
    setError(null);
    const res = await fetch("/api/diary/notes", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: note.id }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(json.error ?? t.deleteNoteFailed);
      setNoteBusy(false);
      setConfirmNote(false);
      return;
    }
    router.refresh();
  }

  async function removeReply(id: string) {
    setReplyBusyId(id);
    setError(null);
    const res = await fetch("/api/diary/replies", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(json.error ?? t.deleteReplyFailed);
      setReplyBusyId(null);
      setConfirmReply(null);
      return;
    }
    router.refresh();
  }

  const time = timeFmt.format(new Date(note.createdAt));

  return (
    <div className="px-5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex flex-wrap items-center gap-1.5 text-xs text-[#5B6470]">
          <span className={`chip font-sans normal-case tracking-normal ${TYPE_STYLE[note.type] ?? TYPE_STYLE.general}`}>
            {TYPE_ICON[note.type] ?? "📝"} {noteTypeLabel(t.noteTypes, note.type)}
          </span>
          {note.parentsOnly && (
            <span className="chip font-sans normal-case tracking-normal bg-[#EEF0EC] text-[#5B6470]">
              {t.parentsOnly}
            </span>
          )}
          <span className="truncate">
            {note.author} <span className="rtl-flip">→</span> {note.audience} · {time}
          </span>
        </div>
        <span className="flex items-center gap-1.5 shrink-0">
          {!xlLang && remembered && (
            <button
              onClick={() => translateTo(remembered)}
              disabled={xlBusy}
              className="btn-ghost h-7 px-2 text-xs"
              title={t.translateLikeLastTime}
            >
              {LANGUAGES.find((l) => l.value === remembered)?.label ?? remembered}
            </button>
          )}
          {/* Point-of-transfer notice: choosing a language sends this note's
              text (and its replies') to our AI translation provider. Students
              can translate too, so the disclosure has to sit on the control
              itself, not only in the privacy policy. */}
          <select
            value={xlLang}
            onChange={(e) => translateTo(e.target.value)}
            disabled={xlBusy}
            className="field h-7 px-1.5 text-xs"
            aria-label={t.translateAria}
            title={t.translateTitle}
          >
            <option value="">{xlBusy ? t.translating : t.translate}</option>
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
          {note.mine && !confirmNote && (
            <button
              onClick={() => {
                setError(null);
                setConfirmNote(true);
              }}
              disabled={noteBusy}
              aria-label={t.deleteNote}
              title={t.deleteNote}
              className="w-6 h-6 flex items-center justify-center rounded-md text-[#5B6470] hover:bg-[#FCEBEA] hover:text-[#B42318] disabled:opacity-50"
            >
              ✕
            </button>
          )}
        </span>
      </div>

      <p className="mt-1.5 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]" dir={noteXl?.dir ?? "ltr"}>
        {noteXl?.text ?? note.body}
      </p>

      {note.mine && confirmNote && (
        <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[#5B6470]">{t.deleteNoteConfirm}</span>
          <button
            onClick={removeNote}
            disabled={noteBusy}
            className="font-medium text-red-600 hover:underline disabled:opacity-60"
          >
            {noteBusy ? t.deleting : t.yesDelete}
          </button>
          <button
            onClick={() => setConfirmNote(false)}
            disabled={noteBusy}
            className="font-medium text-[#5B6470] hover:underline disabled:opacity-60"
          >
            {t.cancel}
          </button>
        </p>
      )}

      {(replies.length > 0 || canReply) && (
        <div className="mt-2 ps-3 border-s-2 border-[#EEF0EC] space-y-1.5">
          {replies.map((r) => {
            const rXl = xlLang ? xl[`reply:${r.id}`] : undefined;
            const armed = confirmReply === r.id;
            const busy = replyBusyId === r.id;
            return (
              <p key={r.id} className="text-sm" dir={rXl?.dir ?? "ltr"}>
                <span className="text-xs text-[#5B6470]">{r.author}: </span>
                <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{rXl?.text ?? r.body}</span>
                {/* Own line only. The confirm stays LTR inside a mirrored
                    thread — it's chrome, not part of what was said. */}
                {r.mine &&
                  (armed ? (
                    <span className="ms-2 inline-flex flex-wrap items-center gap-2 text-xs" dir="ltr">
                      <span className="text-[#5B6470]">{t.deleteReplyConfirm}</span>
                      <button
                        onClick={() => removeReply(r.id)}
                        disabled={busy}
                        className="font-medium text-red-600 hover:underline disabled:opacity-60"
                      >
                        {busy ? t.deleting : t.yesDelete}
                      </button>
                      <button
                        onClick={() => setConfirmReply(null)}
                        disabled={busy}
                        className="font-medium text-[#5B6470] hover:underline disabled:opacity-60"
                      >
                        {t.cancel}
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => {
                        setError(null);
                        setConfirmReply(r.id);
                      }}
                      aria-label={t.deleteReply}
                      title={t.deleteReply}
                      className="ms-1.5 align-middle text-xs text-[#98A0A9] hover:text-[#B42318]"
                    >
                      ✕
                    </button>
                  ))}
              </p>
            );
          })}
          {canReply && (
            <form onSubmit={sendReply} className="flex items-end gap-2 pt-0.5">
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                maxLength={2000}
                rows={1}
                placeholder={t.replyPlaceholder}
                className="field px-3 py-1.5 text-sm flex-1 min-h-[34px]"
              />
              <button type="submit" disabled={replyBusy || !reply.trim()} className="btn-ghost h-8 px-3 text-sm shrink-0">
                {replyBusy ? t.sending : t.reply}
              </button>
            </form>
          )}
        </div>
      )}

      {signed && signed.total > 0 && (
        <p className="mt-2 text-xs text-[#5B6470]" title={t.signedTitle}>
          ✍️ {fmt(t.signedCount, { signed: signed.signed, total: signed.total })}
        </p>
      )}

      {ack && (
        <div className="mt-2">
          {ackedAt ? (
            <span className="chip font-sans normal-case tracking-normal bg-[#E2F4F1] text-[#0C8175]">
              {t.signed} ✓ {stampFmt.format(new Date(ackedAt))}
            </span>
          ) : (
            <button onClick={acknowledge} disabled={ackBusy} className="btn-ghost h-8 px-3 text-sm">
              {ackBusy ? t.signing : t.acknowledge}
            </button>
          )}
        </div>
      )}

      {xlGap && (
        <p className="mt-1.5 text-xs text-[#9A6400]">
          {xlGap.missing === xlGap.total
            ? t.translationIncomplete
            : fmt(t.translationPartial, { missing: xlGap.missing, total: xlGap.total })}{" "}
          <button
            onClick={() => translateTo(xlGap.lang)}
            disabled={xlBusy}
            className="font-medium underline disabled:no-underline"
          >
            {xlBusy ? t.translating : t.retry}
          </button>
        </p>
      )}

      {error && <p className="mt-1.5 text-sm text-red-600 [overflow-wrap:anywhere]">{error}</p>}
    </div>
  );
}
