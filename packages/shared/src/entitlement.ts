// Feature entitlement — the single gate both sides use (update.md §4.2/§4.4).
// The control plane decides via the tenant's plan; the enterprise proxy
// decides offline from the verified license payload pushed at bootstrap.
// Free (community) features can never be gated behind a license: only the
// commercial feature sets listed in PLANS[*].features are license-controlled.

import { planOf, type PlanCode } from "./contracts";
import type { LicensePayload } from "./license";

export type EntitlementSource =
  | { kind: "plan"; plan: string | null | undefined }
  | { kind: "license"; payload: LicensePayload | null | undefined };

/** Feature list effective for a source (plan on SaaS, verified license on the proxy). */
export function entitledFeatures(src: EntitlementSource): readonly string[] {
  if (src.kind === "license") {
    return src.payload?.features ?? planOf(null).features;
  }
  return planOf(src.plan).features;
}

/**
 * entitled(account, feature) — the one-call check mandated by the redesign:
 * true when the account's plan (or verified license) includes the feature.
 */
export function entitled(src: EntitlementSource, feature: string): boolean {
  return entitledFeatures(src).includes(feature);
}

/** Convenience: does this plan code unlock commercial (paid) features at all? */
export function isCommercialPlan(plan: string | null | undefined): plan is PlanCode {
  const p = planOf(plan);
  return p.code !== "COMMUNITY" && p.priceMonthly > 0;
}
