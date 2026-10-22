// Shared types for the Aegis local agent (main process, preload and renderer).
import type { AiGuardConfig, ContentSafetyConfig, TenantLimits } from "@aegis/shared";

export interface AgentConfig {
  controlPlaneUrl: string; // e.g. http://localhost:3000 (no trailing slash)
  deviceKey: string; // akd_...
  gatewayApiKey: string; // ak_... (used to call models through the control plane)
  localPort: number; // local OpenAI-compatible gateway port (default 8931)
  bindHost: string; // gateway listen address: 127.0.0.1 (default) or a LAN IP / 0.0.0.0 for central mode
  locale: "zh" | "en";
  checkIntervalMinutes: number; // reachability check cadence (default 15)
  /** standalone = fully on-premise (local keys/MCP/skills, no SaaS link); connected = paired with the control plane. */
  mode: "standalone" | "connected";
  /** Materialize the capability repo onto native client load locations. */
  materializeSkills: boolean; // write <userData>/skills (canonical Aegis store)
  materializeClaude: boolean; // mirror SKILL.md to ~/.claude/skills + merge ~/.claude.json mcpServers.aegis
  materializeWorkBuddy: boolean; // mirror to ~/.workbuddy/skills + merge ~/.workbuddy/mcp.json
  /** Local guardrail config, enforced in standalone mode (connected mode uses the bootstrap-pushed tenant config). */
  contentSafety: ContentSafetyConfig;
  limits: TenantLimits;
  /** AI 决策式策略评估（独立模式用本地配置；连接模式用 bootstrap 下发的租户配置）。 */
  aiGuard: AiGuardConfig;
}

export interface DeviceInfo {
  id: string;
  name: string;
  tenantId: string;
}

export interface CachedPolicy {
  id: string;
  name: string;
  effect: "ALLOW" | "DENY";
  action: string;
  subjectType: string;
  subjectId: string;
  resource: string;
  env: string;
  version?: number;
  /** ABAC extension: `{ expr }` conditions document (see shared/policy-expr.ts). */
  conditions?: unknown;
}

export interface CatalogEndpoint {
  id: string;
  key: string;
  name: { zh: string; en: string };
  category: { zh: string; en: string };
  vendor: string;
  domains: string[];
  langs: string[];
}

// ---- edge direct mode (bootstrap) ----

export interface EdgeCredential {
  id: string;
  provider: string;
  label: string;
  baseUrl: string;
  models: string[]; // empty => any model
  apiKeyEnc: string; // AES-256-GCM v1 envelope, decrypted locally with DATA_KEY
}

export interface McpEntitlement {
  id: string;
  name: string;
  endpoint: string;
  transport: string; // STREAMABLE_HTTP | STDIO
  riskLevel: string;
  authType: string; // NONE | API_KEY | OAUTH | MTLS
  authTokenEnc: string; // AES-256-GCM envelope; decrypted locally and injected upstream
  allowedAgentIds: string[]; // empty => every caller
  tools?: { name: string; requiresApproval: boolean; riskLevel: string }[]; // runtime approval gate registry
}

export interface SkillEntitlement {
  id: string;
  name: string;
  source: string;
  description: string;
  allowedAgentIds: string[];
  activeVersion: { version: string; content: string; format: string } | null;
}

export interface MeterEvent {
  eventId: string; // uuid, also the trace id (idempotency key server-side)
  apiKeyId: string; // edge credential id (relay: empty)
  agentId: string;
  agentVersion: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  latencyMs: number;
  status: "SUCCESS" | "ERROR";
  cost: number; // 0 locally; control plane recomputes from price versions
  traceId: string;
  occurredAt: string; // ISO
  /** Small typed extras, e.g. { aiGuard: true } marks AI-policy-judgment metering. */
  metadata?: Record<string, unknown>;
}

/**
 * Per-call governance event captured on the enterprise proxy so edge-direct
 * traffic lands in the cloud audit chain (relay traffic is audited by the
 * control plane itself). Metadata only — never message bodies, secrets or
 * response content. `detail` holds small typed extras (hit categories, token
 * counts, cost, error codes, policy reasons).
 */
