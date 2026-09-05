import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { founderEmails, isPlatformAdminRequest } from "@/utils/platform-admin";
import { isCountryCode } from "@/utils/countries";
import { CAP_CEILING } from "@/utils/console-actions";
import { stripe } from "@/utils/stripe/client";
import { ensureStripeCustomer } from "@/utils/stripe/customer";
import { issueSchoolInvoice, SCHOOL_INVOICE_PLAN_KEY } from "@/utils/stripe/school-invoice";

export const runtime = "nodejs";

// Ops controls (staff only, every action audited):
//   suspend / unsuspend  — profiles.suspended_at (RLS cutoff for live tokens)
//                          + Supabase auth ban (blocks new logins)
//   set_caps             — per-teacher overrides of the 0011/0016 caps
//   set_country          — profiles.country (0085), stamped country_source='staff'
//   takedown / restore   — soft-delete a book or generation (recoverable)
//   admin_grant / admin_revoke — platform_admins membership (FOUNDERS only)
//   school_* (0101)      — targetId is a SCHOOL id:
//     school_suspend / school_restore — schools.status; plan_tier() branch 1,
//                          beats even a paid entitlement (the kill switch)
//     school_extend_trial — trial_ends_at += days (from now if already past)
//     school_activate     — the bank-transfer lever: a manual school_onetime
//                          entitlement held by the school's admin (0102)
//     school_set_sales    — school_registrations.sales_stage / sales_notes
//     school_issue_invoice — a Stripe INVOICE at the quoted MYR amount, the
//                          hosted page being "the payment link"; the webhook's
//                          invoice.paid branch activates the school when paid
// Non-staff get 404 (the console isn't probeable). Self/staff targets are
// refused for destructive actions (footgun guard).

type Body = {
  action?:
    | "suspend" | "unsuspend" | "set_caps" | "set_country" | "takedown" | "restore" | "admin_grant" | "admin_revoke"
    | "school_suspend" | "school_restore" | "school_extend_trial" | "school_activate" | "school_set_sales"
    | "school_issue_invoice";
  amountMyr?: number;              // school_issue_invoice: quoted amount in ringgit (major units)
  dueDays?: number;                // school_issue_invoice (default 30)
  licenceDays?: number;            // school_issue_invoice (default 365)
  sendEmail?: boolean;             // school_issue_invoice: let Stripe email it (default true)
  targetId?: string;               // profile id, book/generation id for takedown, school id for school_*
  targetKind?: "book" | "generation"; // takedown/restore only
  maxBooks?: number | null;
  maxChapters?: number | null;
  maxStudents?: number | null;
  maxChildren?: number | null;
  country?: string | null;         // set_country only; null clears
  days?: number;                   // school_extend_trial (default 30) / school_activate (default 365)
  salesStage?: string;             // school_set_sales
  salesNotes?: string | null;      // school_set_sales; null clears
  note?: string;
};

const SALES_STAGES = ["new", "contacted", "invoice_sent", "paid", "lost"];

// The ceiling is CAP_CEILING, not a literal, because it is also the smallest
// comp that buys the premium voices since 0105 — see the constant's note in
// src/utils/console-actions.ts. Dropping it below the migration's threshold
// would silently make that comp ungrantable from here.
function capVal(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= CAP_CEILING ? n : undefined;
}

