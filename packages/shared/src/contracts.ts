import { z } from "zod";

// ---------------------------------------------------------------------------
// Roles (PRD section 3, mapped to a practical RBAC enum for MVP)
// ---------------------------------------------------------------------------
export const ROLES = [
  "OWNER", // 平台所有者 (tenant creator)
  "TENANT_ADMIN", // 租户管理员
  "SECURITY", // 安全/合规管理员
  "AGENT_OWNER", // Agent 所有者
  "MCP_OWNER", // MCP 所有者
  "SKILL_OWNER", // Skill 所有者
  "FINANCE", // 财务运营管理员
  "AUDITOR", // 审计员/分析师
  "MEMBER", // 用户/Agent 调用者
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, { zh: string; en: string }> = {
  OWNER: { zh: "平台所有者", en: "Platform Owner" },
  TENANT_ADMIN: { zh: "租户管理员", en: "Tenant Admin" },
  SECURITY: { zh: "安全/合规管理员", en: "Security & Compliance" },
  AGENT_OWNER: { zh: "Agent 所有者", en: "Agent Owner" },
  MCP_OWNER: { zh: "MCP 所有者", en: "MCP Owner" },
  SKILL_OWNER: { zh: "Skill 所有者", en: "Skill Owner" },
  FINANCE: { zh: "财务运营管理员", en: "Finance Operations" },
  AUDITOR: { zh: "审计员", en: "Auditor" },
  MEMBER: { zh: "成员", en: "Member" },
};

// Which console sections each role may access (server-enforced + UI nav filter)
export const ROLE_SECTIONS: Record<Role, string[]> = {
  OWNER: ["dashboard", "agents", "mcp", "skill", "gateway", "policies", "approvals", "audit", "billing", "credentials", "devices", "reachability", "settings", "members", "roles"],
  TENANT_ADMIN: ["dashboard", "agents", "mcp", "skill", "gateway", "policies", "approvals", "audit", "billing", "credentials", "devices", "reachability", "settings", "members", "roles"],
  SECURITY: ["dashboard", "agents", "mcp", "skill", "policies", "approvals", "audit", "reachability"],
  AGENT_OWNER: ["dashboard", "agents", "mcp", "skill", "audit", "gateway"],
  MCP_OWNER: ["dashboard", "mcp", "audit"],
  SKILL_OWNER: ["dashboard", "skill", "audit"],
  FINANCE: ["dashboard", "billing", "audit"],
  AUDITOR: ["dashboard", "audit", "billing", "reachability"],
  MEMBER: ["dashboard", "agents", "gateway"],
};

// ---------------------------------------------------------------------------
// Domain enums
// ---------------------------------------------------------------------------
export const DATA_CLASSES = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "SECRET"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export const DATA_CLASS_LABELS: Record<DataClass, { zh: string; en: string }> = {
  PUBLIC: { zh: "公开", en: "Public" },
  INTERNAL: { zh: "内部", en: "Internal" },
  CONFIDENTIAL: { zh: "机密", en: "Confidential" },
  SECRET: { zh: "绝密", en: "Secret" },
};

export const AGENT_STATUSES = ["DRAFT", "ACTIVE", "SUSPENDED", "DEPRECATED"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const AGENT_STATUS_LABELS: Record<AgentStatus, { zh: string; en: string }> = {
  DRAFT: { zh: "草稿", en: "Draft" },
  ACTIVE: { zh: "已上线", en: "Active" },
  SUSPENDED: { zh: "已暂停", en: "Suspended" },
  DEPRECATED: { zh: "已下线", en: "Deprecated" },
};

export const AGENT_TYPES = ["SHARED", "USER_SIDE", "CLOUD"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const AGENT_TYPE_LABELS: Record<AgentType, { zh: string; en: string }> = {
  SHARED: { zh: "企业共享", en: "Enterprise-shared" },
  USER_SIDE: { zh: "用户侧", en: "User-side" },
  CLOUD: { zh: "云Agent", en: "Cloud" },
};

// Agent product subtypes per type. `logo` renders as a brand-colored initial
// avatar (inline SVG) — dependency-free.
export interface AgentSubtype {
  code: string;
  type: AgentType;
  label: { zh: string; en: string };
  logo: { color: string; initials: string };
}

export const AGENT_SUBTYPES: AgentSubtype[] = [
  // 企业共享（IT 统一部署）
  { code: "dify", type: "SHARED", label: { zh: "Dify", en: "Dify" }, logo: { color: "#10b981", initials: "Di" } },
  { code: "n8n", type: "SHARED", label: { zh: "n8n", en: "n8n" }, logo: { color: "#ea4b71", initials: "n8" } },
  { code: "flowise", type: "SHARED", label: { zh: "Flowise", en: "Flowise" }, logo: { color: "#8b5cf6", initials: "Fl" } },
  { code: "langflow", type: "SHARED", label: { zh: "LangFlow", en: "LangFlow" }, logo: { color: "#2563eb", initials: "La" } },
  { code: "coze-ent", type: "SHARED", label: { zh: "扣子（企业版）", en: "Coze (Enterprise)" }, logo: { color: "#0ea5e9", initials: "Co" } },
  { code: "other-shared", type: "SHARED", label: { zh: "其它", en: "Other" }, logo: { color: "#64748b", initials: "?" } },
  // 用户侧（用户电脑上安装）
  { code: "claude-code", type: "USER_SIDE", label: { zh: "Claude Code", en: "Claude Code" }, logo: { color: "#d97706", initials: "Cl" } },
  { code: "workbuddy", type: "USER_SIDE", label: { zh: "WorkBuddy", en: "WorkBuddy" }, logo: { color: "#0891b2", initials: "Wb" } },
  { code: "openclaw", type: "USER_SIDE", label: { zh: "OpenClaw", en: "OpenClaw" }, logo: { color: "#dc2626", initials: "Oc" } },
  { code: "copilot", type: "USER_SIDE", label: { zh: "GitHub Copilot", en: "GitHub Copilot" }, logo: { color: "#0d9488", initials: "Cp" } },
  { code: "cursor", type: "USER_SIDE", label: { zh: "Cursor", en: "Cursor" }, logo: { color: "#1e293b", initials: "Cu" } },
  { code: "cline", type: "USER_SIDE", label: { zh: "Cline", en: "Cline" }, logo: { color: "#7c3aed", initials: "Cl" } },
  { code: "other-user", type: "USER_SIDE", label: { zh: "其它", en: "Other" }, logo: { color: "#64748b", initials: "?" } },
  // 云 Agent（云平台托管）
  { code: "feishu", type: "CLOUD", label: { zh: "飞书智能伙伴", en: "Feishu AI" }, logo: { color: "#3370ff", initials: "Fe" } },
  { code: "dingtalk", type: "CLOUD", label: { zh: "钉钉 AI 助理", en: "DingTalk AI" }, logo: { color: "#1e88e5", initials: "Dt" } },
  { code: "aliyun-bailian", type: "CLOUD", label: { zh: "阿里云百炼", en: "Aliyun Bailian" }, logo: { color: "#f59e0b", initials: "Al" } },
  { code: "tencent-yuanqi", type: "CLOUD", label: { zh: "腾讯元器", en: "Tencent Yuanqi" }, logo: { color: "#2563eb", initials: "Tx" } },
  { code: "coze", type: "CLOUD", label: { zh: "扣子", en: "Coze" }, logo: { color: "#0ea5e9", initials: "Co" } },
  { code: "other-cloud", type: "CLOUD", label: { zh: "其它", en: "Other" }, logo: { color: "#64748b", initials: "?" } },
];

export function subtypesOf(type: AgentType): AgentSubtype[] {
  return AGENT_SUBTYPES.filter((s) => s.type === type);
}
export function subtypeMeta(code: string): AgentSubtype | undefined {
  return AGENT_SUBTYPES.find((s) => s.code === code);
}

export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

// Generic bilingual labels for status/outcome/risk tokens that have no dedicated
// label map. Pages must never render raw enum English.
export const STATUS_LABELS: Record<string, { zh: string; en: string }> = {
  // lifecycle statuses
  DRAFT: { zh: "草稿", en: "Draft" },
  ACTIVE: { zh: "生效", en: "Active" },
  SUSPENDED: { zh: "已暂停", en: "Suspended" },
  DEPRECATED: { zh: "已下线", en: "Deprecated" },
  RETIRED: { zh: "已退役", en: "Retired" },
  DISABLED: { zh: "已停用", en: "Disabled" },
  REVOKED: { zh: "已吊销", en: "Revoked" },
  // approvals
  PENDING: { zh: "待审批", en: "Pending" },
  APPROVED: { zh: "已批准", en: "Approved" },
  REJECTED: { zh: "已拒绝", en: "Rejected" },
  EXPIRED: { zh: "已过期", en: "Expired" },
  // outcomes
  ALLOW: { zh: "允许", en: "Allow" },
  DENY: { zh: "拒绝", en: "Deny" },
  SUCCESS: { zh: "成功", en: "Success" },
  ERROR: { zh: "失败", en: "Error" },
  // risk levels
  LOW: { zh: "低", en: "Low" },
  MEDIUM: { zh: "中", en: "Medium" },
  HIGH: { zh: "高", en: "High" },
  CRITICAL: { zh: "严重", en: "Critical" },
  // data classes
  PUBLIC: { zh: "公开", en: "Public" },
  INTERNAL: { zh: "内部", en: "Internal" },
  CONFIDENTIAL: { zh: "机密", en: "Confidential" },
  SECRET: { zh: "绝密", en: "Secret" },
  // misc
  MARKDOWN: { zh: "Markdown", en: "Markdown" },
  CODE: { zh: "代码", en: "Code" },
};

export const POLICY_EFFECTS = ["ALLOW", "DENY"] as const;
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

export const POLICY_ACTIONS = [
  "model:invoke",
  "tool:execute",
  "mcp:invoke",
  "skill:use",
  "agent:register",
  "agent_version:publish",
  "mcp:discover",
  "audit:export",
  "policy:override",
] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

export const PROVIDERS = ["DEEPSEEK", "OPENAI", "AZURE_OPENAI", "CUSTOM_OPENAI_COMPATIBLE"] as const;
export type Provider = (typeof PROVIDERS)[number];

// ---------------------------------------------------------------------------
// Provider catalog (Item 9): centrally-maintained directory of model vendors
// and third-party relay platforms. Tenants read it; only SaaS platform super
// admins manage it (api/platform/providers).
// ---------------------------------------------------------------------------
export const PROVIDER_KINDS = ["VENDOR", "THIRDPARTY"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PROVIDER_STATUSES = ["ACTIVE", "DISABLED"] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const providerCodeSchema = z
  .string()
  .min(2)
  .max(50)
  .regex(/^[a-z0-9-]+$/, "code: lowercase letters, digits and dashes only");

export const providerCreateSchema = z.object({
  code: providerCodeSchema,
  kind: z.enum(PROVIDER_KINDS),
  nameZh: z.string().min(1).max(100),
  nameEn: z.string().min(1).max(100),
  logoColor: z.string().max(20).default(""),
  logoInitials: z.string().max(4).default(""),
  baseUrl: z.string().max(300).default(""),
  website: z.string().max(300).default(""),
  docUrl: z.string().max(300).default(""),
  models: z.array(z.string().min(1)).default([]),
  sortOrder: z.number().int().default(0),
});

// Official list-price row for the platform price library (per 1M tokens).
export const catalogPriceSchema = z.object({
  model: z.string().min(1).max(200),
  input: z.number().min(0),
  output: z.number().min(0),
  cacheHit: z.number().min(0).optional(),
  currency: z.string().min(1).max(8).default("CNY"),
});
export type CatalogPrice = z.infer<typeof catalogPriceSchema>;
export type ProviderCreateInput = z.infer<typeof providerCreateSchema>;

export const providerPatchSchema = z.object({
  nameZh: z.string().min(1).max(100).optional(),
  nameEn: z.string().min(1).max(100).optional(),
  logoColor: z.string().max(20).optional(),
  logoInitials: z.string().max(4).optional(),
  baseUrl: z.string().max(300).optional(),
  website: z.string().max(300).optional(),
  docUrl: z.string().max(300).optional(),
  models: z.array(z.string().min(1)).optional(),
  prices: z.array(catalogPriceSchema).optional(),
  sortOrder: z.number().int().optional(),
  status: z.enum(PROVIDER_STATUSES).optional(),
});
export type ProviderPatchInput = z.infer<typeof providerPatchSchema>;

// ---------------------------------------------------------------------------
// Platform-level settings (Item 15): SaaS super admin base settings.
// Currently the desktop agent release channel, consumed publicly via
// /api/releases/latest (landing page + local agent auto-update).
// ---------------------------------------------------------------------------
export const PLATFORM_SETTING_KEYS = [
  "agent.latestVersion",
  "agent.downloadUrl",
  "agent.releaseNotes",
] as const;
export type PlatformSettingKey = (typeof PLATFORM_SETTING_KEYS)[number];

export const platformSettingsPutSchema = z.object({
  settings: z
    .array(z.object({ key: z.enum(PLATFORM_SETTING_KEYS), value: z.string().min(1).max(4000) }))
    .min(1),
});
export type PlatformSettingsPutInput = z.infer<typeof platformSettingsPutSchema>;

// ---------------------------------------------------------------------------
// Auth contracts
// ---------------------------------------------------------------------------

// Strong password policy (applies to registration, member creation and
// password changes): >=10 chars with lower, upper, digit and symbol.
export const strongPasswordSchema = z
  .string()
  .min(10, "password: at least 10 characters")
  .max(128)
  .regex(/[a-z]/, "password: needs a lowercase letter")
  .regex(/[A-Z]/, "password: needs an uppercase letter")
  .regex(/[0-9]/, "password: needs a digit")
  .regex(/[^a-zA-Z0-9]/, "password: needs a symbol");

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: strongPasswordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const registerSchema = z.object({
  tenantName: z.string().min(2).max(100),
  tenantSlug: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/, "slug: lowercase letters, digits and dashes only"),
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: strongPasswordSchema,
  emailCode: z.string().regex(/^\d{6}$/, "emailCode: 6-digit verification code"),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  tenantPlan: string;
  isPlatformAdmin?: boolean; // SaaS platform super admin flag (Item 15)
  /** Credential version at login; bumped on password/role change to invalidate sessions immediately. */
  authStamp?: number;
}

// ---------------------------------------------------------------------------
// Agent contracts
// ---------------------------------------------------------------------------
export const agentCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).default(""),
  purpose: z.string().max(500).default(""),
  dataClass: z.enum(DATA_CLASSES).default("INTERNAL"),
  type: z.enum(AGENT_TYPES).optional(),
  subtype: z.string().max(50).default(""),
  allowedModels: z.array(z.string()).default([]),
  issueToken: z.boolean().default(true),
});
export type AgentCreateInput = z.infer<typeof agentCreateSchema>;

export const agentUpdateSchema = agentCreateSchema.partial().extend({
  status: z.enum(AGENT_STATUSES).optional(),
  ownerId: z.string().optional(),
});
export type AgentUpdateInput = z.infer<typeof agentUpdateSchema>;

export const agentVersionCreateSchema = z.object({
  version: z.string().min(1).max(50),
  allowedModels: z.array(z.string()).default([]),
  notes: z.string().max(2000).default(""),
});
export type AgentVersionCreateInput = z.infer<typeof agentVersionCreateSchema>;

// ---------------------------------------------------------------------------
// Skill registry (PRD 7.4 companion to MCP)
// ---------------------------------------------------------------------------
export const SKILL_SOURCES = ["INTERNAL", "MARKETPLACE", "CUSTOM"] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

export const SKILL_SOURCE_LABELS: Record<SkillSource, { zh: string; en: string }> = {
  INTERNAL: { zh: "内部", en: "Internal" },
  MARKETPLACE: { zh: "市场", en: "Marketplace" },
  CUSTOM: { zh: "自定义", en: "Custom" },
};

export const skillCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).default(""),
  source: z.enum(SKILL_SOURCES).default("INTERNAL"),
  allowedAgentIds: z.array(z.string()).default([]), // 空=全部 Agent 可用
});
export type SkillCreateInput = z.infer<typeof skillCreateSchema>;

