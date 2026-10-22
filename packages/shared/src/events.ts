import { z } from "zod";
import { createHash } from "node:crypto";

// Audit & metering share one execution fact (PRD 7.7). The envelope below is the
// control-plane storage/transport shape; hash chaining makes tampering evident.

export const AUDIT_EVENT_TYPES = [
  "user_login",
  "session_minted",
  "agent_registered",
  "version_published",
  "agent_deprecated",
  "policy_evaluated",
  "approval_required",
  "approval_decided",
  "model_request",
  "model_response",
  "model_error",
  "tool_discovered",
  "tool_authorized",
  "tool_invoked",
  "credential_created",
  "credential_rotated",
  "device_registered",
  "reachability_reported",
  "public_ai_detected",
  "meter_emitted",
  "budget_threshold",
  "content_blocked",
  "rate_limited",
  "budget_exceeded",
  "ai_decision",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const auditEventSchema = z.object({
  event_id: z.string().uuid(),
  event_type: z.enum(AUDIT_EVENT_TYPES),
  tenant_id: z.string(),
  env: z.string().default("prod"),
  occurred_at: z.string(), // ISO
  received_at: z.string(), // ISO
  trace_id: z.string().default(""),
  span_id: z.string().default(""),
  actor: z.object({ type: z.enum(["USER", "AGENT", "DEVICE", "SYSTEM"]), id: z.string(), name: z.string().default("") }),
  on_behalf_of: z.string().default(""),
  agent_id: z.string().default(""),
  agent_version: z.string().default(""),
  tool: z.string().default(""),
  policy_version: z.string().default(""),
  location: z.string().default(""),
  risk_level: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("LOW"),
  outcome: z.enum(["ALLOW", "DENY", "ERROR", "SUCCESS"]),
  metadata: z.record(z.unknown()).default({}),
  cost: z.number().default(0),
  currency: z.string().default("CNY"),
  // hash chain (computed by control plane at ingest)
  hash: z.string().default(""),
  prev_hash: z.string().default(""),
});
export type AuditEventEnvelope = z.infer<typeof auditEventSchema>;

export const usageEventSchema = z.object({
  event_id: z.string().uuid(),
  tenant_id: z.string(),
  api_key_id: z.string().default(""),
  device_id: z.string().default(""),
  agent_id: z.string().default(""),
  agent_version: z.string().default(""),
  provider: z.string(),
  model: z.string(),
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  cached: z.boolean().default(false),
  latency_ms: z.number().nonnegative().default(0),
  status: z.enum(["SUCCESS", "ERROR"]),
  price_version: z.string().default(""),
  unit_cost: z.number().default(0), // computed cost in CNY (or currency)
  currency: z.string().default("CNY"),
  trace_id: z.string().default(""),
  occurred_at: z.string(),
});
export type UsageEventEnvelope = z.infer<typeof usageEventSchema>;

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// Deterministic canonicalization: PostgreSQL jsonb reorders object keys, so
// any object field must be key-sorted (recursively) before hashing — otherwise
// verify recomputes a different string than write time and the chain "breaks".
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonicalize((v as Record<string, unknown>)[k])])
    );
  }
  return v;
}

export function canonicalEventForHash(e: Omit<AuditEventEnvelope, "hash" | "prev_hash">): string {
  return JSON.stringify({
    event_id: e.event_id,
    event_type: e.event_type,
    tenant_id: e.tenant_id,
    occurred_at: e.occurred_at,
    trace_id: e.trace_id,
    actor: canonicalize(e.actor),
    agent_id: e.agent_id,
    tool: e.tool,
    outcome: e.outcome,
    metadata: canonicalize(e.metadata),
  });
}
