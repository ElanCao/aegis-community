import { evaluateConditions } from "@aegis/shared";
import type { CachedPolicy } from "./types";

export interface LocalDecision {
  allow: boolean;
  reason: string; // cached_empty | explicit_allow | explicit_deny | default_deny
  policyName?: string;
  conditionError?: string;
}

export interface LocalEvalInput {
  policies: CachedPolicy[] | null;
  action: string; // e.g. "model:invoke" | "mcp:invoke" | "skill:use" | ...
  resource: string; // model name, aggregated tool name, skill id, or "*"
  agentId?: string; // caller agent (x-aegis-agent or authenticated local token)
  /** Variables exposed to conditions expressions (model/agent/tenant/usage/subject). */
  expr?: Record<string, unknown>;
}

/**
 * Offline evaluation of a policy action against the cached control-plane
 * policy set. Mirrors the control-plane evaluator (apps/web/src/lib/policies.ts):
 * DENY wins over ALLOW, no matching ALLOW => default deny, and a rule whose
 * conditions expression fails/errors does not hit (fail-closed for DENY: an
 * errored expression disables the DENY rule but is reported in conditionError).
 * When there is no policy cache at all (never bootstrapped) requests pass
 * through and are flagged `cached_empty`. The local gateway has no
 * authenticated console identity, so only EVERYONE rules apply; AGENT-scoped
 * rules match when the caller passes x-aegis-agent.
 */
export function evaluateAction(input: LocalEvalInput): LocalDecision {
  if (!input.policies) return { allow: true, reason: "cached_empty" };

  let allowRule: CachedPolicy | null = null;
  let conditionError: string | undefined;
  for (const p of input.policies) {
    if (p.action !== input.action) continue;
    if (p.resource !== "*" && p.resource !== input.resource) continue;
    if (p.env !== "*" && p.env !== "prod") continue;
    if (p.subjectType !== "EVERYONE") {
      if (!(p.subjectType === "AGENT" && input.agentId && p.subjectId === input.agentId)) continue;
    }
    const c = p.conditions as { expr?: unknown } | null;
    if (c !== null && typeof c === "object" && typeof c.expr === "string" && c.expr.trim() !== "") {
      const r = evaluateConditions(c, input.expr ?? {});
      if (r.result !== "pass") {
        if (p.effect === "DENY" && r.error) conditionError = `${p.name}: ${r.error}`;
        continue;
      }
    }
    if (p.effect === "DENY") {
      return { allow: false, reason: "explicit_deny", policyName: p.name, conditionError };
    }
    if (!allowRule) allowRule = p;
  }
  if (allowRule) return { allow: true, reason: "explicit_allow", policyName: allowRule.name, conditionError };
  return { allow: false, reason: "default_deny", conditionError };
}

/** Back-compat wrapper for the model:invoke chat pipeline. */
export function evaluateModelInvoke(
  policies: CachedPolicy[] | null,
  model: string,
  agentId = "",
  expr?: Record<string, unknown>
): LocalDecision {
  return evaluateAction({ policies, action: "model:invoke", resource: model, agentId, expr });
}
