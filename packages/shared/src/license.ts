// License tokens: enterprise-feature entitlement signed by the control plane.
// HMAC-SHA256, base64url, format `v1.<payload>.<signature>`. The enterprise
// proxy verifies offline against a shared secret (client-side licensing is
// inherently best-effort — see QA.MD open-core model; the authoritative
// enforcement stays server-side in plan limits).

import { createHmac, timingSafeEqual } from "node:crypto";

export interface LicensePayload {
  tenantId: string;
  plan: string;
  features: string[];
  expiresAt: string; // ISO timestamp, "" = perpetual
  nonce: string; // rotates on re-issue, enables revocation by replacement
}

// Client-side licensing is best-effort (the agent ships to untrusted hosts);
// server-side plan limits are the authoritative enforcement. Self-hosted
// enterprise customers sign their own agent builds with their own secret.
export const DEFAULT_LICENSE_SECRET = "dev-aegis-license-secret-change-me";

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function signLicense(payload: LicensePayload, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac("sha256", secret).update(body).digest());
  return `v1.${body}.${sig}`;
}

export interface LicenseVerification {
  valid: boolean;
  payload?: LicensePayload;
  reason?: "malformed" | "bad_signature" | "wrong_tenant" | "expired";
}

export function verifyLicense(token: string, secret: string, tenantId: string): LicenseVerification {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { valid: false, reason: "malformed" };
  const body = parts[1];
  const sig = parts[2];
  if (!body || !sig) return { valid: false, reason: "malformed" };
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest());
  const got = Buffer.from(sig, "base64url");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    return { valid: false, reason: "bad_signature" };
  }
  let payload: LicensePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as LicensePayload;
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (payload.tenantId !== tenantId) return { valid: false, reason: "wrong_tenant" };
  if (payload.expiresAt && Date.parse(payload.expiresAt) < Date.now()) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, payload };
}
