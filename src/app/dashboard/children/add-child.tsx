"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Dictionary } from "@/i18n/dictionaries";

/** Every word this card renders, handed down by the (server) My Children page. */
export type AddChildMessages = Dictionary["school"]["children"]["add"] & Pick<Dictionary["common"], "close">;

// Independent path: a parent creates their child's login (username + temp
// password, exactly like teacher-provisioned students). Credentials are shown
// once — the parent hands them to the child.
export default function AddChild({ t }: { t: AddChildMessages }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creds, setCreds] = useState<{ username: string; password: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/children", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ children: [{ firstName, lastName }] }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? t.failed);
      return;
    }
    const c = (json.created ?? [])[0];
    if (c) setCreds({ username: c.username, password: c.password });
    setFirstName("");
    setLastName("");
    router.refresh();
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium">{t.title}</p>
          <p className="text-xs text-[#5B6470]">{t.hint}</p>
        </div>
        {!open && (
          <button onClick={() => setOpen(true)} className="btn-primary h-9 px-4 text-sm">
            {t.button}
          </button>
        )}
      </div>

      {creds && (
        <div className="mt-3 rounded-lg bg-[#E2F4F1] text-[#0C8175] px-4 py-3 text-sm">
          <p className="font-medium mb-1">{t.saveThese}</p>
          <p>
            {t.childId}: <span className="font-mono">{creds.username}</span> · {t.tempPassword}:{" "}
            <span className="font-mono">{creds.password}</span>
          </p>
          <p className="text-xs mt-1">{t.signInNote}</p>
        </div>
      )}

      {open && (
        <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="text-xs text-[#5B6470]">{t.firstName}</span>
            <input required value={firstName} onChange={(e) => setFirstName(e.target.value)} className="field h-9 px-3 mt-1" />
          </label>
          <label className="block">
            <span className="text-xs text-[#5B6470]">{t.lastName}</span>
            <input value={lastName} onChange={(e) => setLastName(e.target.value)} className="field h-9 px-3 mt-1" />
          </label>
          <button type="submit" disabled={busy} className="btn-primary h-9 px-4 text-sm">
            {busy ? t.creating : t.create}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="btn-ghost h-9 px-3 text-sm">
            {t.close}
          </button>
          {error && <p className="w-full text-sm text-red-600 [overflow-wrap:anywhere]">{error}</p>}
        </form>
      )}
    </div>
  );
}
