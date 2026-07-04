import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { studentEmail, usernameBase } from "@/utils/student";
import { parentPortalEnabled } from "@/utils/flags";

export const runtime = "nodejs";

// Provision a parent's own children (independent path — no school, no class).
// Mirror of /api/students: auth user with synthetic email + temp password,
// profile fill, then the parent_links row (service role — clients have no
// write path on parent_links by design). The beta_child_cap trigger is the
// real limit; the pre-check just gives a friendly message. Any adult may call
// this (a teacher can be a parent too); students never.

type NewChild = { firstName?: string; lastName?: string };

function tempPassword(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export async function POST(request: Request) {
  if (!parentPortalEnabled()) {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const role = (me?.role as string | null) ?? null;
  if (!role || role === "student") {
    return NextResponse.json({ error: "Not available for student accounts." }, { status: 403 });
  }

  let body: { children?: NewChild[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const children = (body.children ?? []).filter(
    (c) => (c.firstName ?? "").trim() || (c.lastName ?? "").trim(),
  );
  if (children.length === 0) {
    return NextResponse.json({ error: "At least one child is required." }, { status: 400 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  // Friendly pre-check (the DB trigger is the real enforcement).
  const { count: current } = await admin
    .from("parent_links")
    .select("id", { count: "exact", head: true })
    .eq("parent_id", user.id);
  const { data: capRow } = await admin
    .from("profiles")
    .select("beta_tester, max_children")
    .eq("id", user.id)
    .maybeSingle();
  const capData = capRow as { beta_tester?: boolean; max_children?: number | null } | null;
  const cap = capData?.max_children ?? (capData?.beta_tester ? 2 : null);
  if (cap != null && (current ?? 0) + children.length > cap) {
    return NextResponse.json(
      { error: `Your account is limited to ${cap} child${cap === 1 ? "" : "ren"} — you have ${current ?? 0}.` },
      { status: 400 },
    );
  }

  const created: { firstName: string; lastName: string; username: string; password: string }[] = [];
  const errors: string[] = [];

  for (const c of children) {
    const firstName = (c.firstName ?? "").trim();
    const lastName = (c.lastName ?? "").trim();
    const fullName = [firstName, lastName].filter(Boolean).join(" ");

    // Unused username (first.last, then first.last2, …) — same as /api/students.
    const base = usernameBase(firstName, lastName);
    let username = base;
    for (let n = 2; n < 1000; n++) {
      const { data: taken } = await admin
        .from("profiles")
        .select("id")
        .eq("username", username)
        .maybeSingle();
      if (!taken) break;
      username = `${base}${n}`;
    }

    const password = tempPassword();
    const { data: createdUser, error: cErr } = await admin.auth.admin.createUser({
      email: studentEmail(username),
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, role: "student" },
    });
    if (cErr || !createdUser?.user) {
      errors.push(`${fullName || username}: ${cErr?.message ?? "could not create user"}`);
      continue;
    }
    const sid = createdUser.user.id;

    const { error: pErr } = await admin
      .from("profiles")
      .update({
        username,
        full_name: fullName || null,
        parent_email: user.email ?? null, // the real parent's email (0005 semantics)
        must_reset_password: true,
        school_id: null,
        role: "student",
      })
      .eq("id", sid);
    if (pErr) errors.push(`${fullName || username}: profile — ${pErr.message}`);

    const { error: lErr } = await admin.from("parent_links").insert({
      parent_id: user.id,
      child_id: sid,
      source: "self",
      created_by: user.id,
      verified_at: new Date().toISOString(),
    });
    if (lErr) {
      // Link refused (e.g. the child cap) — remove the orphan auth user so the
      // parent isn't handed credentials for a child that isn't linked.
      errors.push(`${fullName || username}: ${lErr.message}`);
      await admin.auth.admin.deleteUser(sid).catch(() => undefined);
      continue;
    }

    created.push({ firstName, lastName, username, password });
  }

  if (created.length === 0) {
    return NextResponse.json({ error: errors.join(" · ") || "Nothing created." }, { status: 400 });
  }
  return NextResponse.json({ created, errors });
}