export const skillVersionCreateSchema = z.object({
  version: z.string().min(1).max(50),
  notes: z.string().max(2000).default(""),
  content: z.string().max(200_000).default(""), // Skill 本体（prompt/指令）
  format: z.enum(["MARKDOWN", "CODE"]).default("MARKDOWN"),
  signature: z.string().max(500).default(""),
});
export type SkillVersionCreateInput = z.infer<typeof skillVersionCreateSchema>;

// ---------------------------------------------------------------------------
// MCP contracts
// ---------------------------------------------------------------------------
export const mcpInstanceCreateSchema = z.object({
  name: z.string().min(1).max(100),
  endpoint: z.string().url(),
  transport: z.enum(["STREAMABLE_HTTP", "SSE", "STDIO"]).default("STREAMABLE_HTTP"),
  protocolVersion: z.string().default("2025-06-18"),
  riskLevel: z.enum(RISK_LEVELS).default("MEDIUM"),
  authType: z.enum(["OAUTH", "API_KEY", "MTLS", "NONE"]).default("NONE"),
  authToken: z.string().max(500).default(""), // plaintext in transit; server encrypts to authTokenEnc
  allowedAgentIds: z.array(z.string()).default([]), // 空=全部 Agent 可用
  description: z.string().max(2000).default(""),
});
export type McpInstanceCreateInput = z.infer<typeof mcpInstanceCreateSchema>;

