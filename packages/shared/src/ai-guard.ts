// AI 决策式策略评估（Jev 风格治理判定，PRD 治理面扩展）：每次模型调用前，
// 用租户自己配置的模型对「system + 最后一条 user 请求」做一次性结构化判定
// （allow / block / review + 类别 + 置信度 + 理由）。租户可自定义判定 prompt
// 模板（{{system}} {{user}} {{model}} {{agent}} {{plan}} 变量替换，留空用内置
// 中文默认模板）。判定调用直连上游、不经网关管道，避免递归与被自身策略拦截。
//
// 与 content-safety（确定性扫描）互补：这里是模型自治决策，失败策略可配
// failOpen（放行+审计）或 failClosed（阻断）。

// ---------------------------------------------------------------------------
// Config shape（Tenant.aiGuard Json 列；normalize 容忍旧缓存/脏数据）
// ---------------------------------------------------------------------------
export interface AiGuardConfig {
  enabled: boolean;
  /** BLOCK = 判定 block 即 403；AUDIT_ONLY = 全部放行，block/review 只记审计。 */
  mode: "BLOCK" | "AUDIT_ONLY";
  /** 判定所用模型凭证（ModelCredential.id / 本地凭证 id）。 */
  credentialId: string | null;
  /** 判定所用模型（凭证 verifiedModels 里选）；空 = 取凭证 models 首个，再退 deepseek-chat。 */
  model: string;
  /** 自定义判定 prompt 模板；null/空 = 内置默认模板。 */
  template: string | null;
  /** 判定调用超时（毫秒），默认 8000。 */
  timeoutMs: number;
  /** 超时/上游错误/解析失败时放行（true，默认）还是阻断（false）。 */
  failOpen: boolean;
}

export const DEFAULT_AI_GUARD: AiGuardConfig = {
  enabled: false,
  mode: "BLOCK",
  credentialId: null,
  model: "",
  template: null,
  timeoutMs: 8000,
  failOpen: true,
};

function strOrNull(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  return s.slice(0, max);
}

/** Tolerant parser: any garbage in (old caches, hand-edited config) -> sane defaults. */
export function normalizeAiGuard(raw: unknown): AiGuardConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_AI_GUARD };
  const r = raw as Record<string, unknown>;
  const timeout = Number(r.timeoutMs);
  return {
    enabled: r.enabled === true,
    mode: r.mode === "AUDIT_ONLY" ? "AUDIT_ONLY" : "BLOCK",
    credentialId: strOrNull(r.credentialId, 100),
    model: typeof r.model === "string" ? r.model.trim().slice(0, 100) : "",
    template: strOrNull(r.template, 4000),
    timeoutMs: Number.isFinite(timeout) && timeout >= 100 ? Math.min(Math.floor(timeout), 120_000) : DEFAULT_AI_GUARD.timeoutMs,
    failOpen: r.failOpen !== false,
  };
}

// ---------------------------------------------------------------------------
// 判定 prompt 组装：模板渲染 + 变量替换
// ---------------------------------------------------------------------------
export interface AiGuardPromptVars {
  /** 全部 system 消息拼接（截断 2000 字符）。 */
  system: string;
  /** 最后一条 user 消息文本（截断 4000 字符）。 */
  user: string;
  /** 被判定请求的目标模型。 */
  model: string;
  /** 调用方 agentId（可能为空）。 */
  agent: string;
  /** 租户套餐。 */
  plan: string;
}

