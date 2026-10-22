import type { McpEntitlement, SkillEntitlement } from "./types";

export interface EntitlementDecision {
  allow: boolean;
  reason: string; // authorized | mcp_not_authorized | mcp_forbidden | ...
}

/**
 * MCP / Skill entitlement checks against the authorization views pushed in
 * bootstrap. `allowedAgentIds` empty => available to every caller; otherwise
 * the caller must present a known agentId (x-aegis-agent) that is listed.
 * Fail closed when there is no cached view at all.
 */
export function checkMcpEntitlement(view: McpEntitlement | undefined, agentId: string): EntitlementDecision {
  if (!view) return { allow: false, reason: "mcp_not_authorized" };
  if (view.allowedAgentIds.length === 0) return { allow: true, reason: "authorized" };
  if (agentId && view.allowedAgentIds.includes(agentId)) return { allow: true, reason: "authorized" };
  return { allow: false, reason: "mcp_forbidden" };
}

export function checkSkillEntitlement(view: SkillEntitlement | undefined, agentId: string): EntitlementDecision {
  if (!view) return { allow: false, reason: "skill_not_authorized" };
  if (view.allowedAgentIds.length === 0) return { allow: true, reason: "authorized" };
  if (agentId && view.allowedAgentIds.includes(agentId)) return { allow: true, reason: "authorized" };
  return { allow: false, reason: "skill_forbidden" };
}
