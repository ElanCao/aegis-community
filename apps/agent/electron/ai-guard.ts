import { extractAiGuardInput, parseAiDecision, renderAiGuardPrompt, type AiGuardConfig, type AiGuardDecision } from "@aegis/shared";
import { decryptSecret } from "./crypto";

// AI 决策式策略评估（边缘侧，Electron 代理与无头 server 共用）。与 relay
// 相同的判定语义：直连上游（本地解密凭证）、JSON 结构化判定、超时 /
// failOpen 由调用方处理。判定消耗的 tokens 由调用方计入计量队列（metadata
// 标 aiGuard:true）。

export interface AiGuardCredentialLike {
  id: string;
  provider: string;
  baseUrl: string;
  apiKeyEnc: string;
  models: string[]; // empty => any model
}

export interface AiGuardJudgeOk {
  ok: true;
  decision: AiGuardDecision;
  judgeModel: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs: number;
}

export interface AiGuardJudgeErr {
  ok: false;
  error: string;
}

export type AiGuardJudgeResult = AiGuardJudgeOk | AiGuardJudgeErr;

export async function runAiGuardJudge(args: {
  cfg: AiGuardConfig;
  credential: AiGuardCredentialLike | undefined;
  messages: unknown;
  model: string;
  agentLabel: string;
  plan: string;
}): Promise<AiGuardJudgeResult> {
  const { cfg, credential } = args;
  if (!credential) return { ok: false, error: "ai_guard_no_credential" };
  let apiKey: string;
  try {
    apiKey = decryptSecret(credential.apiKeyEnc);
  } catch (e) {
    return { ok: false, error: `ai_guard_decrypt_failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const judgeModel = cfg.model || credential.models[0] || "deepseek-chat";
  const input = extractAiGuardInput(args.messages);
  const prompt = renderAiGuardPrompt(cfg.template, {
    system: input.system,
    user: input.user,
    model: args.model,
    agent: args.agentLabel,
    plan: args.plan,
  });

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let upstream: Response;
  try {
    upstream = await fetch(`${credential.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "User-Agent": "aegis-local-agent/0.1" },
      body: JSON.stringify({
        model: judgeModel,
        messages: [
          { role: "system", content: "你是企业 AI 治理策略评估员，只输出 JSON，不输出其他内容。" },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: 500,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: `ai_guard_upstream_unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    return { ok: false, error: `ai_guard_upstream_http_${upstream.status}: ${detail.slice(0, 200)}` };
  }
  const raw = await upstream.text().catch(() => "");
  let payload: { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } } = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, error: "ai_guard_malformed_upstream" };
  }
  const decision = parseAiDecision(payload.choices?.[0]?.message?.content ?? "");
  if (!decision) return { ok: false, error: "ai_guard_parse_failed" };
  return {
    ok: true,
    decision,
    judgeModel,
    usage: {
      promptTokens: Math.max(0, Math.floor(payload.usage?.prompt_tokens ?? 0)),
      completionTokens: Math.max(0, Math.floor(payload.usage?.completion_tokens ?? 0)),
      totalTokens: Math.max(0, Math.floor(payload.usage?.total_tokens ?? 0)),
    },
    latencyMs: Date.now() - started,
  };
}
