import { getOrder } from "@lemonsqueezy/lemonsqueezy.js";
import { ensureLemonSqueezy } from "./client";
import { getPlan, planKeyForVariant } from "@/utils/stripe/plans";

// Founding cohort detection. Founding = the Teacher Pro product bought with the
// FOUNDINGTEACHER discount ($10/mo, price-locked 24 months). LS does not put the
// discount code on the subscription object, so we look at the ORDER: a Teacher
// Pro order carrying a non-zero discount is treated as founding. Best-effort and
// server-only — the webhook never blocks the grant on this.
export async function detectFoundingFromOrder(args: {
  order_id?: string | number | null;
  variant_id?: string | number | null;
}): Promise<boolean> {
  // Only Teacher Pro is eligible for the founding offer — skip the API call for
  // anything else (and for unmapped variants).
  const planKey = planKeyForVariant(args.variant_id);
  const plan = planKey ? getPlan(planKey) : null;
  if (!plan || plan.tier !== "teacher_pro") return false;
  if (args.order_id === null || args.order_id === undefined || args.order_id === "") return false;

  ensureLemonSqueezy();
  const res = await getOrder(String(args.order_id));
  if (res.error) return false;
  const discount = Number(res.data?.data?.attributes?.discount_total ?? 0);
  return discount > 0;
}
