// Vendor catalog for the local credential form, aligned with the SaaS-side
// provider catalog (platform admin maintains the authoritative list; this is
// the offline builtin for standalone proxies). Selecting a vendor autofills
// the base URL and offers its common models as checkbox chips; a custom text
// field covers anything not listed.

export interface VendorDef {
  code: string;
  name: string;
  domain: string; // official site, for the favicon logo
  baseUrl: string;
  models: string[];
}

export const VENDOR_CATALOG: VendorDef[] = [
  { code: "DEEPSEEK", name: "DeepSeek", domain: "deepseek.com", baseUrl: "https://api.deepseek.com", models: ["deepseek-chat", "deepseek-reasoner", "deepseek-flash"] },
  { code: "OPENAI", name: "OpenAI", domain: "openai.com", baseUrl: "https://api.openai.com/v1", models: ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"] },
  { code: "ANTHROPIC", name: "Anthropic", domain: "anthropic.com", baseUrl: "https://api.anthropic.com/v1", models: ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest", "claude-3-opus-latest"] },
  { code: "ZHIPU", name: "Zhipu GLM", domain: "zhipuai.cn", baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-4-plus", "glm-4-air", "glm-4-flash"] },
  { code: "DASHSCOPE", name: "Alibaba DashScope", domain: "aliyun.com", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["qwen-max", "qwen-plus", "qwen-turbo"] },
  { code: "MOONSHOT", name: "Moonshot Kimi", domain: "moonshot.cn", baseUrl: "https://api.moonshot.cn/v1", models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"] },
  { code: "BAICHUAN", name: "Baichuan", domain: "baichuan-ai.com", baseUrl: "https://api.baichuan-ai.com/v1", models: ["Baichuan4", "Baichuan3-Turbo"] },
  { code: "MINIMAX", name: "MiniMax", domain: "minimaxi.com", baseUrl: "https://api.minimaxi.com/v1", models: ["abab6.5-chat"] },
  { code: "SILICONFLOW", name: "SiliconFlow", domain: "siliconflow.cn", baseUrl: "https://api.siliconflow.cn/v1", models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"] },
  { code: "OPENROUTER", name: "OpenRouter", domain: "openrouter.ai", baseUrl: "https://openrouter.ai/api/v1", models: [] },
  { code: "OTHER", name: "Other / Custom", domain: "", baseUrl: "", models: [] },
];

// Official site icon served by the vendor itself (/<domain>/favicon.ico) —
// never generated here; empty string when no domain is known.
export function vendorLogo(domain: string): string {
  return domain ? `https://${domain}/favicon.ico` : "";
}

export function vendorOf(code: string): VendorDef | undefined {
  return VENDOR_CATALOG.find((v) => v.code === code);
}
