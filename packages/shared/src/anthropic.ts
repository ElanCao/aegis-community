import { z } from "zod";

// Anthropic Messages API <-> OpenAI Chat Completions adapter.
// Shared by the cloud relay (apps/web) and the enterprise proxy gateway
// (apps/agent) so both paths expose identical protocol behavior.
// Scope: text (+extended-thinking passthrough) conversations. Tool use /
// vision blocks are flattened to plain text (tool blocks serialize as JSON).

export const anthropicMessagesSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.union([z.string(), z.array(z.unknown())]),
      })
    )
    .min(1),
  max_tokens: z.number().int().positive().max(1_000_000),
  system: z.union([z.string(), z.array(z.unknown())]).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop_sequences: z.array(z.string()).optional(),
});
export type AnthropicMessagesInput = z.infer<typeof anthropicMessagesSchema>;

function flattenContent(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string") parts.push(b.text);
    else if (b.type === "tool_use" || b.type === "tool_result") parts.push(JSON.stringify(b));
  }
  return parts.filter(Boolean).join("\n");
}

/** Convert an Anthropic Messages request into an OpenAI chat completion payload. */
export function anthropicToOpenAI(input: AnthropicMessagesInput) {
  const messages: { role: string; content: string }[] = [];
  const system = input.system ? flattenContent(input.system) : "";
  if (system) messages.push({ role: "system", content: system });
  for (const m of input.messages) messages.push({ role: m.role, content: flattenContent(m.content) });
  return {
    model: input.model,
    messages,
    max_tokens: input.max_tokens,
    stream: input.stream === true,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.top_p !== undefined ? { top_p: input.top_p } : {}),
    ...(input.stop_sequences && input.stop_sequences.length > 0 ? { stop: input.stop_sequences } : {}),
  };
}

interface OpenAiChoiceLike {
  message?: { content?: string; reasoning_content?: string };
  finish_reason?: string | null;
}

const STOP_REASON_MAP: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  content_filter: "stop_sequence",
};

/** Convert a completed OpenAI chat completion JSON into an Anthropic message. */
export function openAiToAnthropic(data: Record<string, unknown>, model: string) {
  const choice = (Array.isArray(data.choices) ? (data.choices as OpenAiChoiceLike[])[0] : null) ?? null;
  const msg = choice?.message ?? {};
  const content: Record<string, unknown>[] = [];
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
    content.push({ type: "thinking", thinking: msg.reasoning_content });
  }
  content.push({ type: "text", text: typeof msg.content === "string" ? msg.content : "" });
  const usage = (data.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
  return {
    id: typeof data.id === "string" ? `msg_${data.id.replace(/^chatcmpl-/, "")}` : `msg_${Math.random().toString(36).slice(2, 12)}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: STOP_REASON_MAP[choice?.finish_reason ?? ""] ?? "end_turn",
    usage: { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0 },
  };
}

// ---- streaming: OpenAI SSE chunk stream -> Anthropic message events --------



/**
 * Transform an OpenAI chat.completion.chunk SSE stream into Anthropic
 * message events (message_start / content_block_* / message_delta /
 * message_stop). Text deltas are forwarded; reasoning deltas are dropped in
 * streaming mode (non-streaming keeps the thinking block).
 */
export function openAiSseToAnthropic(model: string): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let seq = 0;
  let sentUsage = false;
  const usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason = "end_turn";
  const id = `msg_${Math.random().toString(36).slice(2, 12)}`;

  const event = (type: string, payload: unknown) =>
    `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  const header =
    event("message_start", {
      type: "message_start",
      message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    }) +
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });

  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(header));
    },
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload) as {
            choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            controller.enqueue(
              encoder.encode(
                event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } })
              )
            );
          }
          const fr = json.choices?.[0]?.finish_reason;
          if (fr) stopReason = STOP_REASON_MAP[fr] ?? "end_turn";
          if (json.usage) {
            sentUsage = true;
            usage.input_tokens = json.usage.prompt_tokens ?? usage.input_tokens;
            usage.output_tokens = json.usage.completion_tokens ?? usage.output_tokens;
          }
        } catch {
          // partial chunk; ignore
        }
      }
    },
    flush(controller) {
      controller.enqueue(
        encoder.encode(
          event("content_block_stop", { type: "content_block_stop", index: 0 }) +
            event("message_delta", {
              type: "message_delta",
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: { output_tokens: usage.output_tokens },
            }) +
            event("message_stop", { type: "message_stop" })
        )
      );
      void seq;
      void sentUsage;
    },
  });
}
