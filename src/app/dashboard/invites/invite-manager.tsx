"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

export type InviteRow = {
  id: string;
  email: string;
  role: string;
  token: string;
  accepted_at: string | null;
  expires_at: string;
  created_at: string;
};

const ROLE_OPTS = [
  { value: "teacher", label: "Teacher" },
  { value: "school_admin", label: "School admin" },
];

// Create invites (RLS lets a school_admin insert for their own school) and copy
// the resulting link. The token comes back from the insert.
export default function InviteManager({ invites, schoolId }: { invites: InviteRow[]; schoolId: string | null }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("teacher");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const linkFor = (token: string) =>
    `${typeof window !== "undefined" ? window.location.origin : ""}/invite/${token}`;

  async function create() {
    const e = email.trim();
    if (!e) return;
    if (!schoolId) {
      setError("Your account isn't linked to a school yet — ask your setup contact to link it.");
      return;
    }
    setBusy(true);
    setError(null);
    setLink(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from("invites")
      .insert({ email: e, role, school_id: schoolId, invited_by: user?.id })
      .select("token")
      .single();
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setEmail("");
    setLink(linkFor(data.token));
    router.refresh();
  }

  return (
    <>
      <div className="card p-5 mb-6">
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="text-xs text-[#5B6470]">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
              }}
              placeholder="colleague@school.edu"
              className="field block h-9 px-3 mt-1 text-sm w-64"
            />
          </label>
          <label className="block">
            <span className="text-xs text-[#5B6470]">Role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="field block h-9 px-2 mt-1 text-sm"
            >
              {ROLE_OPTS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button onClick={create} disabled={busy || !email.trim()} className="btn-primary h-9 px-4 text-sm">
            {busy ? "…" : "Create invite"}
          </button>
        </div>
        {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
        {link && (
          <div className="mt-3 rounded-lg border border-[#E6E8E4] bg-white p-3">
            <p className="text-xs font-medium text-[#0C8175] mb-1.5">✓ Invite created — send this link:</p>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={link}
                onFocus={(e) => e.target.select()}
                className="field flex-1 h-8 px-2 text-xs"
              />
              <button
                onClick={() => navigator.clipboard?.writeText(link)}
                className="btn-ghost h-8 px-3 text-xs whitespace-nowrap"
              >
                Copy
              </button>
            </div>
          </div>
        )}
      </div>

      <h2 className="text-xl mb-2">Sent invites</h2>
      {invites.length === 0 ? (
        <div className="card px-5 py-6 text-sm text-[#5B6470]">No invites yet.</div>
      ) : (
        <div className="card divide-y divide-[#EEF0EC]">
          {invites.map((iv) => {
            const accepted = !!iv.accepted_at;
            const expired = !accepted && new Date(iv.expires_at).getTime() < Date.now();
            const status = accepted ? "accepted" : expired ? "expired" : "pending";
            const tone = accepted ? "text-[#0C8175]" : expired ? "text-[#9A6400]" : "text-[#5B6470]";
            return (
              <div key={iv.id} className="px-5 py-3 flex items-center justify-between gap-3">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{iv.email}</span>
                  <span className="chip bg-[#EEF0EC] text-[#5B6470] normal-case tracking-normal ml-2">
                    {iv.role === "school_admin" ? "School admin" : "Teacher"}
                  </span>
                </span>
                <span className="flex items-center gap-3 shrink-0 text-xs">
                  <span className={tone}>{status}</span>
                  {status === "pending" && (
                    <button
                      onClick={() => navigator.clipboard?.writeText(linkFor(iv.token))}
                      className="text-[#0C8175] hover:underline"
                    >
                      Copy link
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
