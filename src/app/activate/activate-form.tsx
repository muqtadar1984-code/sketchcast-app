"use client";

import { useState } from "react";
import { codeKind } from "@/sk/codes";

// The activation form. One code field; when the code is an EDITION code
// (SKE-…) an order-number field appears and the submit goes to
// /api/sk/activate, otherwise to /api/sk/redeem (a code card). Each submit
// carries a fresh eventId so a double-click cannot activate twice (the routes
// replay the stored result for a repeated id).

type Result = { grantId?: string; tutorExpiresAt?: string | null; expiresAt?: string | null; error?: string };

export default function ActivateForm() {
  const [code, setCode] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const kind = codeKind(code);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const eventId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const edition = kind === "edition";
      const res = await fetch(edition ? "/api/sk/activate" : "/api/sk/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(edition ? { eventId, code, orderNumber } : { eventId, code }),
      });
      const body = (await res.json().catch(() => ({}))) as Result;
      if (!res.ok) {
        setError(body.error ?? "Something went wrong. Please try again.");
        return;
      }
      setDone(body);
    } catch {
      setError("Could not reach SketchCast. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const until = done.tutorExpiresAt ?? done.expiresAt ?? null;
    return (
      <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900" role="status">
        <p className="font-medium">Your book is activated.</p>
        <p className="mt-1">
          {until ? `SK tutoring is available until ${new Date(until).toLocaleDateString()}.` : "SK tutoring is available now."}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <label className="block text-sm">
        <span className="font-medium text-slate-800">Code from your book</span>
        <input
          name="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="SKE-XXXX-XXXX-XXXX-XXXXX"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-base tracking-wide text-slate-900 focus:border-emerald-500 focus:outline-none"
        />
      </label>
      {kind === "edition" && (
        <label className="block text-sm">
          <span className="font-medium text-slate-800">Amazon order number</span>
          <input
            name="orderNumber"
            value={orderNumber}
            onChange={(e) => setOrderNumber(e.target.value)}
            placeholder="123-1234567-1234567"
            inputMode="numeric"
            autoComplete="off"
            required
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-base text-slate-900 focus:border-emerald-500 focus:outline-none"
          />
          <span className="mt-1 block text-xs text-slate-500">It is on your Amazon order confirmation. Each order number activates one copy.</span>
        </label>
      )}
      {error && (
        <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || !code || (kind === "edition" && !orderNumber)}
        className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Activating…" : "Activate my book"}
      </button>
    </form>
  );
}
