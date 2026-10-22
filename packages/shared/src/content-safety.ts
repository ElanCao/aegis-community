// Request-side content safety scan (tenant-configured). Applies to the relay
// (SaaS control plane) and to every enterprise proxy/edge gateway; the scanner
// itself is provider-agnostic so both sides share one implementation.
// Only REQUEST messages are scanned — response bodies (streaming buffers in
// particular) are out of scope by design.

export const CONTENT_CHECK_KEYS = ["phone", "idCard", "bankCard", "ipAddress", "keywords", "customRegex"] as const;
export type ContentCheckKey = (typeof CONTENT_CHECK_KEYS)[number];

export interface ContentSafetyChecks {
  /** 中国大陆手机号 */
  phone: boolean;
  /** 中国大陆身份证（18 位，格式校验） */
  idCard: boolean;
  /** 银行卡号（13–19 位连续数字，格式校验，不做 Luhn） */
  bankCard: boolean;
  /** IPv4 地址 */
  ipAddress: boolean;
  /** 内置种子敏感词 + 租户自定义敏感词 */
  keywords: boolean;
  /** 租户自定义正则 */
  customRegex: boolean;
}

export interface ContentSafetyConfig {
  enabled: boolean;
  /** BLOCK = 命中即 403；AUDIT_ONLY = 放行但留审计标记。 */
  mode: "BLOCK" | "AUDIT_ONLY";
  checks: ContentSafetyChecks;
  /** 租户自定义敏感词（大小写不敏感子串匹配）。 */
  customKeywords: string[];
  /** 租户自定义正则（非法正则在扫描时跳过；控制台前端先行校验）。 */
  customRegexes: string[];
}

export const DEFAULT_CONTENT_SAFETY: ContentSafetyConfig = {
  enabled: false,
  mode: "BLOCK",
  checks: { phone: false, idCard: false, bankCard: false, ipAddress: false, keywords: false, customRegex: false },
  customKeywords: [],
  customRegexes: [],
};

// 内置敏感词种子清单（中文 + 英文），可被租户自定义词扩充。
export const SEED_SENSITIVE_KEYWORDS = [
  "内部机密",
  "绝密",
  "密码是",
  "身份证号",
  "confidential",
  "password is",
  "top secret",
  "classified",
  "ssn",
  "secret key",
];

// 内置格式规则：手机号 / 身份证 / 银行卡 / IPv4。
const BUILTIN_PATTERNS: Record<Exclude<ContentCheckKey, "keywords" | "customRegex">, RegExp> = {
  phone: /(?<!\d)1[3-9]\d{9}(?!\d)/,
  idCard: /(?<!\d)\d{17}[\dXx](?!\d)/,
  bankCard: /(?<!\d)\d{13,19}(?!\d)/,
  ipAddress: /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
};

function strList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .slice(0, max);
}

/** Tolerant parser: any garbage in (old caches, hand-edited config) -> sane defaults. */
export function normalizeContentSafety(raw: unknown): ContentSafetyConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONTENT_SAFETY, checks: { ...DEFAULT_CONTENT_SAFETY.checks } };
  const r = raw as Record<string, unknown>;
  const c = (r.checks && typeof r.checks === "object" ? r.checks : {}) as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
    mode: r.mode === "AUDIT_ONLY" ? "AUDIT_ONLY" : "BLOCK",
    checks: {
      phone: c.phone === true,
      idCard: c.idCard === true,
      bankCard: c.bankCard === true,
      ipAddress: c.ipAddress === true,
      keywords: c.keywords === true,
      customRegex: c.customRegex === true,
    },
    customKeywords: strList(r.customKeywords, 500),
    customRegexes: strList(r.customRegexes, 100),
  };
}

/** Extract scan-able text from chat messages: string content, or content part arrays' text fields. */
export function extractMessageTexts(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  const out: string[] = [];
  for (const m of messages) {
    const content = (m as { content?: unknown } | null)?.content;
    if (typeof content === "string") {
      if (content) out.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        const text = (part as { text?: unknown } | null)?.text;
        if (typeof text === "string" && text) out.push(text);
      }
    }
  }
  return out;
}

export interface ContentScanResult {
  hit: boolean;
  /** 命中的检查类别（只回类别名，绝不回原文片段）。 */
  kinds: ContentCheckKey[];
}

export function scanText(text: string, cfg: ContentSafetyConfig): ContentScanResult {
  const kinds: ContentCheckKey[] = [];
  if (cfg.checks.phone && BUILTIN_PATTERNS.phone.test(text)) kinds.push("phone");
  if (cfg.checks.idCard && BUILTIN_PATTERNS.idCard.test(text)) kinds.push("idCard");
  if (cfg.checks.bankCard && BUILTIN_PATTERNS.bankCard.test(text)) kinds.push("bankCard");
  if (cfg.checks.ipAddress && BUILTIN_PATTERNS.ipAddress.test(text)) kinds.push("ipAddress");
  if (cfg.checks.keywords) {
    const lower = text.toLowerCase();
    const words = [...SEED_SENSITIVE_KEYWORDS, ...cfg.customKeywords];
    if (words.some((w) => w && lower.includes(w.toLowerCase()))) kinds.push("keywords");
  }
  if (cfg.checks.customRegex) {
    for (const source of cfg.customRegexes) {
      try {
        if (new RegExp(source).test(text)) {
          kinds.push("customRegex");
          break;
        }
      } catch {
        // 非法正则：扫描时跳过（控制台保存时已校验）。
      }
    }
  }
  return { hit: kinds.length > 0, kinds };
}

export function scanMessages(messages: unknown, cfg: ContentSafetyConfig): ContentScanResult {
  const texts = extractMessageTexts(messages);
  const kinds = new Set<ContentCheckKey>();
  for (const text of texts) {
    for (const k of scanText(text, cfg).kinds) kinds.add(k);
    if (kinds.size === CONTENT_CHECK_KEYS.length) break;
  }
  const list = CONTENT_CHECK_KEYS.filter((k) => kinds.has(k));
  return { hit: list.length > 0, kinds: list };
}
