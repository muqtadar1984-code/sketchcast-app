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

export type SchoolStudent = {
  id: string;
  name: string;
  username: string | null;
  parentEmail: string | null;
};

const ROLE_LABEL: Record<string, string> = {
  school_admin: "School admin",
  teacher: "Teacher",
  parent: "Parent",
};

// Create invites (RLS lets a school_admin insert for their own school) and copy
// the resulting link. Parent invites additionally map the child(ren): students
// whose parent_email matches the typed address float up as suggestions.
export default function InviteManager({
  invites,
  schoolId,
  students = [],
  parentEnabled = false,
}: {
  invites: InviteRow[];
  schoolId: string | null;
  students?: SchoolStudent[];
  parentEnabled?: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("teacher");
  const [childIds, setChildIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  // Optimistic additions so a just-created invite appears in "Sent invites"
  // immediately (router.refresh() catches up moments later).
  const [pending, setPending] = useState<InviteRow[]>([]);
  const serverIds = new Set(invites.map((i) => i.id));
  const list = [...pending.filter((p) => !serverIds.has(p.id)), ...invites];

  const roleOpts = [
    { value: "teacher", label: "Teacher" },
    { value: "school_admin", label: "School admin" },
    ...(parentEnabled ? [{ value: "parent", label: "Parent" }] : []),
  ];

  const linkFor = (token: string) =>
    `${typeof window !== "undefined" ? window.location.origin : ""}/invite/${token}`;

  // Suggested matches first (parent_email on file == the typed address).
  const emailLc = email.trim().toLowerCase();
  const sortedStudents = [...students].sort((a, b) => {
    const am = emailLc && (a.parentEmail ?? "").toLowerCase() === emailLc ? 0 : 1;
    const bm = emailLc && (b.parentEmail ?? "").toLowerCase() === emailLc ? 0 : 1;
    return am - bm || a.name.localeCompare(b.name);
  });
  const toggleChild = (id: string) =>
    setChildIds((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  async function create() {
    const e = email.trim();
    if (!e) return;
    if (!schoolId) {
      setError("Your account isn't linked to a school yet — ask your setup contact to link it.");
      return;
    }
    if (role === "parent" && childIds.length === 0) {
      setError("Pick at least one child for a parent invite.");
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
      .select("id, email, role, token, accepted_at, expires_at, created_at")
      .single();
    if (error) {
      setBusy(false);
      setError(error.message);
      return;
    }
    if (role === "parent") {
      const { error: cErr } = await supabase
        .from("invite_children")
        .insert(childIds.map((sid) => ({ invite_id: data.id, student_id: sid })));
      if (cErr) {
        // Keep it atomic-ish: no child mapping → no parent invite.
        await supabase.from("invites").delete().eq("id", data.id);
        setBusy(false);
        setError(cErr.message);
        return;
      }
    }
    setBusy(false);
    setEmail("");
    setChildIds([]);
    setLink(linkFor(data.token));
    setPending((p) => [data as InviteRow, ...p]);
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
              placeholder={role === "parent" ? "parent@example.com" : "colleague@school.edu"}
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
              {roleOpts.map((o) => (
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

        {role === "parent" && (
          <div className="mt-3">
            <p className="text-xs text-[#5B6470] mb-1.5">
              Their child(ren) — students with this email on file appear first:
            </p>
            {students.length === 0 ? (
              <p className="text-xs text-[#9A6400]">No students in your school yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto">
                {sortedStudents.map((s) => {
                  const suggested = emailLc && (s.parentEmail ?? "").toLowerCase() === emailLc;
                  const on = childIds.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      onClick={() => toggleChild(s.id)}
                      className={`chip font-sans normal-case tracking-normal ${
                        on
                          ? "bg-[#14181F] text-white"
                          : suggested
                            ? "bg-[#E2F4F1] text-[#0C8175]"
                            : "bg-[#EEF0EC] text-[#5B6470]"
                      }`}
                      title={s.username ?? undefined}
                    >
                      {on ? "✓ " : ""}{s.name}
                      {suggested && !on ? " · suggested" : ""}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

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
      {list.length === 0 ? (
        <div className="card px-5 py-6 text-sm text-[#5B6470]">No invites yet.</div>
      ) : (
        <div className="card divide-y divide-[#EEF0EC]">
          {list.map((iv) => {
            const accepted = !!iv.accepted_at;
            // (expiry check against wall-clock — recomputed on refresh is fine)
            // eslint-disable-next-line react-hooks/purity
            const expired = !accepted && new Date(iv.expires_at).getTime() < Date.now();
            const status = accepted ? "accepted" : expired ? "expired" : "pending";
            const tone = accepted ? "text-[#0C8175]" : expired ? "text-[#9A6400]" : "text-[#5B6470]";
            return (
              <div key={iv.id} className="px-5 py-3 flex items-center justify-between gap-3">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{iv.email}</span>
                  <span className="chip bg-[#EEF0EC] text-[#5B6470] normal-case tracking-normal ml-2">
                    {ROLE_LABEL[iv.role] ?? iv.role}
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