export const mcpToolCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).default(""),
  schema: z.record(z.unknown()).default({}),
  riskLevel: z.enum(RISK_LEVELS).default("MEDIUM"),
  requiresApproval: z.boolean().default(false),
});
export type McpToolCreateInput = z.infer<typeof mcpToolCreateSchema>;

// ---------------------------------------------------------------------------
// Policy contracts (RBAC/ABAC, default-deny; PRD 7.5)
// ---------------------------------------------------------------------------
// Policy conditions (ABAC extension of the RBAC tuple): a JSON document of the
// shape `{ expr: string }` evaluated per call by the shared expression engine
// (see policy-expr.ts). Extra keys are tolerated for forward compatibility.
export const policyConditionsSchema = z
  .object({ expr: z.string().max(4000).optional() })
  .catchall(z.unknown());

export const policyCreateSchema = z.object({
  name: z.string().min(1).max(200),
  effect: z.enum(POLICY_EFFECTS),
  action: z.enum(POLICY_ACTIONS),
  subjectType: z.enum(["ROLE", "USER", "AGENT", "EVERYONE"]).default("EVERYONE"),
  subjectId: z.string().default(""),
  resource: z.string().default("*"), // e.g. model "deepseek-chat", tool name, "*"
  env: z.string().default("prod"),
  conditions: policyConditionsSchema.default({}),
});
export type PolicyCreateInput = z.infer<typeof policyCreateSchema>;

