// Signed policy snapshots (QA.MD: control-plane -> data-plane sync must be
// signed and immutable). Ed25519: the control plane signs
// `${tenantId}:${snapshotVersion}` with a private key (env
// SNAPSHOT_PRIVATE_KEY_PEM; the bundled dev key is for local development
// only — rotate it in any real deployment), and the enterprise proxy verifies
// it offline with the embedded public key before trusting a new snapshot.

import { createPublicKey, verify as edVerify } from "node:crypto";

// Dev-only public key paired with the dev private key below. Production
// deployments must generate their own keypair and ship the matching public
// key in the agent build.
export const SNAPSHOT_DEV_PUBLIC_KEY_B64 = "MCowBQYDK2VwAyEAOzMIEj7Qx2HFIyyYfs/0pv/gqWronItvPPseVLvVv5A=";

export const SNAPSHOT_DEV_PRIVATE_KEY_PEM_B64 =
  "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1DNENBUUF3QlFZREsyVndCQ0lFSUUzMTlUaS9xUXNUbGVQNTVhNmVnWnlralBKTURGZTl5TXExTjZhcWZiZkUKLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQo=";

export function snapshotSigningPayload(tenantId: string, snapshotVersion: string): string {
  return `${tenantId}:${snapshotVersion}`;
}

export function verifySnapshotSignature(tenantId: string, snapshotVersion: string, signatureB64: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(SNAPSHOT_DEV_PUBLIC_KEY_B64, "base64"),
      type: "spki",
      format: "der",
    });
    return edVerify(
      null,
      Buffer.from(snapshotSigningPayload(tenantId, snapshotVersion), "utf8"),
      key,
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}
