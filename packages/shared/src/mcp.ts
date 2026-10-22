// MCP (Model Context Protocol) aggregation over multiple upstream servers.
// Isomorphic: runs on the enterprise proxy (Electron main) and on the control
// plane relay (Next.js route handlers). Stateless JSON-RPC 2.0 over streamable
// HTTP — the gateway answers non-streamed `application/json` responses, which
// the spec permits and every current MCP client accepts.

export interface McpUpstreamSource {
  id: string;
  name: string;
  endpoint: string;
  riskLevel?: string;
  authToken?: string; // upstream bearer token, decrypted by the caller before use
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  [k: string]: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface RpcOk {
  ok: true;
  result: unknown;
}
interface RpcFail {
  ok: false;
  error: JsonRpcError;
}
type RpcOutcome = RpcOk | RpcFail;

function rpcError(code: number, message: string, data?: unknown): RpcFail {
  return { ok: false, error: { code, message, data } };
}

/** Extract the JSON payload of the last SSE `data:` frame (MCP sends one JSON per event). */
function parseSseJson(body: string): unknown | undefined {
  let found: unknown;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      found = JSON.parse(payload);
    } catch {
      // partial frame; keep the previous complete one
    }
  }
  return found;
}

export async function callMcpRpc(
  endpoint: string,
  method: string,
  params: unknown,
  authToken: string | undefined,
  timeoutMs = 30_000,
): Promise<RpcOutcome> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? {} }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return rpcError(-32000, `upstream unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return rpcError(-32000, `upstream HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const payload = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? parseSseJson(text)
    : safeJson(text);
  if (payload === undefined) return rpcError(-32700, "upstream returned malformed JSON");
  const msg = payload as { result?: unknown; error?: JsonRpcError };
  if (msg && typeof msg === "object" && msg.error) return { ok: false, error: msg.error };
  return { ok: true, result: msg?.result };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `My Search-API!` -> `my_search_api` (tool name prefix). */
export function mcpSlug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "mcp";
}

export interface AggregatedTool extends McpToolDescriptor {
  name: string; // `${slug}__${upstreamName}`
}

export interface AggregateResult {
  tools: AggregatedTool[];
  /** `${slug}__${tool}` -> originating source + upstream tool name. */
  routes: Map<string, { source: McpUpstreamSource; upstreamName: string }>;
  /** Sources that failed tools/list (logged/audited by the caller). */
  failures: { source: McpUpstreamSource; error: JsonRpcError }[];
}

export async function aggregateMcpTools(sources: McpUpstreamSource[]): Promise<AggregateResult> {
  const tools: AggregatedTool[] = [];
  const routes = new Map<string, { source: McpUpstreamSource; upstreamName: string }>();
  const failures: AggregateResult["failures"] = [];
  const taken = new Set<string>();

  await Promise.all(
    sources.map(async (source) => {
      const out = await callMcpRpc(source.endpoint, "tools/list", {}, source.authToken);
      if (!out.ok) {
        failures.push({ source, error: out.error });
        return;
      }
      const list = (out.result as { tools?: McpToolDescriptor[] } | null)?.tools;
      if (!Array.isArray(list)) {
        failures.push({ source, error: { code: -32602, message: "tools/list returned no tools array" } });
        return;
      }
      const slug = mcpSlug(source.name);
      for (const t of list) {
        if (!t || typeof t.name !== "string") continue;
        let key = `${slug}__${t.name}`;
        let n = 2;
        while (taken.has(key)) key = `${slug}_${n++}__${t.name}`;
        taken.add(key);
        const risk = source.riskLevel && source.riskLevel !== "LOW" ? `[${source.riskLevel}] ` : "";
        tools.push({
          ...t,
          name: key,
          description: `${risk}[${source.name}] ${typeof t.description === "string" ? t.description : ""}`.trim(),
        });
        routes.set(key, { source, upstreamName: t.name });
      }
    }),
  );

  tools.sort((a, b) => a.name.localeCompare(b.name));
  return { tools, routes, failures };
}

export const MCP_PROTOCOL_VERSION = "2025-06-18";