// ---------------------------------------------------------------------------
// Credential contracts (provider keys, never echoed back; PRD 7.2)
// ---------------------------------------------------------------------------
// provider holds a ProviderCatalog code (e.g. "deepseek") or a legacy enum
// value ("DEEPSEEK" / "CUSTOM_OPENAI_COMPATIBLE"); catalog codes are lowercase
// slugs maintained centrally by the platform admin (Item 9).
export const credentialCreateSchema = z.object({
  provider: z.string().min(1).max(50).default("DEEPSEEK"),
  label: z.string().min(1).max(100),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  models: z.array(z.string().min(1)).default([]), // 承接模型清单，空=不承接特定模型
});
export type CredentialCreateInput = z.infer<typeof credentialCreateSchema>;

// ---------------------------------------------------------------------------
// Device (local client) contracts
// ---------------------------------------------------------------------------
export const deviceCreateSchema = z.object({
  name: z.string().min(1).max(100),
});
export type DeviceCreateInput = z.infer<typeof deviceCreateSchema>;

// Device auth uses a long-lived device key: "akd_<random>" shown once at creation.
// Gateway/ingest auth uses a separate API key: "ak_<random>".

// ---------------------------------------------------------------------------
// Demo request (landing page; PRD 12.6)
// ---------------------------------------------------------------------------
export const demoRequestSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  company: z.string().min(1).max(200),
  industry: z.string().max(100).default(""),
  companySize: z.string().max(50).default(""),
  agentCount: z.string().max(50).default(""),
  goals: z.string().max(1000).default(""),
  timeframe: z.string().max(100).default(""),
  notes: z.string().max(2000).default(""),
  locale: z.enum(["zh", "en"]).default("zh"),
});
export type DemoRequestInput = z.infer<typeof demoRequestSchema>;

