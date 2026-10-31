"use client";

import { useState } from "react";
import { codeKind } from "@/sk/codes";
import { activateErrorKey, firstName, forChildFor, type ChildPicker } from "@/sk/book-activate";
import { fmt } from "@/i18n/format";
import type { Dictionary } from "@/i18n/dictionaries";

// The activation form. One code field; when the code is an EDITION code
// (SKE-…) an order-number field appears and the submit goes to
// /api/sk/activate, otherwise to /api/sk/redeem (a code card). Each submit
// carries a fresh eventId so a double-click cannot activate twice (the routes
// replay the stored result for a repeated id).
//
// S4 slice D: a parent with verified children chooses WHICH child the book is
// for (one child is preselected; two or more must be picked) and the submit
// sends `forChildId`. Refusals are said from the route's `reason` in the
// reader's language (the route's English `error` is the fallback only when
// the reason is unknown — never shown raw otherwise).

type Result = { grantId?: string; tutorExpiresAt?: string | null; expiresAt?: string | null; bookTitle?: string | null; error?: string; reason?: string };
type Messages = Dictionary["activate"];

export default function ActivateForm({ t, picker }: { t: Messages; picker: ChildPicker }) {
  const [code, setCode] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [childId, setChildId] = useState<string>(picker.mode === "one" ? picker.child.id : "");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ result: Result; childName: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const kind = codeKind(code);
  const children = picker.mode === "one" || picker.mode === "pick" ? picker.children : [];
  const forChildId = forChildFor(picker, childId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (forChildId === undefined) {
      setError(t.pickRequired);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const eventId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const edition = kind === "edition";
      const payload: Record<string, string> = edition ? { eventId, code, orderNumber } : { eventId, code };
      if (forChildId) payload.forChildId = forChildId;
      const res = await fetch(edition ? "/api/sk/activate" : "/api/sk/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as Result;
      if (!res.ok) {
        setError(t.errors[activateErrorKey(body.reason, res.status)]);
        return;
      }
      const child = forChildId ? children.find((c) => c.id === forChildId) : null;
      setDone({ result: body, childName: child ? firstName(child.name) : null });
    } catch {
      setError(t.network);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const until = done.result.tutorExpiresAt ?? done.result.expiresAt ?? null;
    const book = done.result.bookTitle?.trim() || t.bookFallback;
    return (
      <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900" role="status" data-activate="done">
        <p className="font-medium">{done.childName ? fmt(t.unlockedFor, { book, child: done.childName }) : fmt(t.unlocked, { book })}</p>
        <p className="mt-1">{until ? fmt(t.tutorUntil, { date: new Date(until).toLocaleDateString() }) : t.tutorNow}</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      {(picker.mode === "one" || picker.mode === "pick") && (
        <label className="block text-sm">
          <span className="font-medium text-slate-800">{t.forWhich}</span>
          <select
            name="forChildId"
            value={childId}
            onChange={(e) => setChildId(e.target.value)}
            required
            data-activate="child"
            className="mt-1 w-full min-h-11 rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 focus:border-emerald-500 focus:outline-none"
          >
            {picker.mode === "pick" && (
              <option value="" disabled>
                {t.choose}
              </option>
            )}
            {children.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {picker.mode === "self_note" && (
        <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600" data-activate="self-note">
          {t.noChildNote}
        </p>
      )}
      <label className="block text-sm">
        <span className="font-medium text-slate-800">{t.codeLabel}</span>
        <input
          name="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="SKE-XXXX-XXXX-XXXX-XXXXX"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
          dir="ltr"
          className="mt-1 w-full min-h-11 rounded-lg border border-slate-300 px-3 py-2 font-mono text-base tracking-wide text-slate-900 focus:border-emerald-500 focus:outline-none"
        />
      </label>
      {kind === "edition" && (
        <label className="block text-sm">
          <span className="font-medium text-slate-800">{t.orderLabel}</span>
          <input
            name="orderNumber"
            value={orderNumber}
            onChange={(e) => setOrderNumber(e.target.value)}
            placeholder="123-1234567-1234567"
            inputMode="numeric"
            autoComplete="off"
            required
            dir="ltr"
            className="mt-1 w-full min-h-11 rounded-lg border border-slate-300 px-3 py-2 font-mono text-base text-slate-900 focus:border-emerald-500 focus:outline-none"
          />
          <span className="mt-1 block text-xs text-slate-500">{t.orderHint}</span>
        </label>
      )}
      {error && (
        <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800 [overflow-wrap:anywhere]" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || !code || (kind === "edition" && !orderNumber) || forChildId === undefined}
        className="w-full min-h-11 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? t.submitting : t.submit}
      </button>
    </form>
  );
}
