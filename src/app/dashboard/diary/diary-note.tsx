"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LANGUAGES } from "@/utils/narration";
import { TYPE_ICON, TYPE_LABEL, TYPE_STYLE } from "./note-types";

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
// Translate is available to every viewer: /api/diary/translate re-proves the
// caller can read the target under THEIR session before serving the cache.
// The last-picked language is remembered (localStorage) so re-translating
// tomorrow's page is one click.

export type DiaryReplyItem = {
  id: string;
  author: string; // display name, resolved server-side ("You" / "Teacher" / a child)
  body: string;
  createdAt: string;
};

export type DiaryNoteItem = {
  id: string;
  type: string; // homework | reminder | praise | concern | health | general
  body: string;
  author: string;
  audience: string; // where it's addressed: a class name or a student's name
  parentsOnly: boolean;
  createdAt: string;
};

type Translated = { text: string; dir: string };

// Last-picked translation language, shared across every note and visit.
const LANG_KEY = "diary-translate-lang";

// Times render in the SCHOOL's timezone (calendar doctrine — fixed UTC+8), the
// same zone date-nav buckets the day into, so a page never shows two clocks:
// a note filed at 9pm KL stays on its own day for a parent reading abroad.
// Make this per-school config when a school outside MY signs up.
const TIME_FMT = new Intl.DateTimeFormat("en-MY", {
  timeZone: "Asia/Kuala_Lumpur",
  hour: "2-digit",
  minute: "2-digit",
});
const STAMP_FMT = new Intl.DateTimeFormat("en-MY", {
  timeZone: "Asia/Kuala_Lumpur",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export default function DiaryNote({
  note,
  replies,
  canReply = false,
  ack = null,
  signed = null,
}: {
  note: DiaryNoteItem;
  replies: DiaryReplyItem[];
  canReply?: boolean;
  /** Parent-only: the child this card is signed for (null elsewhere). */
  ack?: { studentId: string; ackedAt: string | null } | null;
  /** Teacher-only: parent signatures so far (null hides the count). */
  signed?: { signed: number; total: number } | null;
}) {
  const router = useRouter();

  // ── Translate (cache-first server; "" = show originals) ─────────────────────
  const [lang, setLang] = useState("");
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
    const t = setTimeout(() => {
      // deferred: avoids setState-in-effect cascades (the beta-banner idiom)
      try {
        const saved = localStorage.getItem(LANG_KEY);
        if (saved && LANGUAGES.some((l) => l.value === saved)) setRemembered(saved);
      } catch {
        /* private mode — no shortcut */
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // A note plus its thread is 1+N calls. They SETTLE INDIVIDUALLY: one failed
  // reply must not throw away the translated note (the old all-or-nothing
  // Promise.all did exactly that). Whatever landed is shown; whatever didn't —
  // a failure, or a {partial:true} half-translation the server couldn't finish
  // — keeps its ORIGINAL text and is counted into a retry line. A partial is
  // deliberately never cached in the UI: half a sentence reads like the whole
  // message, which is worse than the untranslated original.
  async function translateTo(next: string) {
    setLang(next);
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
      targets.map(async (t) => {
        const res = await fetch("/api/diary/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: t.kind, id: t.id, lang: next }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? "translate failed");
        if (json.partial === true) throw new Error("partial");
        return [`${t.kind}:${t.id}`, { text: json.text as string, dir: json.dir as string }] as const;
      }),
    );
    const done = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const missing = settled.length - done.length;
    setXl(Object.fromEntries(done));
    setXlBusy(false);
    if (missing) setXlGap({ lang: next, missing, total: settled.length });
    if (!done.length) setLang(""); // nothing landed — back to the originals
  }

  const noteXl = lang ? xl[`note:${note.id}`] : undefined;

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
      setError(json.error ?? "Could not sign — please try again.");
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
      setError(json.error ?? "Could not send the reply.");
      return;
    }
    setReply("");
    router.refresh();
  }

  const time = TIME_FMT.format(new Date(note.createdAt));

  return (
    <div className="px-5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex flex-wrap items-center gap-1.5 text-xs text-[#5B6470]">
          <span className={`chip font-sans normal-case tracking-normal ${TYPE_STYLE[note.type] ?? TYPE_STYLE.general}`}>
            {TYPE_ICON[note.type] ?? "📝"} {TYPE_LABEL[note.type] ?? note.type}
          </span>
          {note.parentsOnly && (
            <span className="chip font-sans normal-case tracking-normal bg-[#EEF0EC] text-[#5B6470]">parents only</span>
          )}
          <span className="truncate">
            {note.author} → {note.audience} · {time}
          </span>
        </div>
        <span className="flex items-center gap-1.5 shrink-0">
          {!lang && remembered && (
            <button
              onClick={() => translateTo(remembered)}
              disabled={xlBusy}
              className="btn-ghost h-7 px-2 text-xs"
              title="Translate like last time"
            >
              {LANGUAGES.find((l) => l.value === remembered)?.label ?? remembered}
            </button>
          )}
          {/* Point-of-transfer notice: choosing a language sends this note's
              text (and its replies') to our AI translation provider. Students
              can translate too, so the disclosure has to sit on the control
              itself, not only in the privacy policy. */}
          <select
            value={lang}
            onChange={(e) => translateTo(e.target.value)}
            disabled={xlBusy}
            className="field h-7 px-1.5 text-xs"
            aria-label="Translate this note — sends the text to our AI translation provider"
            title="Machine translation — the text of this note is sent to our AI provider to translate it"
          >
            <option value="">{xlBusy ? "Translating…" : "Translate"}</option>
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </span>
      </div>

      <p className="mt-1.5 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]" dir={noteXl?.dir ?? "ltr"}>
        {noteXl?.text ?? note.body}
      </p>

      {(replies.length > 0 || canReply) && (
        <div className="mt-2 pl-3 border-l-2 border-[#EEF0EC] space-y-1.5">
          {replies.map((r) => {
            const rXl = lang ? xl[`reply:${r.id}`] : undefined;
            return (
              <p key={r.id} className="text-sm" dir={rXl?.dir ?? "ltr"}>
                <span className="text-xs text-[#5B6470]">{r.author}: </span>
                <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{rXl?.text ?? r.body}</span>
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
                placeholder="Write a reply…"
                className="field px-3 py-1.5 text-sm flex-1 min-h-[34px]"
              />
              <button type="submit" disabled={replyBusy || !reply.trim()} className="btn-ghost h-8 px-3 text-sm shrink-0">
                {replyBusy ? "Sending…" : "Reply"}
              </button>
            </form>
          )}
        </div>
      )}

      {signed && signed.total > 0 && (
        <p
          className="mt-2 text-xs text-[#5B6470]"
          title="Parents who have signed this note, out of the enrolled students with a linked parent account"
        >
          ✍️ Signed {signed.signed}/{signed.total}
        </p>
      )}

      {ack && (
        <div className="mt-2">
          {ackedAt ? (
            <span className="chip font-sans normal-case tracking-normal bg-[#E2F4F1] text-[#0C8175]">
              Signed ✓ {STAMP_FMT.format(new Date(ackedAt))}
            </span>
          ) : (
            <button onClick={acknowledge} disabled={ackBusy} className="btn-ghost h-8 px-3 text-sm">
              {ackBusy ? "Signing…" : "Acknowledge"}
            </button>
          )}
        </div>
      )}

      {xlGap && (
        <p className="mt-1.5 text-xs text-[#9A6400]">
          {xlGap.missing === xlGap.total
            ? "Translation incomplete — showing the original."
            : `Translation incomplete — ${xlGap.missing} of ${xlGap.total} messages still show the original.`}{" "}
          <button
            onClick={() => translateTo(xlGap.lang)}
            disabled={xlBusy}
            className="font-medium underline disabled:no-underline"
          >
            {xlBusy ? "Translating…" : "Retry"}
          </button>
        </p>
      )}

      {error && <p className="mt-1.5 text-sm text-red-600 [overflow-wrap:anywhere]">{error}</p>}
    </div>
  );
}