// ---------------------------------------------------------------------------
// Audit query
// ---------------------------------------------------------------------------
export const auditQuerySchema = z.object({
  eventType: z.string().optional(),
  agentId: z.string().optional(),
  outcome: z.enum(["ALLOW", "DENY", "ERROR", "SUCCESS"]).optional(),
  riskLevel: z.enum(RISK_LEVELS).optional(),
  traceId: z.string().optional(),
  // Event origin: relay = written by the cloud gateway (no deviceId);
  // edge = reported by a connected enterprise proxy; standalone = reported
  // by a proxy running in standalone (SaaS-less) mode.
  source: z.enum(["relay", "edge", "standalone"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

// ---------------------------------------------------------------------------
// Reachability (public AI control evaluation; PRD section 9)
// ---------------------------------------------------------------------------
export const reachabilityReportSchema = z.object({
  deviceKeyId: z.string().default(""), // legacy; device is identified by the Bearer key
  results: z.array(
    z.object({
      endpointId: z.string(),
      reachable: z.boolean(),
      statusCode: z.number().int().optional(),
      latencyMs: z.number().optional(),
      checkedAt: z.string(), // ISO
      detail: z.string().default(""),
    })
  ),
});
export type ReachabilityReportInput = z.infer<typeof reachabilityReportSchema>;

// ---------------------------------------------------------------------------
// AI 决策式策略评估（Jev 风格治理判定）：租户用自己配置的模型对每个调用做
// 结构化判定。存储在 Tenant.aiGuard Json 列；normalize 见 ai-guard.ts。
// 判定响应用 aiDecisionSchema 宽松解析（缺字段给默认）。
// ---------------------------------------------------------------------------
export const aiGuardConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["BLOCK", "AUDIT_ONLY"]).default("BLOCK"),
  credentialId: z.string().trim().max(100).nullable().default(null),
  model: z.string().trim().max(100).default(""),
  template: z.string().max(4000).nullable().default(null), // null = 内置默认中文模板
  timeoutMs: z.number().int().min(100).max(120_000).default(8000),
  failOpen: z.boolean().default(true),
});
export type AiGuardConfigInput = z.infer<typeof aiGuardConfigSchema>;

export const aiGuardUpdateSchema = aiGuardConfigSchema.partial();
export type AiGuardUpdateInput = z.infer<typeof aiGuardUpdateSchema>;

// 判定输出契约（上游 response_format=json；宽松解析，缺字段给默认）。
export const aiDecisionSchema = z.object({
  decision: z.enum(["allow", "block", "review"]).default("allow"),
  categories: z.array(z.string().max(50)).max(10).default([]),
  confidence: z.number().min(0).max(1).default(0),
  reason: z.string().max(500).default(""),
});
export type AiDecisionPayload = z.infer<typeof aiDecisionSchema>;

// Bootstrap payload 契约：控制面 GET /api/agent/bootstrap 在 contentSafety /
// limits 之外下发 aiGuard（已 normalize；旧代理缺失该字段 = 全关）。
export const agentBootstrapAiGuardSchema = aiGuardConfigSchema;

// ---------------------------------------------------------------------------
// Custom roles (stored per tenant; system roles stay in ROLE_SECTIONS)
// ---------------------------------------------------------------------------
export const roleCreateSchema = z.object({
  // Optional: the console no longer asks for a code — the server auto-generates
  // `r-` + 8 random lowercase alphanumerics when omitted.
  name: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/, "name: lowercase letters, digits and dashes only")
    .optional(),
  labelZh: z.string().min(1).max(50),
  labelEn: z.string().min(1).max(50),
  sections: z.array(z.string()).min(1),
});
export type RoleCreateInput = z.infer<typeof roleCreateSchema>;