// 内置默认中文模板：变量 {{system}} {{user}} {{model}} {{agent}} {{plan}}。
export const DEFAULT_AI_GUARD_TEMPLATE = `你是一名企业 AI 治理策略评估员。请根据企业内容治理策略评估下面这次模型调用请求，只输出一个 JSON 对象，不要输出任何其他内容。

JSON 格式严格如下：
{"decision":"allow 或 block 或 review","categories":["类别英文名"],"confidence":0到1之间的小数,"reason":"中文理由，不超过120字"}

判定规则：
- allow：请求符合企业内容治理策略，直接放行。
- block：请求明确违反企业内容治理策略（如要求记录/传输密码、密钥、身份证等敏感信息，或明显违规内容），必须拦截。
- review：请求存在风险但证据不足，放行但标记人工复核，避免误伤正常办公。
- categories 用简短类别名（如 none、password_leak、credential_leak、sensitive_data、policy_violation）；allow 时用 ["none"]。
- reason 用中文简要说明判定依据，不超过120字。

【调用信息】
模型：{{model}}
Agent：{{agent}}
租户套餐：{{plan}}

【System 提示词（截断）】
{{system}}

【用户请求（截断）】
{{user}}`;

const SYSTEM_TRUNCATE = 2000;
const USER_TRUNCATE = 4000;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

/** Extract the judgment input from chat messages: system text (all system
 * messages joined, truncated) + the LAST user message text (truncated).
 * Content-part arrays' text fields are collected like content-safety does. */
export function extractAiGuardInput(messages: unknown): { system: string; user: string } {
  if (!Array.isArray(messages)) return { system: "", user: "" };
  const texts = (m: unknown): string => {
    const content = (m as { content?: unknown } | null)?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof (part as { text?: unknown } | null)?.text === "string" ? ((part as { text: string }).text) : ""))
        .filter((t) => t)
        .join("\n");
    }
    return "";
  };
  let user = "";
  for (const m of messages) {
    if ((m as { role?: unknown } | null)?.role === "user") {
      const t = texts(m);
      if (t) user = t; // keep the last non-empty user text
    }
  }
  let system = "";
  for (const m of messages) {
    if ((m as { role?: unknown } | null)?.role === "system") {
      const t = texts(m);
      if (t) system = system ? `${system}\n\n${t}` : t;
    }
  }
  return { system: truncate(system, SYSTEM_TRUNCATE), user: truncate(user, USER_TRUNCATE) };
}

/** Render the tenant template (or the built-in default) with the variables. */
export function renderAiGuardPrompt(template: string | null, vars: AiGuardPromptVars): string {
  const src = template && template.trim() ? template : DEFAULT_AI_GUARD_TEMPLATE;
  return src
    .replaceAll("{{system}}", vars.system)
    .replaceAll("{{user}}", vars.user)
    .replaceAll("{{model}}", vars.model)
    .replaceAll("{{agent}}", vars.agent)
    .replaceAll("{{plan}}", vars.plan);
}

// ---------------------------------------------------------------------------
// 判定输出解析：宽松 JSON（提取第一个 {..} 块，缺字段给默认）
// ---------------------------------------------------------------------------
export type AiDecision = "allow" | "block" | "review";

export interface AiGuardDecision {
  decision: AiDecision;
  categories: string[];
  confidence: number;
  reason: string;
}

/** Extract the first balanced {...} block from model output (tolerates
 * markdown fences / leading prose). Returns null when none is found. */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Lenient parse of the upstream decision JSON: missing fields get defaults,
 * unknown decision values map to allow. Returns null when no JSON parses. */
export function parseAiDecision(raw: string): AiGuardDecision | null {
  const block = extractFirstJsonObject(raw);
  if (!block) return null;
  try {
    const obj = JSON.parse(block) as Record<string, unknown>;
    const decision = obj.decision === "block" ? "block" : obj.decision === "review" ? "review" : "allow";
    const categories = Array.isArray(obj.categories)
      ? obj.categories.filter((c): c is string => typeof c === "string").map((c) => c.slice(0, 50)).slice(0, 10)
      : [];
    const conf = Number(obj.confidence);
    const confidence = Number.isFinite(conf) ? Math.min(Math.max(conf, 0), 1) : 0;
    const reason = typeof obj.reason === "string" ? obj.reason.slice(0, 500) : "";
    return { decision, categories, confidence, reason };
  } catch {
    return null;
  }
}