/** Whole days in [1, max]; the default when absent; null when given but invalid. */
function dayVal(v: unknown, dflt: number, max: number): number | null {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

export async function POST(request: Request) {
  const staff = await isPlatformAdminRequest();
  if (!staff) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const targetId = (body.targetId ?? "").trim();
  if (!targetId) return NextResponse.json({ error: "targetId is required." }, { status: 400 });

  const admin = createAdminClient();

  const audit = async (action: string, targetKind: string, detail: Record<string, unknown>) => {
    await admin.from("platform_audit_log").insert({
      actor_id: staff.id,
      action,
      target_kind: targetKind,
      target_id: targetId,
      detail: body.note ? { ...detail, note: body.note } : detail,
    });
  };

  // ── Profile-targeted actions ────────────────────────────────────────────────
  if (
    body.action === "suspend" ||
    body.action === "unsuspend" ||
    body.action === "set_caps" ||
    body.action === "set_country"
  ) {
    const { data: target } = await admin
      .from("profiles")
      .select("*")
      .eq("id", targetId)
      .maybeSingle();
    if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });

    if (body.action === "suspend" || body.action === "unsuspend") {
      // Footgun guard: never against yourself or another staff account.
      if (targetId === staff.id) {
        return NextResponse.json({ error: "You can't suspend yourself." }, { status: 400 });
      }
      let targetEmail = "";
      try {
        const { data: u } = await admin.auth.admin.getUserById(targetId);
        targetEmail = (u?.user?.email ?? "").toLowerCase();
      } catch {
        // proceed with profile-only knowledge
      }
      const { data: staffRow } = await admin
        .from("platform_admins")
        .select("user_id")
        .eq("user_id", targetId)
        .is("revoked_at", null)
        .maybeSingle();
      if (staffRow || founderEmails().includes(targetEmail)) {
        return NextResponse.json({ error: "Target is platform staff — revoke that first." }, { status: 400 });
      }

      const suspending = body.action === "suspend";
      const { error: pErr } = await admin
        .from("profiles")
        .update({ suspended_at: suspending ? new Date().toISOString() : null })
        .eq("id", targetId);
      if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });
      try {
        await admin.auth.admin.updateUserById(targetId, {
          ban_duration: suspending ? "87600h" : "none",
        });
      } catch (e) {
        // RLS cutoff already holds; surface the partial state instead of hiding it
        await audit(body.action, "profile", { warning: `auth ban failed: ${(e as Error).message}` });
        return NextResponse.json(
          { ok: true, warning: "Data access updated, but the login ban could not be set — retry." },
        );
      }
      await audit(body.action, "profile", { was_suspended: !!target.suspended_at });
      return NextResponse.json({ ok: true });
    }

    // set_country — the staff correction lever the roster's "≈ assumed" prefix
    // points at. Only a real assigned alpha-2 code (src/utils/countries.ts) or
    // null (clear) ever reaches the row; the value is stamped
    // country_source='staff' so it renders as trusted, and a clear nulls the
    // source too — the pair moves together (0085).
    if (body.action === "set_country") {
      const clearing = body.country === null || body.country === "";
      if (!clearing && !isCountryCode(body.country)) {
        return NextResponse.json({ error: "Country must be a two-letter ISO code (e.g. MY)." }, { status: 400 });
      }
      const { error: nErr } = await admin
        .from("profiles")
        .update(
          clearing
            ? { country: null, country_source: null }
            : { country: body.country, country_source: "staff" },
        )
        .eq("id", targetId);
      if (nErr) {
        const msg = nErr.message.includes("country") || nErr.message.includes("column")
          ? "Country columns missing — run migration 0085 first."
          : nErr.message;
        return NextResponse.json({ error: msg }, { status: 500 });
      }
      await audit("set_country", "profile", {
        before: { country: target.country ?? null, country_source: target.country_source ?? null },
        after: clearing
          ? { country: null, country_source: null }
          : { country: body.country, country_source: "staff" },
      });
      return NextResponse.json({ ok: true });
    }

    // set_caps
    const patch: Record<string, number | null> = {};
    const mb = capVal(body.maxBooks);
    const mc = capVal(body.maxChapters);
    const ms = capVal(body.maxStudents);
    const mk = capVal(body.maxChildren);
    if (mb !== undefined) patch.max_books = mb;
    if (mc !== undefined) patch.max_chapters = mc;
    if (ms !== undefined) patch.max_students = ms;
    if (mk !== undefined) patch.max_children = mk;
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: `No valid caps given (0–${CAP_CEILING} or null).` }, { status: 400 });
    }
    const { error: cErr } = await admin.from("profiles").update(patch).eq("id", targetId);
    if (cErr) {
      const msg = cErr.message.includes("max_books") || cErr.message.includes("column")
        ? "Cap columns missing — run migration 0016 first."
        : cErr.message;
      return NextResponse.json({ error: msg }, { status: 500 });
    }
    await audit("cap_override", "profile", {
      before: {
        max_books: target.max_books ?? null,
        max_chapters: target.max_chapters ?? null,
        max_students: target.max_students ?? null,
        max_children: target.max_children ?? null,
      },
      after: patch,
    });
    return NextResponse.json({ ok: true });
  }

  // ── Content takedown / restore ──────────────────────────────────────────────
  if (body.action === "takedown" || body.action === "restore") {
    const kind = body.targetKind;
    if (kind !== "book" && kind !== "generation") {
      return NextResponse.json({ error: "targetKind must be book or generation." }, { status: 400 });
    }
    const table = kind === "book" ? "books" : "generations";
    const removing = body.action === "takedown";
    const { data: row } = await admin.from(table).select("id, removed_at").eq("id", targetId).maybeSingle();
    if (!row) return NextResponse.json({ error: `${kind} not found.` }, { status: 404 });
    const { error: tErr } = await admin
      .from(table)
      .update({
        removed_at: removing ? new Date().toISOString() : null,
        removed_by: removing ? staff.id : null,
      })
      .eq("id", targetId);
    if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });
    await audit(body.action, kind, { was_removed: !!row.removed_at });
    return NextResponse.json({ ok: true });
  }

  // ── Staff membership (founders only — staff cannot mint staff) ─────────────
  if (body.action === "admin_grant" || body.action === "admin_revoke") {
    if (!founderEmails().includes(staff.email)) {
      return NextResponse.json({ error: "Founders only." }, { status: 403 });
    }
    if (body.action === "admin_grant") {
      const { error: gErr } = await admin
        .from("platform_admins")
        .upsert({ user_id: targetId, granted_by: staff.id, note: body.note ?? null, revoked_at: null });
      if (gErr) return NextResponse.json({ error: gErr.message }, { status: 500 });
    } else {
      const { error: rErr } = await admin
        .from("platform_admins")
        .update({ revoked_at: new Date().toISOString() })
        .eq("user_id", targetId);
      if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 });
    }
    await audit(body.action, "profile", {});
    return NextResponse.json({ ok: true });
  }

  // ── School-targeted actions (0101, Phase 2) ─────────────────────────────────
  // targetId is the school id. Every action lands in platform_audit_log with
  // target_kind 'school'; the school page reads that trail back.
  if (typeof body.action === "string" && body.action.startsWith("school_")) {
    const { data: school } = await admin
      .from("schools")
      .select("id, name, status, created_by, trial_started_at, trial_ends_at")
      .eq("id", targetId)
      .maybeSingle();
    if (!school) return NextResponse.json({ error: "School not found." }, { status: 404 });
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    if (body.action === "school_suspend" || body.action === "school_restore") {
      const next = body.action === "school_suspend" ? "suspended" : "active";
      if (school.status === next) return NextResponse.json({ ok: true, unchanged: true });
      const { error } = await admin.from("schools").update({ status: next }).eq("id", targetId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      await audit(body.action, "school", { before: school.status, after: next });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "school_extend_trial") {
      const days = dayVal(body.days, 30, 365);
      if (days === null) return NextResponse.json({ error: "days must be a whole number from 1 to 365." }, { status: 400 });
      // From whichever is later — the current end, or now: an expired clock
      // restarts from today rather than granting back-dated days.
      const currentEnd = school.trial_ends_at ? new Date(school.trial_ends_at as string).getTime() : 0;
      const end = new Date(Math.max(nowMs, currentEnd) + days * 86400000).toISOString();
      const patch: Record<string, string> = { trial_ends_at: end };
      // A school that never had a clock (pre-0101) gets its anchor stamped now,
      // so the trial budget counts from today, not from the school's creation.
      if (!school.trial_started_at) patch.trial_started_at = nowIso;
      const { error } = await admin.from("schools").update(patch).eq("id", targetId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      await audit("school_extend_trial", "school", { days, before: school.trial_ends_at ?? null, after: end });
      return NextResponse.json({ ok: true, trial_ends_at: end });
    }

    if (body.action === "school_activate") {
      const days = dayVal(body.days, 365, 1095);
      if (days === null) return NextResponse.json({ error: "days must be a whole number from 1 to 1095." }, { status: 400 });
      // The licence is ONE row held by an adult and scoped to the school —
      // plan_tier() joins entitlements.school_id, so every member resolves to
      // 'school'. Prefer the creator; fall back to the first school_admin.
      let holder = (school.created_by as string | null) ?? null;
      if (!holder) {
        const { data: adminRow } = await admin
          .from("profiles")
          .select("id")
          .eq("school_id", targetId)
          .eq("role", "school_admin")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        holder = (adminRow?.id as string | undefined) ?? null;
      }
      if (!holder) {
        return NextResponse.json({ error: "This school has no admin account to hold the licence." }, { status: 400 });
      }
      const { data: existing } = await admin
        .from("entitlements")
        .select("active, current_period_end, provider")
        .eq("user_id", holder)
        .eq("plan_key", "school_onetime")
        .maybeSingle();
      // Renewal extends from the current end; a lapsed or fresh licence starts now.
      const existingEnd =
        existing?.active && existing.current_period_end ? new Date(existing.current_period_end as string).getTime() : 0;
      const end = new Date(Math.max(nowMs, existingEnd) + days * 86400000).toISOString();
      const { error } = await admin.from("entitlements").upsert(
        {
          user_id: holder,
          school_id: targetId,
          provider: "manual",
          active: true,
          plan_key: "school_onetime",
          status: "activated",
          current_period_end: end,
          updated_at: nowIso,
        },
        { onConflict: "user_id,plan_key" },
      );
      if (error) {
        const msg = error.message.includes("provider")
          ? "Manual activation needs migration 0102 applied first."
          : error.message;
        return NextResponse.json({ error: msg }, { status: 500 });
      }
      // Money landed — the pipeline says so too. A pre-0101 school has no
      // registration row yet; the upsert creates it.
      await admin
        .from("school_registrations")
        .upsert({ school_id: targetId, sales_stage: "paid", updated_at: nowIso }, { onConflict: "school_id" });
      await audit("school_activate", "school", {
        holder,
        days,
        before: existing?.current_period_end ?? null,
        after: end,
        previous_provider: existing?.provider ?? null,
      });
      return NextResponse.json({ ok: true, current_period_end: end });
    }

    if (body.action === "school_set_sales") {
      const patch: Record<string, string | null> = { school_id: targetId, updated_at: nowIso };
      if (body.salesStage !== undefined) {
        if (!SALES_STAGES.includes(body.salesStage)) {
          return NextResponse.json({ error: `salesStage must be one of ${SALES_STAGES.join(", ")}.` }, { status: 400 });
        }
        patch.sales_stage = body.salesStage;
      }
      if (body.salesNotes !== undefined) {
        const notes = body.salesNotes === null ? "" : String(body.salesNotes).trim();
        patch.sales_notes = notes ? notes.slice(0, 2000) : null;
      }
      if (patch.sales_stage === undefined && patch.sales_notes === undefined) {
        return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
      }
      const { data: before } = await admin
        .from("school_registrations")
        .select("sales_stage, sales_notes")
        .eq("school_id", targetId)
        .maybeSingle();
      const { error } = await admin.from("school_registrations").upsert(patch, { onConflict: "school_id" });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      await audit("school_set_sales", "school", {
        before: { sales_stage: before?.sales_stage ?? null, notes_len: (before?.sales_notes as string | null)?.length ?? 0 },
        after: { sales_stage: patch.sales_stage ?? before?.sales_stage ?? null, notes_len: patch.sales_notes?.length ?? 0 },
      });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "school_issue_invoice") {
      if (!process.env.STRIPE_SECRET_KEY) {
        return NextResponse.json(
          { error: "Stripe is not configured on this deployment (STRIPE_SECRET_KEY). Use Activate for a bank transfer, or add the key first." },
          { status: 400 },
        );
      }
      const amount = Number(body.amountMyr);
      if (!Number.isFinite(amount) || amount < 1 || amount > 1_000_000) {
        return NextResponse.json({ error: "amountMyr must be between 1 and 1,000,000 ringgit." }, { status: 400 });
      }
      const amountSen = Math.round(amount * 100);
      const dueDays = dayVal(body.dueDays, 30, 90);
      const licenceDays = dayVal(body.licenceDays, 365, 1095);
      if (dueDays === null || licenceDays === null) {
        return NextResponse.json({ error: "dueDays must be 1–90 and licenceDays 1–1095." }, { status: 400 });
      }
      const sendEmail = body.sendEmail !== false;

      // The invoice is billed to the school's admin — the same adult whose
      // entitlement row plan_tier() will read (school_activate uses the same
      // rule): the creator, else the first school_admin.
      let holder = (school.created_by as string | null) ?? null;
      if (!holder) {
        const { data: adminRow } = await admin
          .from("profiles")
          .select("id")
          .eq("school_id", targetId)
          .eq("role", "school_admin")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        holder = (adminRow?.id as string | undefined) ?? null;
      }
      if (!holder) {
        return NextResponse.json({ error: "This school has no admin account to bill." }, { status: 400 });
      }
      let holderEmail: string | null = null;
      try {
        const { data: u } = await admin.auth.admin.getUserById(holder);
        holderEmail = u?.user?.email ?? null;
      } catch {
        // billed without an email on the Stripe customer — the founder sends the link by hand
      }

      // A renewal extends from the current licence end; the webhook applies it.
      const { data: existing } = await admin
        .from("entitlements")
        .select("active, current_period_end")
        .eq("user_id", holder)
        .eq("plan_key", SCHOOL_INVOICE_PLAN_KEY)
        .maybeSingle();
      const extendFrom =
        existing?.active && existing.current_period_end && new Date(existing.current_period_end as string).getTime() > nowMs
          ? (existing.current_period_end as string)
          : null;

      try {
        const s = stripe();
        // FIRST the customer mapping — the webhook refuses any object whose
        // customer it cannot map back to this user.
        const customerId = await ensureStripeCustomer(admin, s, {
          userId: holder,
          schoolId: targetId,
          email: holderEmail,
          role: "school_admin",
        });
        const inv = await issueSchoolInvoice(s, {
          customerId,
          userId: holder,
          schoolId: targetId,
          schoolName: (school.name as string) || "School",
          amountSen,
          daysUntilDue: dueDays,
          licenceDays,
          extendFrom,
          issuedBy: staff.id,
          sendEmail,
        });
        await admin.from("school_registrations").upsert(
          {
            school_id: targetId,
            stripe_customer_id: customerId,
            stripe_invoice_id: inv.invoiceId,
            hosted_invoice_url: inv.hostedUrl,
            sales_stage: "invoice_sent",
            updated_at: nowIso,
          },
          { onConflict: "school_id" },
        );
        await audit("school_issue_invoice", "school", {
          holder,
          invoice: inv.invoiceId,
          amount_sen: amountSen,
          due_days: dueDays,
          licence_days: licenceDays,
          extend_from: extendFrom,
          emailed: sendEmail,
        });
        return NextResponse.json({
          ok: true,
          invoice: inv.invoiceId,
          url: inv.hostedUrl,
          pdf: inv.pdfUrl,
          due: inv.dueDate,
          emailed: sendEmail,
        });
      } catch (e) {
        console.error("console.school_issue_invoice", { school: targetId, err: (e as Error).message });
        return NextResponse.json({ error: `Stripe refused the invoice: ${(e as Error).message}` }, { status: 502 });
      }
    }

    return NextResponse.json({ error: "Unknown school action." }, { status: 400 });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