// ---------------------------------------------------------------------------
// Edge usage ingest: the local agent meters model calls executed on-premises
// and syncs usage facts to the control plane (PRD: evidence sync, 默认不出域)
// ---------------------------------------------------------------------------
export const agentUsageReportSchema = z.object({
  events: z
    .array(
      z.object({
        eventId: z.string().min(8).max(64),
        apiKeyId: z.string().default(""),
        agentId: z.string().default(""),
        agentVersion: z.string().default(""),
        provider: z.string().min(1).max(50),
        model: z.string().min(1).max(100),
        promptTokens: z.number().int().nonnegative(),
        completionTokens: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative(),
        cachedTokens: z.number().int().nonnegative().default(0),
        latencyMs: z.number().nonnegative().default(0),
        status: z.enum(["SUCCESS", "ERROR"]).default("SUCCESS"),
        cost: z.number().nonnegative().default(0),
        traceId: z.string().default(""),
        occurredAt: z.string(), // ISO
        /** Small typed extras, e.g. { aiGuard: true } marks AI-policy-judgment metering. */
        metadata: z.record(z.unknown()).default({}),
      })
    )
    .min(1)
    .max(500),
});
export type AgentUsageReportInput = z.infer<typeof agentUsageReportSchema>;

// ---------------------------------------------------------------------------
// Edge audit ingest: edge-direct calls used to be invisible to the cloud audit
// chain (only 60s-aggregated meter_emitted facts arrived). The local proxy now
// reports one lightweight governance event per policy evaluation, model
// result/failure, content block, rate/budget rejection and MCP tool call, so
// every per-call decision lands in the same hash-chained AuditEvent stream as
// the SaaS relay path. Events carry metadata only — never message bodies,
// secrets or response content.
// ---------------------------------------------------------------------------
export const edgeAuditEventSchema = z.object({
  eventId: z.string().uuid(), // idempotency key server-side (tenant, device, eventId)
  ts: z.string(), // ISO occurredAt
  type: z.enum([
    "policy_evaluated",
    "model_response",
    "model_error",
    "content_blocked",
    "rate_limited",
    "budget_exceeded",
    "tool_invoked",
    "ai_decision",
  ]),
  agentId: z.string().max(100).default(""),
  agentVersion: z.string().max(50).default(""),
  model: z.string().max(100).default(""),
  traceId: z.string().max(64).default(""),
  tool: z.string().max(200).default(""),
  outcome: z.enum(["ALLOW", "DENY", "ERROR", "SUCCESS"]),
  detail: z.record(z.unknown()).default({}), // small metadata: hit categories, token counts, cost, error codes
  cost: z.number().nonnegative().default(0),
});
export type EdgeAuditEventInput = z.infer<typeof edgeAuditEventSchema>;

