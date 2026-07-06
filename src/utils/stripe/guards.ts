// Billing guards — applied in EVERY billing/portal/status route, server-side.
// Hiding UI is not enforcement; these are.

export class BillingGuardError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Adults only. A student account must never see, reach, or call a checkout
 * or portal endpoint. `coordinator` is a teacher under the multi-role model
 * (adults-implicitly-teach), so it counts as an adult here. */
export function assertAdultRole(role: string | null | undefined): void {
  const adults = ["teacher", "parent", "school_admin", "coordinator"];
  if (!role || !adults.includes(role)) {
    throw new BillingGuardError("Billing is not available for this account.", 403);
  }
}

/** Global kill-switch (BILLING_ENABLED env) plus a per-school opt-out
 * (schools.billing_enabled = false). Billing stays OFF until we flip it. */
export function assertBillingEnabled(school?: { billing_enabled?: boolean | null } | null): void {
  if (process.env.BILLING_ENABLED !== "true") {
    throw new BillingGuardError("Billing isn't enabled yet.", 403);
  }
  if (school && school.billing_enabled === false) {
    throw new BillingGuardError("Billing isn't enabled for your school.", 403);
  }
}

/** Cross-tenant guard: both sides must refer to the same tenant. Null-safe —
 * two independents (no school) match only when both are null AND the user ids
 * were already matched by the caller. */
export function assertTenantMatch(a: string | null | undefined, b: string | null | undefined): void {
  if ((a ?? null) !== (b ?? null)) {
    throw new BillingGuardError("Tenant mismatch.", 403);
  }
}
