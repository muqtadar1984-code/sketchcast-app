import type Stripe from "stripe";

// A school licence sold the way schools actually buy: the founder issues a
// Stripe INVOICE from the console at the quoted MYR amount, and Stripe's hosted
// invoice page is "the payment link" on it (Phase 4 of the self-serve plan).
//
// Why an Invoice and not a Checkout Session: a Checkout Session expires after
// at most 24 hours, which is useless attached to an invoice a school pays in
// two weeks. An invoice with collection_method=send_invoice has a real due
// date, a hosted page that stays valid, a PDF, and Stripe can email it.
//
// Why not a `send_invoice` SUBSCRIPTION for the annual plan: Stripe marks such
// a subscription `active` the moment it is created, before anyone pays — and
// plan_tier() would grant the school on that status. A one-off licence with a
// renewal invoice a year later avoids the trap entirely.
//
// The licence window rides on the invoice's METADATA, set here and immutable
// to the payer: the webhook's invoice.paid branch reads licence_days and
// extend_from and never has to look the school's entitlement up itself.

export type SchoolInvoiceInput = {
  customerId: string;
  userId: string;
  schoolId: string;
  schoolName: string;
  /** Whole sen (MYR minor units). */
  amountSen: number;
  daysUntilDue: number;
  licenceDays: number;
  /** The current licence end, when renewing; the webhook extends from
   *  max(now, extendFrom). Null for a first licence. */
  extendFrom: string | null;
  /** Staff id, for the audit trail on the Stripe side. */
  issuedBy: string;
  /** Let Stripe email the invoice (hosted page + PDF) to the customer. */
  sendEmail: boolean;
};

export type SchoolInvoice = {
  invoiceId: string;
  hostedUrl: string | null;
  pdfUrl: string | null;
  amountSen: number;
  dueDate: string | null;
  status: string | null;
};

export const SCHOOL_INVOICE_PLAN_KEY = "school_onetime";

export async function issueSchoolInvoice(
  s: Pick<Stripe, "invoices" | "invoiceItems">,
  input: SchoolInvoiceInput,
): Promise<SchoolInvoice> {
  if (!Number.isInteger(input.amountSen) || input.amountSen < 100) {
    throw new Error("amountSen must be a whole number of sen, at least 100.");
  }
  const metadata: Record<string, string> = {
    user_id: input.userId,
    school_id: input.schoolId,
    plan_key: SCHOOL_INVOICE_PLAN_KEY,
    licence_days: String(input.licenceDays),
    extend_from: input.extendFrom ?? "",
    issued_by: input.issuedBy,
  };
  const description = `SketchCast school licence — ${input.schoolName} — ${input.licenceDays} days`;

  // Draft first, item second (bound to the draft by id — never left pending on
  // the customer for some other invoice to sweep up), then finalize.
  // auto_advance=false: nothing about this invoice moves without us.
  const draft = await s.invoices.create({
    customer: input.customerId,
    collection_method: "send_invoice",
    days_until_due: input.daysUntilDue,
    currency: "myr",
    auto_advance: false,
    pending_invoice_items_behavior: "exclude",
    description,
    metadata,
  });
  await s.invoiceItems.create({
    customer: input.customerId,
    invoice: draft.id,
    amount: input.amountSen,
    currency: "myr",
    description,
    metadata,
  });
  const finalized = await s.invoices.finalizeInvoice(draft.id);
  if (input.sendEmail) {
    await s.invoices.sendInvoice(draft.id);
  }
  return {
    invoiceId: finalized.id,
    hostedUrl: finalized.hosted_invoice_url ?? null,
    pdfUrl: finalized.invoice_pdf ?? null,
    amountSen: input.amountSen,
    dueDate: finalized.due_date ? new Date(finalized.due_date * 1000).toISOString() : null,
    status: finalized.status ?? null,
  };
}