export const agentAuditReportSchema = z.object({
  // Proxy mode at send time: standalone-reported events are tagged so the
  // console can distinguish SaaS-less data planes from connected ones.
  deviceMode: z.enum(["connected", "standalone"]).default("connected"),
  events: z.array(edgeAuditEventSchema).min(1).max(500),
});
export type AgentAuditReportInput = z.infer<typeof agentAuditReportSchema>;

// ---------------------------------------------------------------------------
// Gateway (OpenAI-compatible; PRD 7.2) — local agent calls this with an API key
// ---------------------------------------------------------------------------
export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  name: z.string().optional(),
});
export const chatCompletionSchema = z.object({
  model: z.string().default("deepseek-chat"),
  messages: z.array(chatMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().default(false),
});
export type ChatCompletionInput = z.infer<typeof chatCompletionSchema>;

// Control plane -> local agent protocol endpoints (used by apps/agent):
//   GET  /api/agent/bootstrap            (device key auth) -> policies, catalog, endpoints
//   POST /api/agent/reachability         (device key auth) -> batch sync reports
//   POST /api/gateway/v1/chat/completions (api key auth)   -> metered model proxy
//   GET  /api/gateway/v1/models           (api key auth)
// ---------------------------------------------------------------------------

export interface ApiOk<T> { ok: true; data: T }
export interface ApiErr { ok: false; error: { code: string; message: string } }
export type ApiResult<T> = ApiOk<T> | ApiErr;

// ---------------------------------------------------------------------------
// Commercial plans (update.md: open-core + hybrid deployment; one codebase,
// License Key unlocks commercial features, and pricing anchors on DATA PLANE
// count — not agent count — to encourage wider governance coverage).
// ---------------------------------------------------------------------------

export const PLANS = {
  COMMUNITY: {
    code: "COMMUNITY",
    priceMonthly: 0,
    priceYearly: 0,
    limits: { agents: 5, members: 3, devices: 1, retentionDays: 7 },
    features: ["gateway", "localRepos", "basicPolicies", "localUsage"],
  },
  CLOUD_PRO: {
    code: "CLOUD_PRO",
    priceMonthly: 299,
    priceYearly: 2990,
    limits: { agents: 200, members: 50, devices: 3, retentionDays: 30 },
    features: [
      "gateway", "localRepos", "basicPolicies", "localUsage",
      "controlPlane", "multiDataPlane", "policySync", "auditExport",
      "materialize", "reachability", "emailSupport",
    ],
  },
  ENTERPRISE: {
    code: "ENTERPRISE",
    priceMonthly: 2999,
    priceYearly: 29990,
    limits: { agents: 100000, members: 100000, devices: 100000, retentionDays: 36500 },
    features: [
      "gateway", "localRepos", "basicPolicies", "localUsage",
      "controlPlane", "multiDataPlane", "policySync", "auditExport",
      "materialize", "reachability", "emailSupport",
      "unlimitedDataPlanes", "selfHostedControlPlane", "sso",
      "advancedRbac", "offlineLicense", "soc2", "sla",
    ],
  },
  HOSTED: {
    code: "HOSTED",
    priceMonthly: 999,
    priceYearly: 9990,
    limits: { agents: 200, members: 50, devices: 0, retentionDays: 30 },
    features: ["gateway", "controlPlane", "policySync", "auditExport", "reachability"],
  },
} as const;

export type PlanCode = keyof typeof PLANS;
export const PLAN_CODES = Object.keys(PLANS) as PlanCode[];

export function planOf(code: string | null | undefined): (typeof PLANS)[PlanCode] {
  return PLANS[(code as PlanCode)] ?? PLANS.COMMUNITY;
}

/** Effective limit: ENTERPRISE is effectively unlimited (large sentinel). */
export function planLimit(code: string | null | undefined, key: keyof (typeof PLANS)["COMMUNITY"]["limits"]): number {
  return planOf(code).limits[key];
}
