"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// School levers (0101, Phase 2) — POSTs /api/console/ops with the school id as
// targetId. Same shape as the user page's OpsControls so the two panels
// cannot drift: one `call`, one error line, router.refresh() on success.

const STAGES = ["new", "contacted", "invoice_sent", "paid", "lost"] as const;

export default function SchoolControls({
  schoolId,
  status,
  lifecycle,
  trialEndsAt,
  licenceEnd,
  salesStage,
  salesNotes,
  stripeReady,
  invoiceUrl,
}: {
  schoolId: string;
  status: string;
  lifecycle: string;
  trialEndsAt: string | null;
  licenceEnd: string | null;
  salesStage: string | null;
  salesNotes: string | null;
  /** STRIPE_SECRET_KEY exists on this deployment — the invoice lever is live. */
  stripeReady: boolean;
  /** The last issued invoice's hosted page, if any. */
  invoiceUrl: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [extendDays, setExtendDays] = useState("30");
  const [licenceDays, setLicenceDays] = useState("365");
  const [stage, setStage] = useState(salesStage ?? "new");
  const [notes, setNotes] = useState(salesNotes ?? "");
  const [amountMyr, setAmountMyr] = useState("");
  const [dueDays, setDueDays] = useState("30");
  const [invoiceLicenceDays, setInvoiceLicenceDays] = useState("365");
  const [sendEmail, setSendEmail] = useState(true);
  const [issued, setIssued] = useState<{ url: string | null; due: string | null; emailed: boolean } | null>(null);

  async function call(payload: Record<string, unknown>, label: string, done?: string) {
    setBusy(label);
    setError(null);
    setNotice(null);
    const res = await fetch("/api/console/ops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId: schoolId, ...payload }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError(json.error ?? "Something went wrong.");
      return;
    }
    if (json.warning) setNotice(json.warning);
    else if (done) setNotice(done);
    if (label === "invoice") setIssued({ url: json.url ?? null, due: json.due ?? null, emailed: !!json.emailed });
    router.refresh();
  }

  const suspended = status !== "active";
  const days = (s: string) => (s.trim() === "" ? undefined : Number(s));

  return (
    <div className="card p-5 space-y-5">
      <h2 className="font-display font-medium text-lg">Levers</h2>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-[#0C8175]">{notice}</p>}

      {/* Suspend / restore — plan_tier() branch 1: beats a paid licence. */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium text-sm">{suspended ? `School ${status}` : "Suspend school"}</p>
          <p className="text-xs text-[#5B6470]">
            {suspended
              ? "Every member is locked out of generating and the portal address no longer resolves. Restoring puts them straight back on whatever they had."
              : "Locks every member out of generating — paid or not — and hides the portal. Reversible; deletes nothing, keeps everything readable."}
          </p>
        </div>
        <button
          onClick={() => call({ action: suspended ? "school_restore" : "school_suspend" }, "status")}
          disabled={!!busy}
          className={`h-9 px-4 text-sm rounded-lg font-medium ${
            suspended ? "btn-primary" : "bg-[#FFE9E3] text-[#B3401F] hover:bg-[#FFDCD2]"
          }`}
        >
          {busy === "status" ? "…" : suspended ? "Restore" : "Suspend"}
        </button>
      </div>

      {/* Extend trial — from the current end, or from today once it has passed. */}
      <div>
        <p className="font-medium text-sm mb-1">Extend trial</p>
        <p className="text-xs text-[#5B6470] mb-2">
          {trialEndsAt
            ? `Trial ends ${trialEndsAt.slice(0, 10)}. Extending adds days to that date, or to today if it has already passed.`
            : "This school has no trial clock (it predates self-serve). Extending gives it one, starting today — its members move from the individual trial to the school trial."}
          {" "}The 14-generation budget is not reset by an extension; comp credits from the user page for more.
        </p>
        <div className="flex items-end gap-2">
          <label className="block">
            <span className="text-xs text-[#5B6470]">Days</span>
            <input
              type="number"
              min={1}
              max={365}
              value={extendDays}
              onChange={(e) => setExtendDays(e.target.value)}
              className="field h-9 px-2 mt-1 w-24"
            />
          </label>
          <button
            onClick={() => call({ action: "school_extend_trial", days: days(extendDays) }, "extend", "Trial extended.")}
            disabled={!!busy}
            className="btn-ghost h-9 px-4 text-sm"
          >
            {busy === "extend" ? "Saving…" : "Extend"}
          </button>
        </div>
      </div>

      {/* Activate — the bank-transfer lever. Stripe invoices land here on
          their own through the webhook; this is for money that arrived
          outside Stripe. */}
      <div>
        <p className="font-medium text-sm mb-1">{lifecycle === "paid" ? "Renew licence" : "Activate (bank transfer received)"}</p>
        <p className="text-xs text-[#5B6470] mb-2">
          {licenceEnd
            ? `Licensed until ${licenceEnd.slice(0, 10)}. Renewing adds days to that date.`
            : "Writes a manual school licence held by the school's admin — every member becomes a full school account, unmetered. Sets the sales stage to paid."}
          {" "}A suspended school stays suspended until restored.
        </p>
        <div className="flex items-end gap-2">
          <label className="block">
            <span className="text-xs text-[#5B6470]">Days</span>
            <input
              type="number"
              min={1}
              max={1095}
              value={licenceDays}
              onChange={(e) => setLicenceDays(e.target.value)}
              className="field h-9 px-2 mt-1 w-24"
            />
          </label>
          <button
            onClick={() =>
              call({ action: "school_activate", days: days(licenceDays) }, "activate", lifecycle === "paid" ? "Licence renewed." : "School activated.")
            }
            disabled={!!busy}
            className="btn-primary h-9 px-4 text-sm"
          >
            {busy === "activate" ? "Saving…" : lifecycle === "paid" ? "Renew" : "Activate"}
          </button>
        </div>
      </div>

      {/* Issue invoice — the founder's conversion lever (Phase 4). A Stripe
          INVOICE at the quoted amount; its hosted page is the payment link.
          Paying it activates the school through the webhook, no click here. */}
      <div className="pt-1 border-t border-[#EEF0EC]">
        <p className="font-medium text-sm mb-1">{lifecycle === "paid" ? "Invoice a renewal (Stripe)" : "Issue an invoice (Stripe)"}</p>
        <p className="text-xs text-[#5B6470] mb-2">
          {stripeReady
            ? "Bills the school's admin the quoted amount in MYR. Stripe emails the invoice (PDF + hosted payment page) unless you untick it; either way the link appears here to paste into your own email. When it is paid, the licence activates on its own and the stage moves to paid."
            : "Stripe is not configured on this deployment (STRIPE_SECRET_KEY) — the invoice lever is dark. Bank-transfer schools: use Activate above."}
        </p>
        {invoiceUrl && !issued && (
          <p className="text-xs mb-2">
            Last invoice:{" "}
            <a href={invoiceUrl} target="_blank" rel="noreferrer" className="text-[#0C8175] underline break-all">
              {invoiceUrl}
            </a>
          </p>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="text-xs text-[#5B6470]">Amount (MYR)</span>
            <input
              type="number"
              min={1}
              step="0.01"
              value={amountMyr}
              onChange={(e) => setAmountMyr(e.target.value)}
              placeholder="e.g. 3000"
              disabled={!stripeReady}
              className="field h-9 px-2 mt-1 w-32"
            />
          </label>
          <label className="block">
            <span className="text-xs text-[#5B6470]">Due in (days)</span>
            <input
              type="number"
              min={1}
              max={90}
              value={dueDays}
              onChange={(e) => setDueDays(e.target.value)}
              disabled={!stripeReady}
              className="field h-9 px-2 mt-1 w-24"
            />
          </label>
          <label className="block">
            <span className="text-xs text-[#5B6470]">Licence (days)</span>
            <input
              type="number"
              min={1}
              max={1095}
              value={invoiceLicenceDays}
              onChange={(e) => setInvoiceLicenceDays(e.target.value)}
              disabled={!stripeReady}
              className="field h-9 px-2 mt-1 w-24"
            />
          </label>
          <label className="flex items-center gap-1.5 h-9 text-xs text-[#5B6470]">
            <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} disabled={!stripeReady} />
            Stripe emails it
          </label>
          <button
            onClick={() =>
              call(
                {
                  action: "school_issue_invoice",
                  amountMyr: Number(amountMyr),
                  dueDays: days(dueDays),
                  licenceDays: days(invoiceLicenceDays),
                  sendEmail,
                },
                "invoice",
                "Invoice issued.",
              )
            }
            disabled={!!busy || !stripeReady || !amountMyr}
            className="btn-primary h-9 px-4 text-sm"
          >
            {busy === "invoice" ? "Issuing…" : "Issue invoice"}
          </button>
        </div>
        {issued && (
          <p className="text-xs mt-2">
            {issued.emailed ? "Emailed by Stripe. " : "Not emailed — send this link yourself. "}
            {issued.url && (
              <a href={issued.url} target="_blank" rel="noreferrer" className="text-[#0C8175] underline break-all">
                {issued.url}
              </a>
            )}
            {issued.due && <span className="text-[#5B6470]"> · due {issued.due.slice(0, 10)}</span>}
          </p>
        )}
      </div>

      {/* Sales stage + notes — hand-set, never derived (the chip above is). */}
      <div className="pt-1 border-t border-[#EEF0EC]">
        <p className="font-medium text-sm mb-1">Sales</p>
        <p className="text-xs text-[#5B6470] mb-2">
          Your pipeline stage and notes. Private to the console — nothing here is visible to the school.
        </p>
        <div className="space-y-2">
          <select value={stage} onChange={(e) => setStage(e.target.value)} className="field h-9 px-2 w-44">
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            maxLength={2000}
            placeholder="Who you spoke to, what they asked for, what was quoted…"
            className="field w-full px-3 py-2 text-sm"
          />
          <button
            onClick={() => call({ action: "school_set_sales", salesStage: stage, salesNotes: notes }, "sales", "Saved.")}
            disabled={!!busy}
            className="btn-ghost h-9 px-4 text-sm"
          >
            {busy === "sales" ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
