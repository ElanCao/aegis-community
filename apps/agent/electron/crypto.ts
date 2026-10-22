import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Mirrors packages/db crypto.ts (AES-256-GCM, envelope "v1.<iv>.<tag>.<ct>").
// The control plane encrypts provider credentials with its DATA_KEY; paired
// devices receive the same key during provisioning so the local protected
// process can inject the upstream key without it leaving the machine.
//
// Standalone mode (no SaaS): DATA_KEY is absent, so secrets are sealed with a
// machine-local key generated on first run (userData/local/.key) — keys still
// never leave the enterprise, and the proxy runs fully offline.

const ALGO = "aes-256-gcm";
let localKeyFile = "";
let localKey: Buffer | null = null;

/** Point the fallback key at a persisted, machine-local key file (created on demand). */
export function initLocalKey(userData: string): void {
  localKeyFile = path.join(userData, "local", ".key");
}

function loadLocalKey(): Buffer {
  if (localKey) return localKey;
  try {
    const raw = fs.readFileSync(localKeyFile, "utf8").trim();
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      localKey = Buffer.from(raw, "hex");
      return localKey;
    }
  } catch {
    /* first run */
  }
  const generated = randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(localKeyFile), { recursive: true });
  fs.writeFileSync(localKeyFile, generated, { encoding: "utf8", mode: 0o600 });
  localKey = Buffer.from(generated, "hex");
  return localKey;
}

function dataKey(): Buffer {
  const raw = process.env.DATA_KEY ?? "";
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  if (raw.length >= 32) return createHash("sha256").update(raw, "utf8").digest();
  if (localKeyFile) return loadLocalKey();
  if (process.env.NODE_ENV === "production") {
    throw new Error("DATA_KEY must be a 64-char hex string (or >=32 char secret) in production");
  }
  return createHash("sha256").update("aegis-insecure-dev-key", "utf8").digest();
}

export function decryptSecret(payload: string): string {
  const [v, ivB64, tagB64, ctB64] = payload.split(".");
  if (v !== "v1" || !ivB64 || !tagB64 || !ctB64) throw new Error("invalid secret payload");
  const decipher = createDecipheriv(ALGO, dataKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, dataKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}