export interface EdgeAuditEvent {
  eventId: string; // uuid; control plane is idempotent on (tenant, device, eventId)
  ts: string; // ISO occurredAt
  type:
    | "policy_evaluated"
    | "model_response"
    | "model_error"
    | "content_blocked"
    | "rate_limited"
    | "budget_exceeded"
    | "tool_invoked"
    | "ai_decision";
  agentId: string; // "" for anonymous loopback callers
  agentVersion: string;
  model: string; // "" where not applicable (tool calls, discovery)
  traceId: string;
  tool: string; // aggregated tool name for tool_invoked
  outcome: "ALLOW" | "DENY" | "ERROR" | "SUCCESS";
  detail: Record<string, unknown>;
  cost: number; // locally computed cost for model_response
}

export interface ReachResult {
  endpointId: string;
  reachable: boolean;
  statusCode?: number;
  latencyMs?: number;
  checkedAt: string; // ISO
  detail: string;
}

export type LogLevel = "info" | "warn" | "error";
export interface LogEntry {
  ts: number;
  level: LogLevel;
  kind: string; // bootstrap | probe | sync | gateway | config
  message: string;
}

export interface BootstrapState {
  status: "none" | "ok" | "error" | "standalone"; // standalone = SaaS-less on-premise mode
  at: string | null;
  error: string | null;
}

// Item 20: latest release reported by the control plane's public release
// channel (GET /api/releases/latest), surfaced as a dismissible banner.
export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
  notes: string;
  checkedAt: string;
  updateAvailable: boolean;
}

// Item 19: activation-wizard payload + result (POST /api/agent/activate).
export interface ActivationInput {
  platformUrl: string;
  code: string;
  deviceName: string;
}

export interface ActivationResult {
  ok: boolean;
  device?: { id: string; name: string; status: string };
  error?: { code: string; message: string };
}

export interface StateSnapshot {
  version: string;
  online: boolean;
  checking: boolean;
  config: AgentConfig;
  gateway: { running: boolean; port: number; url: string };
  device: DeviceInfo | null;
  endpoint: { hostIp: string; gatewayPort: number };
  bootstrap: BootstrapState;
  policies: { count: number; cachedAt: string | null };
  catalog: { count: number; source: "bootstrap" | "builtin"; endpoints: CatalogEndpoint[] };
  edge: {
    mode: "edge" | "relay";
    credentials: number;
    meterPending: number;
    mcp: number;
    skills: number;
  };
  lastCheck: { at: string | null; total: number; reachable: number; unreachable: number };
  results: ReachResult[];
  queue: { pending: number };
  update: UpdateInfo | null;
  /** Commercial entitlement verified offline from the bootstrap license token. */
  license: { plan: string; valid: boolean; expiresAt: string; reason: string } | null;
  /** Ed25519 signature over `${tenantId}:${snapshotVersion}` verified locally. */
  snapshotVerified: boolean;
  /** Standalone (SaaS-less) local capability stores; active in both modes, merged when connected. */
  local: { credentials: number; mcp: number; skills: number };
  /** Lifetime billing totals (standalone); also usable as a session view when connected. */
  meterTotals: { events: number; promptTokens: number; completionTokens: number; totalCost: number };
}

export type LogFn = (level: LogLevel, kind: string, message: string) => void;

export const IPC = {
  getState: "aegis:getState",
  saveConfig: "aegis:saveConfig",
  runCheck: "aegis:runCheck",
  refreshBootstrap: "aegis:refreshBootstrap",
  activate: "aegis:activate",
  openExternal: "aegis:openExternal",
  pushState: "aegis:pushState",
  pushLog: "aegis:pushLog",
  getLocal: "aegis:getLocal",
  saveLocalCredential: "aegis:saveLocalCredential",
  deleteLocalCredential: "aegis:deleteLocalCredential",
  saveLocalMcp: "aegis:saveLocalMcp",
  deleteLocalMcp: "aegis:deleteLocalMcp",
  saveLocalSkill: "aegis:saveLocalSkill",
  deleteLocalSkill: "aegis:deleteLocalSkill",
  saveLocalPrice: "aegis:saveLocalPrice",
  deleteLocalPrice: "aegis:deleteLocalPrice",
  saveLocalAgent: "aegis:saveLocalAgent",
  deleteLocalAgent: "aegis:deleteLocalAgent",
} as const;
