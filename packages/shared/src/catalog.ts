// Public AI catalog (PRD section 6 / 9). First version covers Chinese and
// English services. `domains` are the endpoints the local agent probes for
// reachability; reachability != control (network blocking belongs to the
// firewall layer).

export interface PublicAiEndpoint {
  key: string;
  name: { zh: string; en: string };
  category: { zh: string; en: string };
  vendor: string;
  domains: string[];
  langs: string[]; // "zh" | "en" and others
}

export const PUBLIC_AI_CATALOG: PublicAiEndpoint[] = [
  // ---- Global (English-first) services ----
  { key: "chatgpt", name: { zh: "ChatGPT", en: "ChatGPT" }, category: { zh: "通用对话", en: "General chat" }, vendor: "OpenAI", domains: ["chatgpt.com", "api.openai.com"], langs: ["zh", "en"] },
  { key: "claude", name: { zh: "Claude", en: "Claude" }, category: { zh: "通用对话", en: "General chat" }, vendor: "Anthropic", domains: ["claude.ai", "api.anthropic.com"], langs: ["zh", "en"] },
  { key: "gemini", name: { zh: "Gemini", en: "Gemini" }, category: { zh: "通用对话", en: "General chat" }, vendor: "Google", domains: ["gemini.google.com", "generativelanguage.googleapis.com"], langs: ["zh", "en"] },
  { key: "copilot", name: { zh: "GitHub Copilot", en: "GitHub Copilot" }, category: { zh: "编程辅助", en: "Coding" }, vendor: "GitHub", domains: ["github.com", "api.github.com"], langs: ["zh", "en"] },
  { key: "perplexity", name: { zh: "Perplexity", en: "Perplexity" }, category: { zh: "AI 搜索", en: "AI search" }, vendor: "Perplexity", domains: ["perplexity.ai", "api.perplexity.ai"], langs: ["zh", "en"] },
  { key: "grok", name: { zh: "Grok", en: "Grok" }, category: { zh: "通用对话", en: "General chat" }, vendor: "xAI", domains: ["grok.com", "api.x.ai"], langs: ["zh", "en"] },
  { key: "midjourney", name: { zh: "Midjourney", en: "Midjourney" }, category: { zh: "图像生成", en: "Image generation" }, vendor: "Midjourney", domains: ["midjourney.com", "www.midjourney.com"], langs: ["zh", "en"] },
  { key: "huggingface", name: { zh: "Hugging Face", en: "Hugging Face" }, category: { zh: "模型社区", en: "Model hub" }, vendor: "Hugging Face", domains: ["huggingface.co"], langs: ["zh", "en"] },
  { key: "poe", name: { zh: "Poe", en: "Poe" }, category: { zh: "聚合平台", en: "Aggregated access" }, vendor: "Quora", domains: ["poe.com"], langs: ["zh", "en"] },
  // ---- China services (Chinese-first) ----
  { key: "deepseek", name: { zh: "DeepSeek", en: "DeepSeek" }, category: { zh: "通用对话", en: "General chat" }, vendor: "深度求索", domains: ["chat.deepseek.com", "api.deepseek.com"], langs: ["zh", "en"] },
  { key: "doubao", name: { zh: "豆包", en: "Doubao" }, category: { zh: "通用对话", en: "General chat" }, vendor: "字节跳动", domains: ["www.doubao.com", "ark.cn-beijing.volces.com"], langs: ["zh"] },
  { key: "qwen", name: { zh: "通义千问", en: "Qwen" }, category: { zh: "通用对话", en: "General chat" }, vendor: "阿里云", domains: ["tongyi.aliyun.com", "dashscope.aliyuncs.com"], langs: ["zh", "en"] },
  { key: "wenxin", name: { zh: "文心一言", en: "ERNIE Bot" }, category: { zh: "通用对话", en: "General chat" }, vendor: "百度", domains: ["yiyan.baidu.com", "qianfan.baidubce.com"], langs: ["zh"] },
  { key: "kimi", name: { zh: "Kimi", en: "Kimi" }, category: { zh: "通用对话", en: "General chat" }, vendor: "月之暗面", domains: ["kimi.moonshot.cn", "api.moonshot.cn"], langs: ["zh"] },
  { key: "zhipu", name: { zh: "智谱清言", en: "ChatGLM" }, category: { zh: "通用对话", en: "General chat" }, vendor: "智谱 AI", domains: ["chatglm.cn", "open.bigmodel.cn"], langs: ["zh"] },
  { key: "spark", name: { zh: "讯飞星火", en: "Spark" }, category: { zh: "通用对话", en: "General chat" }, vendor: "科大讯飞", domains: ["xinghuo.xfyun.cn", "spark-api.xf-yun.com"], langs: ["zh"] },
  { key: "yuanbao", name: { zh: "腾讯元宝", en: "Hunyuan Yuanbao" }, category: { zh: "通用对话", en: "General chat" }, vendor: "腾讯", domains: ["yuanbao.tencent.com", "api.hunyuan.cloud.tencent.com"], langs: ["zh"] },
  { key: "metaso", name: { zh: "秘塔 AI 搜索", en: "Metaso" }, category: { zh: "AI 搜索", en: "AI search" }, vendor: "秘塔科技", domains: ["metaso.cn"], langs: ["zh"] },
  { key: "jimeng", name: { zh: "即梦", en: "Jimeng" }, category: { zh: "图像/视频生成", en: "Image & video" }, vendor: "字节跳动", domains: ["jimeng.jianying.com"], langs: ["zh"] },
  { key: "tongyiwanxiang", name: { zh: "通义万相", en: "Tongyi Wanxiang" }, category: { zh: "图像生成", en: "Image generation" }, vendor: "阿里云", domains: ["wanxiang.aliyun.com"], langs: ["zh"] },
  { key: "baiducode", name: { zh: "文心快码", en: "Comate" }, category: { zh: "编程辅助", en: "Coding" }, vendor: "百度", domains: ["comate.baidu.com"], langs: ["zh"] },
  { key: "iflycode", name: { zh: "iFlyCode", en: "iFlyCode" }, category: { zh: "编程辅助", en: "Coding" }, vendor: "科大讯飞", domains: ["iflycode.xfyun.cn"], langs: ["zh"] },
];

export const PUBLIC_AI_CATEGORIES: { zh: string; en: string }[] = [
  { zh: "通用对话", en: "General chat" },
  { zh: "AI 搜索", en: "AI search" },
  { zh: "编程辅助", en: "Coding" },
  { zh: "图像生成", en: "Image generation" },
  { zh: "图像/视频生成", en: "Image & video" },
  { zh: "模型社区", en: "Model hub" },
  { zh: "聚合平台", en: "Aggregated access" },
];
