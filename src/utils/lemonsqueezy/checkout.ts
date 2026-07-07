import { createCheckout } from "@lemonsqueezy/lemonsqueezy.js";
import { ensureLemonSqueezy, lemonSqueezyStoreId } from "./client";

// Create a Lemon Squeezy hosted checkout (redirect). `custom` is our
// passthrough — LS echoes it back on every webhook as meta.custom_data, and
// the webhook signature proves it came from the checkout WE created. Card data
// never touches us. Returns only the hosted checkout URL.

export async function createLsCheckout(args: {
  variantId: string;
  userId: string;
  planKey: string;
  email: string | null;
  redirectUrl: string;
}): Promise<string> {
  ensureLemonSqueezy();
  const storeId = lemonSqueezyStoreId();

  const res = await createCheckout(storeId, args.variantId, {
    checkoutData: {
      email: args.email ?? undefined,
      custom: { user_id: args.userId, plan_key: args.planKey },
    },
    productOptions: {
      redirectUrl: args.redirectUrl,
    },
    checkoutOptions: {
      embed: false,
    },
  });

  if (res.error) {
    throw new Error(`Lemon Squeezy checkout failed: ${res.error.message}`);
  }
  const url = res.data?.data?.attributes?.url;
  if (!url) throw new Error("Lemon Squeezy returned no checkout URL.");
  return url;
}
