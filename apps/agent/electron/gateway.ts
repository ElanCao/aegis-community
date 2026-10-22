import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import {
  aggregateMcpTools,
  anthropicMessagesSchema,
  anthropicToOpenAI,
  callMcpRpc,
  MCP_PROTOCOL_VERSION,
  normalizeAiGuard,
  normalizeContentSafety,
  normalizeLimits,
  openAiSseToAnthropic,
  openAiToAnthropic,
  scanMessages,
  DailyTokenBudget,
  SlidingWindowRateLimiter,
  type AggregateResult,
  type AiGuardConfig,
  type McpUpstreamSource,
} from "@aegis/shared";
import type { BootstrapCache, Cache } from "./cache";
import { decryptSecret } from "./crypto";
import { checkMcpEntitlement, checkSkillEntitlement } from "./entitlements";
import type { LocalStores } from "./localstore";
import { computeLocalCost } from "./pricing";
import { runAiGuardJudge, type AiGuardCredentialLike } from "./ai-guard";
import type { AuditBuffer } from "./audit";
import type { MeterBuffer } from "./metering";
import { evaluateAction } from "./policy";
import type { ConfigStore } from "./store";
import type { EdgeCredential, EdgeAuditEvent, LogFn, MeterEvent, McpEntitlement, SkillEntitlement } from "./types";

declare const AEGIS_AGENT_VERSION: string;

export interface GatewayDeps {
  store: ConfigStore;
  cache: Cache;
  meter: MeterBuffer;
  audit: AuditBuffer;
  local: LocalStores;
  log: LogFn;
  deviceId: () => string;
  emitState: () => void;
}

interface OpenAiError {
  error: { message: string; type: string; code: string };
}

interface ChatBody {
  model?: unknown;
  stream?: unknown;
  stream_options?: unknown;
  messages?: { role: string; content: unknown }[];
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

function openAiErrorBody(type: string, message: string): OpenAiError {
  return { error: { message, type, code: type } };
}

function readBody(req: http.IncomingMessage, limit = 10 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function pickEdgeCredential(credentials: EdgeCredential[], model: string): EdgeCredential | undefined {
  return credentials.find((c) => c.models.length === 0 || c.models.includes(model));
}

/** Last `usage` object found in an SSE buffer (final chunk carries it with stream_options). */
function extractUsageFromSse(chunks: Buffer[]): RawUsage | null {
  const text = Buffer.concat(chunks).toString("utf8");
  let found: RawUsage | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload) as { usage?: RawUsage };
      if (json.usage) found = json.usage;
    } catch {
      // partial chunk; ignore
    }
  }
  return found;
}

function normalizeUsage(usage: RawUsage | null): Pick<
  MeterEvent,
  "promptTokens" | "completionTokens" | "totalTokens" | "cachedTokens"
> {
  const prompt = Math.max(0, Math.floor(usage?.prompt_tokens ?? 0));
  const completion = Math.max(0, Math.floor(usage?.completion_tokens ?? 0));
  const total = Math.max(0, Math.floor(usage?.total_tokens ?? prompt + completion));
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    cachedTokens: Math.max(0, Math.floor(usage?.prompt_tokens_details?.cached_tokens ?? 0)),
  };
}

/**
 * OpenAI-compatible gateway running on every enterprise proxy. By default it
 * listens on 127.0.0.1 for same-machine user-side agents (no auth needed —
 * localhost is trusted). When bindHost is set to a LAN address or 0.0.0.0 the
 * proxy becomes the enterprise's CENTRAL gateway: all users point their AI
 * tools at http://<proxy-ip>:<port>/v1, and remote callers MUST present an
 * Agent gateway key (ak_...) whose sha256 appears in the bootstrap-pushed
 * hash list (keys never leave the control plane). Enforces the cached policy
 * set for model:invoke (default deny), prepends the tenant governance prompt,
 * prefers edge-direct egress with locally decrypted credentials, meters usage
 * and syncs in batches, and falls back to the SaaS relay. MCP / skill
 * entitlements from the authorization views are enforced on /v1/mcp/invoke
 * and /v1/skills/use. Capability delivery for native clients: GET
 * /v1/capabilities lists the caller's skills (with content) and MCP servers,
 * and POST /mcp is a stateless streamable-HTTP MCP endpoint aggregating every
 * allowed upstream MCP server behind a single URL (tools prefixed
 * `<server>__<tool>`, upstream bearer tokens injected from the bootstrap
 * views). Skills can also be injected into the chat system prompt via the
 * x-aegis-inject-skills request header.
 */
export class GatewayServer {
  private server: http.Server | null = null;
  private port = 0;
  /** tools/list aggregation is expensive; cache per caller for 60s. */
  private mcpToolsCache = new Map<string, { at: number; data: AggregateResult }>();
  /** Per-caller-key sliding window (rpmPerKey). In-process, not distributed. */
  private readonly rateLimiter = new SlidingWindowRateLimiter();
  /** Per-tenant daily token counter for the budget circuit breaker. */
  private readonly dailyBudget = new DailyTokenBudget();

  constructor(private readonly deps: GatewayDeps) {}

  /**
   * Buffer a per-call governance event for the cloud audit chain. Metadata
   * only — details must never include message bodies, credentials or upstream
   * response content.
   */
  private auditEvent(event: Omit<EdgeAuditEvent, "eventId" | "ts">): void {
    this.deps.audit.enqueue({
      eventId: randomUUID(),
      ts: new Date().toISOString(),
      ...event,
    });
  }

  get url(): string {
    return `http://${this.deps.store.get().bindHost}:${this.port}/v1`;
  }

  get running(): boolean {
    return this.server !== null;
  }

  get currentPort(): number {
    return this.port;
  }

  private isLoopback(req: http.IncomingMessage): boolean {
    const addr = req.socket.remoteAddress ?? "";
    return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  }

  /**
   * Variables exposed to policy conditions expressions; mirrors the relay-side
   * context (model / agent.* / tenant.plan / usage.* / subject). Token usage is
   * only known after an upstream call, so offline pre-dispatch evaluation
   * exposes zeroed counters.
   */
  private policyExprCtx(cached: BootstrapCache | null, callerAgent: string, model: string): Record<string, unknown> {
    const localAgent = callerAgent ? this.deps.local.listAgents().find((a) => a.id === callerAgent) : undefined;
    return {
      model,
      agent: { id: callerAgent, type: localAgent?.type ?? "" },
      tenant: { plan: cached?.plan ?? "" },
      usage: { inputTokens: 0, outputTokens: 0 },
      subject: callerAgent || "",
    };
  }

  /**
   * Resolve the calling agent. A Bearer ak_ key is validated offline against
   * the sha256 hashes pushed at bootstrap; its bound agentId is authoritative
   * (self-asserted x-aegis-agent headers are ignored when a key is present).
   * Loopback callers may stay anonymous; remote callers must present a valid
   * key. Returns the bound agentId + the presented key's sha256 ("" for
   * anonymous loopback callers), or null after sending a 401 response.
   */
  private authorize(req: http.IncomingMessage, res: http.ServerResponse): { agentId: string; keyHash: string } | null {
    const bearer = (this.header(req, "authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (bearer) {
      const hash = createHash("sha256").update(bearer).digest("hex");
      // Local registry first (community-edition identities issued by this
      // proxy), then the bootstrap-pushed hashes for SaaS-bound agents.
      const localHit = this.deps.local.listAgents().find((a) => a.keyHash === hash);
      if (localHit) return { agentId: localHit.id, keyHash: hash };
      const hit = (this.deps.cache.readBootstrap()?.apiKeyHashes ?? []).find((k) => k.hash === hash);
      if (!hit) {
        this.sendJson(res, 401, openAiErrorBody("invalid_api_key", "Invalid or revoked gateway API key."));
        return null;
      }
      return { agentId: hit.agentId, keyHash: hash };
    }
    if (!this.isLoopback(req)) {
      this.sendJson(res, 401, openAiErrorBody("api_key_required", "Authorization: Bearer <agent gateway key> is required for non-local callers."));
      return null;
    }
    return { agentId: "", keyHash: "" };
  }

  async start(port: number): Promise<void> {
    await this.stop();
    this.port = port;
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) {
          this.sendJson(res, 500, openAiErrorBody("internal_error", err instanceof Error ? err.message : String(err)));
        } else {
          res.end();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(port, this.deps.store.get().bindHost, () => {
        server.removeListener("error", onError);
        this.deps.log("info", "gateway", `listening on ${this.url}`);
        this.deps.emitState();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/v1/models") {
      await this.forwardModels(res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      await this.chatCompletions(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/messages") {
      await this.anthropicMessages(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/mcp/invoke") {
      await this.mcpInvoke(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/skills/use") {
      await this.skillUse(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/capabilities") {
      await this.capabilities(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/mcp") {
      await this.mcpAggregate(req, res);
      return;
    }
    this.sendJson(res, 404, openAiErrorBody("not_found", `${req.method} ${url.pathname}`));
  }

  // -------------------------------------------------------------------------
  // Capability delivery: what this caller may use (skills incl. content, MCPs)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Capability sources: local stores first (standalone source of truth; in
  // connected mode local entries override SaaS-pushed ones on name collision),
  // then the bootstrap entitlement views.
  // -------------------------------------------------------------------------

  private mergedSkills(agentId: string | null): SkillEntitlement[] {
    const localRows = this.deps.local.listSkills().map((s) => ({
      id: s.id,
      name: s.name,
      source: "LOCAL",
      description: s.description,
      allowedAgentIds: [] as string[],
      activeVersion: { version: s.version, content: s.content, format: s.format },
    }));
    const localNames = new Set(localRows.map((s) => s.name));
    const remote = (this.deps.cache.readBootstrap()?.skills ?? []).filter((s) => !localNames.has(s.name));
    return [...localRows, ...remote].filter((s) => {
      if (!s.activeVersion) return false;
      if (agentId === null) return true;
      return s.allowedAgentIds.length === 0 || (agentId && s.allowedAgentIds.includes(agentId));
    });
  }

  private mergedMcp(agentId: string | null, httpOnly: boolean): McpEntitlement[] {
    const localRows = this.deps.local.listMcp().map((m) => ({
      id: m.id,
      name: m.name,
      endpoint: m.endpoint,
      transport: m.transport,
      riskLevel: m.riskLevel,
      authType: m.authType,
      authTokenEnc: m.authTokenEnc,
      allowedAgentIds: m.allowedAgentIds,
    }));
    const localNames = new Set(localRows.map((m) => m.name));
    const remote = (this.deps.cache.readBootstrap()?.mcp ?? []).filter((m) => !localNames.has(m.name));
    return [...localRows, ...remote].filter((m) => {
      if (httpOnly && m.transport !== "STREAMABLE_HTTP") return false;
      if (agentId === null) return true;
      return m.allowedAgentIds.length === 0 || (agentId && m.allowedAgentIds.includes(agentId));
    });
  }

  private allowedSkills(agentId: string): SkillEntitlement[] {
    return this.mergedSkills(agentId);
  }

  private allowedMcp(agentId: string, httpOnly: boolean): McpEntitlement[] {
    return this.mergedMcp(agentId, httpOnly);
  }

  /** Lookup without agent filtering so invoke handlers can distinguish 403 from 404. */
  private findSkillAny(skillId: string): SkillEntitlement | undefined {
    return this.mergedSkills(null).find((s) => s.id === skillId || s.name === skillId);
  }

  private findMcpAny(mcpId: string): McpEntitlement | undefined {
    return this.mergedMcp(null, false).find((m) => m.id === mcpId || m.name === mcpId);
  }

  /** Extra system block with every allowed skill, appended when a caller asks for it. */
  private skillsSystemBlock(agentId: string): string | null {
    const skills = this.allowedSkills(agentId);
    if (skills.length === 0) return null;
    const blocks = skills
      .map((s) => `### ${s.name} (v${s.activeVersion!.version})\n\n${s.activeVersion!.content}`)
      .join("\n\n---\n\n");
    return `## Aegis Skills\n\nThe following skills are provisioned for you by the enterprise Aegis gateway. Apply them when the user's request matches.\n\n${blocks}`;
  }

  private async capabilities(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const authed = this.authorize(req, res);
    if (authed === null) return;
    const agentId = authed.agentId || this.header(req, "x-aegis-agent");
    this.sendJson(res, 200, {
      gateway: "aegis-edge",
      skills: this.allowedSkills(agentId).map((s) => ({
        id: s.id, name: s.name, source: s.source,
        version: s.activeVersion!.version, format: s.activeVersion!.format,
        content: s.activeVersion!.content,
      })),
      mcp: this.allowedMcp(agentId, false).map((m) => ({
        id: m.id, name: m.name, endpoint: m.endpoint, transport: m.transport,
        riskLevel: m.riskLevel, authType: m.authType,
      })),
    });
  }

  // -------------------------------------------------------------------------
  // Aggregated MCP endpoint (streamable HTTP, stateless JSON-RPC)
  // -------------------------------------------------------------------------

  private mcpSources(agentId: string): McpUpstreamSource[] {
    return this.allowedMcp(agentId, true).map((m) => {
      let authToken: string | undefined;
      if (m.authType === "API_KEY" && m.authTokenEnc) {
        try {
          authToken = decryptSecret(m.authTokenEnc);
        } catch (err) {
          this.deps.log("warn", "gateway", `mcp ${m.name} auth token decrypt failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return { id: m.id, name: m.name, endpoint: m.endpoint, riskLevel: m.riskLevel, authToken };
    });
  }

  /** Local repo mutations must bust the tools/list aggregation cache immediately. */
  clearMcpToolsCache(): void {
    this.mcpToolsCache.clear();
  }

  private async aggregatedTools(agentId: string): Promise<AggregateResult> {
    const key = agentId || "__anonymous__";
    const hit = this.mcpToolsCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.data;
    const data = await aggregateMcpTools(this.mcpSources(agentId));
    this.mcpToolsCache.set(key, { at: Date.now(), data });
    if (this.mcpToolsCache.size > 200) this.mcpToolsCache.clear();
    return data;
  }

  private async mcpAggregate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = Date.now();
    const authed = this.authorize(req, res);
    if (authed === null) return;
    const agentId = authed.agentId || this.header(req, "x-aegis-agent");

    const raw = await readBody(req);
    let msg: { id?: unknown; method?: unknown; params?: unknown } = {};
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      this.sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const method = typeof msg.method === "string" ? msg.method : "";
    const id = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;

    const reply = (result: unknown) => this.sendJson(res, 200, { jsonrpc: "2.0", id, result });
    const replyErr = (code: number, message: string) => this.sendJson(res, 200, { jsonrpc: "2.0", id, error: { code, message } });

    if (method === "initialize") {
      reply({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "aegis-gateway", version: typeof AEGIS_AGENT_VERSION !== "undefined" ? AEGIS_AGENT_VERSION : "0.1.0" },
      });
      return;
    }
    if (method.startsWith("notifications/")) {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end();
      return;
    }
    if (method === "ping") {
      reply({});
      return;
    }
    if (method === "tools/list") {
      // Policy gate (PRD 7.5): tool discovery is the mcp:discover action.
      // Default deny applies in connected mode; standalone keeps skipping
      // policy entirely. A denied discovery is a plain 403 policy_denied.
      const cached = this.deps.cache.readBootstrap();
      if (this.deps.store.get().mode !== "standalone") {
        const decision = evaluateAction({
          policies: cached ? cached.policies : null,
          action: "mcp:discover",
          resource: "*",
          agentId,
          expr: this.policyExprCtx(cached, agentId, ""),
        });
        if (!decision.allow) {
          this.deps.log("warn", "gateway", `POST /mcp tools/list agent=${agentId || "-"} -> 403 policy_denied (${decision.reason})`);
          this.auditEvent({
            type: "policy_evaluated",
            agentId,
            agentVersion: "",
            model: "",
            traceId: "",
            tool: "",
            outcome: "DENY",
            detail: { action: "mcp:discover", resource: "*", reason: decision.reason, policyName: decision.policyName ?? "" },
            cost: 0,
          });
          this.sendJson(res, 403, openAiErrorBody("policy_denied", `Local policy denied mcp:discover (${decision.reason})`));
          return;
        }
      }
      const agg = await this.aggregatedTools(agentId);
      for (const f of agg.failures) {
        this.deps.log("warn", "gateway", `mcp aggregate tools/list source=${f.source.name} failed: ${f.error.message}`);
      }
      reply({ tools: agg.tools });
      return;
    }
    if (method === "tools/call") {
      const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof params.name === "string" ? params.name : "";
      const agg = await this.aggregatedTools(agentId);
      const route = agg.routes.get(name);
      if (!route) {
        this.deps.log("warn", "gateway", `POST /mcp tools/call unknown tool=${name} agent=${agentId || "-"}`);
        replyErr(-32602, `Unknown tool "${name}". Call tools/list first.`);
        return;
      }

      // Policy gate (PRD 7.5): a tools/call is both an mcp:invoke and a
      // tool:execute (resource = aggregated tool name). Default deny applies
      // in connected mode; standalone keeps skipping policy entirely.
      const cached = this.deps.cache.readBootstrap();
      if (this.deps.store.get().mode !== "standalone") {
        for (const action of ["mcp:invoke", "tool:execute"] as const) {
          const decision = evaluateAction({
            policies: cached ? cached.policies : null,
            action,
            resource: name,
            agentId,
            expr: this.policyExprCtx(cached, agentId, ""),
          });
          if (!decision.allow) {
            this.deps.log("warn", "gateway", `POST /mcp tools/call ${name} agent=${agentId || "-"} -> policy_denied ${action} (${decision.reason})`);
            this.auditEvent({
              type: "policy_evaluated",
              agentId,
              agentVersion: "",
              model: "",
              traceId: "",
              tool: name,
              outcome: "DENY",
              detail: { action, resource: name, reason: decision.reason, policyName: decision.policyName ?? "" },
              cost: 0,
            });
            replyErr(-32004, `Policy denied ${action} (${decision.reason})`);
            return;
          }
        }
      }

      // Runtime approval gate (offline): tools flagged requiresApproval in the
      // bootstrap registry execute only with an APPROVED, unexpired grant for
      // (aggregated tool, agent). Denied calls cannot create requests offline —
      // the error directs the caller through the relay/console instead.
      const cachedNow = this.deps.cache.readBootstrap();
      const registry = cachedNow?.mcp.find((m) => m.id === route.source.id);
      const toolRow = registry?.tools?.find((t) => t.name === route.upstreamName);
      if (toolRow?.requiresApproval) {
        const grant = (cachedNow?.toolApprovals ?? []).find(
          (a) => a.tool === name && (a.agentId === "" || a.agentId === agentId)
        );
        if (!grant) {
          this.deps.log("warn", "gateway", `POST /mcp tools/call ${name} agent=${agentId || "-"} -> approval_required (offline deny)`);
          this.auditEvent({
            type: "tool_invoked",
            agentId,
            agentVersion: "",
            model: "",
            traceId: "",
            tool: name,
            outcome: "DENY",
            detail: { reason: "approval_required", source: route.source.name, upstreamName: route.upstreamName },
            cost: 0,
          });
          replyErr(-32003, `Tool "${name}" requires approval. Re-run via the SaaS relay or ask an admin to approve in Console > Approvals, then refresh the proxy snapshot.`);
          return;
        }
      }

      const out = await callMcpRpc(route.source.endpoint, "tools/call", { name: route.upstreamName, arguments: params.arguments ?? {} }, route.source.authToken, 120_000);
      if (!out.ok) {
        this.deps.log("warn", "gateway", `POST /mcp tools/call ${name} agent=${agentId || "-"} -> upstream error ${out.error.code} ${out.error.message}`);
        this.auditEvent({
          type: "tool_invoked",
          agentId,
          agentVersion: "",
          model: "",
          traceId: "",
          tool: name,
          outcome: "ERROR",
          detail: { source: route.source.name, upstreamName: route.upstreamName, errorCode: out.error.code, latencyMs: Date.now() - started },
          cost: 0,
        });
        this.sendJson(res, 200, { jsonrpc: "2.0", id, error: out.error });
        return;
      }
      this.deps.log("info", "gateway", `POST /mcp tools/call ${name} agent=${agentId || "-"} -> 200 (${Date.now() - started}ms)`);
      this.auditEvent({
        type: "tool_invoked",
        agentId,
        agentVersion: "",
        model: "",
        traceId: "",
        tool: name,
        outcome: "SUCCESS",
        detail: { source: route.source.name, upstreamName: route.upstreamName, latencyMs: Date.now() - started },
        cost: 0,
      });
      reply(out.result);
      return;
    }
    replyErr(-32601, `Method not found: ${method}`);
  }

  // -------------------------------------------------------------------------
  // Chat completions: policy -> edge direct -> SaaS relay
  // -------------------------------------------------------------------------

  private async chatCompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const authed = this.authorize(req, res);
    if (authed === null) return;
    const callerAgent = authed.agentId || this.header(req, "x-aegis-agent");
    const raw = await readBody(req);
    let body: ChatBody | null = null;
    try {
      body = JSON.parse(raw) as ChatBody;
    } catch {
      this.sendJson(res, 400, openAiErrorBody("invalid_request_error", "Request body must be valid JSON"));
      return;
    }
    await this.dispatchChat(res, raw, body, callerAgent, authed.keyHash, this.header(req, "x-aegis-agent-version"), Date.now(), "openai", this.header(req, "x-aegis-inject-skills"));
  }

  // Anthropic Messages API adapter: convert to OpenAI shape and run the same
  // policy -> edge -> relay pipeline; the response is converted back.
  private async anthropicMessages(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const authed = this.authorize(req, res);
    if (authed === null) return;
    const callerAgent = authed.agentId || this.header(req, "x-aegis-agent");
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Request body must be valid JSON" } });
      return;
    }
    const valid = anthropicMessagesSchema.safeParse(parsed);
    if (!valid.success) {
      this.sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: valid.error.issues.map((i) => i.message).join("; ") } });
      return;
    }
    const converted = anthropicToOpenAI(valid.data);
    await this.dispatchChat(
      res,
      JSON.stringify(converted),
      converted as unknown as ChatBody,
      callerAgent,
      authed.keyHash,
      this.header(req, "x-aegis-agent-version"),
      Date.now(),
      "anthropic",
      this.header(req, "x-aegis-inject-skills")
    );
  }

  private async dispatchChat(
    res: http.ServerResponse,
    raw: string,
    body: ChatBody | null,
    callerAgent: string,
    callerKey: string,
    callerAgentVersion: string,
    started: number,
    format: "openai" | "anthropic",
    injectSkills = ""
  ): Promise<void> {
    const model = typeof body?.model === "string" && body.model ? body.model : "deepseek-chat";

    // Guardrail config: standalone mode enforces the local settings; connected
    // mode uses the bootstrap-pushed tenant config (normalize makes an absent
    // field on an old cache "everything off", so legacy tenants are untouched).
    const config = this.deps.store.get();
    const cached = this.deps.cache.readBootstrap();
    const standalone = config.mode === "standalone";
    const safety = normalizeContentSafety(standalone ? config.contentSafety : cached?.contentSafety);
    const limits = normalizeLimits(standalone ? config.limits : cached?.limits);
    const guard = normalizeAiGuard(standalone ? config.aiGuard : cached?.aiGuard);
    const budgetScope = standalone ? "local" : (cached?.device?.tenantId ?? "local");

    // Per-key RPM sliding window (in-process, not distributed). 0 = unlimited.
    if (limits.rpmPerKey > 0) {
      const rl = this.rateLimiter.allow(`edge:${callerKey || "anonymous"}`, limits.rpmPerKey);
      if (!rl.allowed) {
        this.deps.log(
          "warn",
          "gateway",
          `chat model=${model} -> 429 rate_limited (rpmPerKey=${limits.rpmPerKey}, retryAfter=${rl.retryAfterSec}s, caller=${(callerKey || "anonymous").slice(0, 12)})`
        );
        this.auditEvent({
          type: "rate_limited",
          agentId: callerAgent,
          agentVersion: callerAgentVersion,
          model,
          traceId: "",
          tool: "",
          outcome: "DENY",
          detail: { scope: "rpmPerKey", rpmPerKey: limits.rpmPerKey, retryAfterSec: rl.retryAfterSec },
          cost: 0,
        });
        this.sendJson(
          res,
          429,
          openAiErrorBody("rate_limited", `Rate limit exceeded: ${limits.rpmPerKey} requests per minute. Retry after ${rl.retryAfterSec}s.`),
          { "Retry-After": String(rl.retryAfterSec) }
        );
        return;
      }
    }

    // Daily token budget hard stop (0 = unlimited). With hard stop off the
    // breaker only warns once per threshold crossing (see edgeChat metering).
    if (limits.dailyTokenBudget > 0 && limits.budgetHardStop && this.dailyBudget.exhausted(budgetScope, limits.dailyTokenBudget)) {
      const used = this.dailyBudget.current(budgetScope);
      this.deps.log("warn", "gateway", `chat model=${model} -> 429 budget_exceeded (${used}/${limits.dailyTokenBudget})`);
      this.auditEvent({
        type: "budget_exceeded",
        agentId: callerAgent,
        agentVersion: callerAgentVersion,
        model,
        traceId: "",
        tool: "",
        outcome: "DENY",
        detail: { scope: budgetScope, used, limit: limits.dailyTokenBudget },
        cost: 0,
      });
      this.sendJson(res, 429, openAiErrorBody("budget_exceeded", `Daily token budget exceeded (${used}/${limits.dailyTokenBudget}).`));
      return;
    }

    // Request-side content safety scan: standalone applies it before local
    // egress; connected mode scans right after the policy decision (before any
    // caching/egress). Responses are never scanned.
    const contentScanBlocked = (): boolean => {
      if (!safety.enabled) return false;
      const scan = scanMessages(body?.messages, safety);
      if (!scan.hit) return false;
      this.deps.log(
        "warn",
        "gateway",
        `chat model=${model} -> content safety ${safety.mode} checks=[${scan.kinds.join(",")}]`
      );
      this.auditEvent({
        type: "content_blocked",
        agentId: callerAgent,
        agentVersion: callerAgentVersion,
        model,
        traceId: "",
        tool: "",
        outcome: safety.mode === "BLOCK" ? "DENY" : "ALLOW",
        detail: { checks: scan.kinds, mode: safety.mode },
        cost: 0,
      });
      if (safety.mode === "BLOCK") {
        this.sendJson(
          res,
          403,
          openAiErrorBody("content_blocked", `Content blocked by content safety policy (checks: ${scan.kinds.join(", ")})`)
        );
        return true;
      }
      return false;
    };

    // Locally-issued agent tokens carry a model boundary (empty = unrestricted).
    if (callerAgent) {
      const localAgent = this.deps.local.listAgents().find((a) => a.id === callerAgent);
      if (localAgent && localAgent.models.length > 0 && !localAgent.models.includes(model)) {
        this.auditEvent({
          type: "policy_evaluated",
          agentId: callerAgent,
          agentVersion: callerAgentVersion,
          model,
          traceId: "",
          tool: "",
          outcome: "DENY",
          detail: { action: "model:invoke", resource: model, reason: "agent_model_denied" },
          cost: 0,
        });
        this.sendJson(res, 403, openAiErrorBody("agent_model_denied", `Model "${model}" is not allowed for this agent`));
        return;
      }
    }

    // Standalone mode (SaaS-less on-premise): no tenant policy/governance
    // prompt applies; traffic egresses only through locally configured
    // credentials — provider keys never leave the enterprise. Guardrails
    // above and the content scan below DO apply (local config).
    if (standalone) {
      if (contentScanBlocked()) return;
      if (
        guard.enabled &&
        (await this.aiGuardGate(
          res,
          guard,
          guard.credentialId ? this.deps.local.listCredentials().find((c) => c.id === guard.credentialId) : undefined,
          body?.messages,
          model,
          callerAgent,
          callerAgentVersion,
          ""
        ))
      ) {
        return;
      }
      let outgoing = raw;
      if (injectSkills && body && Array.isArray(body.messages)) {
        const block = this.skillsSystemBlock(callerAgent);
        if (block) {
          body.messages = [...body.messages, { role: "system", content: block }];
          outgoing = JSON.stringify(body);
        }
      }
      const local = this.deps.local.listCredentials().find((c) => c.models.length === 0 || c.models.includes(model));
      if (!local) {
        this.deps.log("warn", "gateway", `standalone chat model=${model} -> 428 no local credential`);
        this.sendJson(
          res,
          428,
          openAiErrorBody("standalone_no_credential", `Standalone mode: no local model credential covers "${model}". Add one in the proxy's local credentials page.`)
        );
        return;
      }
      await this.edgeChat(local, outgoing, body, res, model, callerAgent, callerAgentVersion, started, format, budgetScope, limits.dailyTokenBudget);
      return;
    }

    // Local policy enforcement (cached set; default deny, DENY first).
    const decision = evaluateAction({
      policies: cached ? cached.policies : null,
      action: "model:invoke",
      resource: model,
      agentId: callerAgent,
      expr: this.policyExprCtx(cached, callerAgent, model),
    });
    this.auditEvent({
      type: "policy_evaluated",
      agentId: callerAgent,
      agentVersion: callerAgentVersion,
      model,
      traceId: "",
      tool: "",
      outcome: decision.allow ? "ALLOW" : "DENY",
      detail: {
        action: "model:invoke",
        resource: model,
        reason: decision.reason,
        policyName: decision.policyName ?? "",
        conditionError: decision.conditionError ?? "",
      },
      cost: 0,
    });
    if (!decision.allow) {
      const detail = `Local policy denied model:invoke (${decision.reason})${decision.policyName ? ` [${decision.policyName}]` : ""}${decision.conditionError ? ` conditionError=${decision.conditionError}` : ""}`;
      this.deps.log("warn", "gateway", `chat model=${model} -> 403 ${detail}`);
      this.sendJson(res, 403, openAiErrorBody("policy_denied", detail));
      return;
    }

    if (contentScanBlocked()) return;

    if (
      guard.enabled &&
      (await this.aiGuardGate(
        res,
        guard,
        guard.credentialId ? cached?.credentials?.find((c) => c.id === guard.credentialId) : undefined,
        body?.messages,
        model,
        callerAgent,
        callerAgentVersion,
        cached?.plan ?? ""
      ))
    ) {
      return;
    }

    // Governance prompt injection: tenant-level, pushed via bootstrap.
    let outgoing = raw;
    if (cached?.govPrompt && body && Array.isArray(body.messages)) {
      body.messages = [{ role: "system", content: cached.govPrompt }, ...body.messages];
      outgoing = JSON.stringify(body);
    }

    // Opt-in skill injection: callers pass x-aegis-inject-skills: 1 to have
    // every entitlement-allowed skill appended as a trailing system block.
    if (injectSkills && body && Array.isArray(body.messages)) {
      const block = this.skillsSystemBlock(callerAgent);
      if (block) {
        body.messages = [...body.messages, { role: "system", content: block }];
        outgoing = JSON.stringify(body);
      }
    }

    // Edge direct: bootstrap pushed a credential covering this model.
    if (cached && cached.mode === "edge") {
      const credential = pickEdgeCredential(cached.credentials ?? [], model);
      if (credential) {
        await this.edgeChat(credential, outgoing, body, res, model, callerAgent, callerAgentVersion, started, format, budgetScope, limits.dailyTokenBudget);
        return;
      }
      this.deps.log("info", "gateway", `no edge credential matches ${model}; falling back to SaaS relay`);
    }

    // SaaS relay fallback.
    if (!config.gatewayApiKey) {
      this.deps.log("warn", "gateway", `chat model=${model} -> 428 no_api_key configured`);
      this.sendJson(
        res,
        428,
        openAiErrorBody("no_api_key", "No edge credential matched and no gateway API key (ak_...) is configured.")
      );
      return;
    }
    await this.relayChat(outgoing, res, model, started, format);
  }

  /**
   * AI 决策式策略评估 gate（Jev 风格治理判定）：用租户配置的模型对
   * system + 最后一条 user 请求做结构化判定。BLOCK 模式 decision=block ->
   * 403 ai_policy_blocked（body 含 categories + reason）；review 放行但记审计；
   * AUDIT_ONLY 全放行只记审计。判定失败（无凭证/超时/上游错误/解析失败）
   * 按 failOpen 放行或阻断，并记 ai_decision ERROR 审计。判定消耗计入计量
   * 队列（metadata 标 aiGuard:true）。返回 true = 已响应（阻断）。
   */
  private async aiGuardGate(
    res: http.ServerResponse,
    cfg: AiGuardConfig,
    credential: AiGuardCredentialLike | undefined,
    messages: unknown,
    model: string,
    callerAgent: string,
    callerAgentVersion: string,
    plan: string
  ): Promise<boolean> {
    const judge = await runAiGuardJudge({
      cfg,
      credential,
      messages,
      model,
      agentLabel: callerAgent || "anonymous",
      plan,
    });
    if (!judge.ok) {
      this.deps.log("warn", "gateway", `chat model=${model} -> ai_decision ERROR (${judge.error}), failOpen=${cfg.failOpen}`);
      this.auditEvent({
        type: "ai_decision",
        agentId: callerAgent,
        agentVersion: callerAgentVersion,
        model,
        traceId: "",
        tool: "",
        outcome: "ERROR",
        detail: { mode: cfg.mode, error: judge.error, failOpen: cfg.failOpen },
        cost: 0,
      });
      if (!cfg.failOpen) {
        this.sendJson(res, 403, openAiErrorBody("ai_policy_blocked", "本次调用被 AI 治理策略拦截（AI 判定不可用，fail-closed）"));
        return true;
      }
      return false;
    }
    const d = judge.decision;
    const blocked = d.decision === "block" && cfg.mode === "BLOCK";
    const cost = computeLocalCost(this.deps.local, judge.judgeModel, {
      promptTokens: judge.usage.promptTokens,
      completionTokens: judge.usage.completionTokens,
      cachedTokens: 0,
    });
    this.deps.meter.enqueue({
      eventId: randomUUID(),
      traceId: "",
      apiKeyId: credential?.id ?? "",
      agentId: callerAgent,
      agentVersion: callerAgentVersion,
      provider: credential?.provider ?? "",
      model: judge.judgeModel,
      ...judge.usage,
      cachedTokens: 0,
      latencyMs: judge.latencyMs,
      status: "SUCCESS",
      cost,
      occurredAt: new Date().toISOString(),
      metadata: { aiGuard: true },
    });
    this.auditEvent({
      type: "ai_decision",
      agentId: callerAgent,
      agentVersion: callerAgentVersion,
      model,
      traceId: "",
      tool: "",
      outcome: blocked ? "DENY" : "ALLOW",
      detail: {
        mode: cfg.mode,
        decision: d.decision,
        categories: d.categories,
        confidence: d.confidence,
        reason: d.reason,
        judgeModel: judge.judgeModel,
      },
      cost,
    });
    if (blocked) {
      this.deps.log("warn", "gateway", `chat model=${model} -> 403 ai_policy_blocked categories=[${d.categories.join(",")}]`);
      this.sendJson(
        res,
        403,
        openAiErrorBody(
          "ai_policy_blocked",
          `本次调用被 AI 治理策略拦截 (categories: ${d.categories.join(", ") || "policy_violation"}; reason: ${d.reason || "AI policy decision: block"})`
        )
      );
      return true;
    }
    return false;
  }

  /** Call the upstream provider directly with the locally decrypted key; meter usage. */
  private async edgeChat(
    credential: EdgeCredential,
    raw: string,
    body: ChatBody | null,
    res: http.ServerResponse,
    model: string,
    callerAgent: string,
    callerAgentVersion: string,
    started: number,
    format: "openai" | "anthropic",
    budgetScope: string,
    dailyTokenBudget: number
  ): Promise<void> {
    const traceId = randomUUID();
    let apiKey: string;
    try {
      apiKey = decryptSecret(credential.apiKeyEnc);
    } catch (err) {
      this.deps.log("error", "gateway", `credential ${credential.id} decrypt failed: ${err instanceof Error ? err.message : String(err)}`);
      this.auditEvent({
        type: "model_error",
        agentId: callerAgent,
        agentVersion: callerAgentVersion,
        model,
        traceId,
        tool: "",
        outcome: "ERROR",
        detail: { error: "credential_decrypt_failed", credentialId: credential.id },
        cost: 0,
      });
      this.sendJson(res, 500, openAiErrorBody("credential_decrypt_failed", "Edge credential could not be decrypted (DATA_KEY mismatch?)"));
      return;
    }

    // Ensure streaming responses carry a usage chunk for local metering.
    let outgoing = raw;
    if (body?.stream === true && !body.stream_options) {
      outgoing = JSON.stringify({ ...(body as Record<string, unknown>), stream_options: { include_usage: true } });
    }

    let upstream: Response;
    try {
      upstream = await fetch(`${credential.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": "aegis-local-agent/0.1",
        },
        body: outgoing,
        signal: AbortSignal.timeout(10 * 60_000),
      });
    } catch (err) {
      this.deps.log("error", "gateway", `edge upstream ${credential.baseUrl} unreachable: ${err instanceof Error ? err.message : String(err)}`);
      this.auditEvent({
        type: "model_error",
        agentId: callerAgent,
        agentVersion: callerAgentVersion,
        model,
        traceId,
        tool: "",
        outcome: "ERROR",
        detail: { error: "edge_upstream_unreachable", provider: credential.provider },
        cost: 0,
      });
      this.sendJson(res, 503, openAiErrorBody("edge_upstream_unreachable", `Upstream provider unreachable at ${credential.baseUrl}`));
      return;
    }

    const contentType = upstream.headers.get("content-type") ?? "application/json";
    const isSse = contentType.startsWith("text/event-stream");
    const meter = (usage: RawUsage | null, ok: boolean) => {
      const tokens = normalizeUsage(usage);
      const cost = computeLocalCost(this.deps.local, model, tokens);
      this.deps.meter.enqueue({
        eventId: traceId,
        traceId,
        apiKeyId: credential.id,
        agentId: callerAgent,
        agentVersion: callerAgentVersion,
        provider: credential.provider,
        model,
        ...tokens,
        latencyMs: Date.now() - started,
        status: ok ? "SUCCESS" : "ERROR",
        cost,
        occurredAt: new Date().toISOString(),
      });
      this.auditEvent({
        type: ok ? "model_response" : "model_error",
        agentId: callerAgent,
        agentVersion: callerAgentVersion,
        model,
        traceId,
        tool: "",
        outcome: ok ? "SUCCESS" : "ERROR",
        detail: {
          provider: credential.provider,
          apiKeyId: credential.id,
          latencyMs: Date.now() - started,
          promptTokens: tokens.promptTokens,
          completionTokens: tokens.completionTokens,
          totalTokens: tokens.totalTokens,
          cachedTokens: tokens.cachedTokens,
          upstreamStatus: upstream.status,
        },
        cost,
      });
      // Daily budget accounting (in-process; resets at midnight). The proxy
      // has no audit writer, so threshold crossings land in the local log.
      if (dailyTokenBudget > 0) {
        const res2 = this.dailyBudget.add(budgetScope, tokens.promptTokens + tokens.completionTokens, dailyTokenBudget);
        if (res2.crossed80 || res2.crossed100) {
          this.deps.log(
            "warn",
            "gateway",
            `budget_threshold ${res2.crossed100 ? 100 : 80}% reached for scope=${budgetScope}: ${res2.used}/${dailyTokenBudget} tokens today`
          );
        }
      }
    };

    res.writeHead(upstream.status, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "x-aegis-trace": traceId,
      "x-aegis-mode": "edge",
    });
    this.deps.log(
      "info",
      "gateway",
      `POST /v1/chat/completions model=${model} mode=edge cred=${credential.id} stream=${isSse} -> ${upstream.status} (${Date.now() - started}ms)`
    );

    if (!upstream.body) {
      res.end();
      meter(null, upstream.ok);
      return;
    }
    const upstreamNode = Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]);

    if (isSse) {
      // Real-time passthrough with a metering tap on the side.
      const meterChunks: Buffer[] = [];
      upstreamNode.on("data", (chunk: Buffer) => meterChunks.push(chunk));
      upstreamNode.on("end", () => {
        meter(extractUsageFromSse(meterChunks), upstream.ok);
      });
      upstreamNode.on("error", (err: Error) => this.deps.log("warn", "gateway", `edge stream error: ${err.message}`));
      const out =
        format === "anthropic"
          ? Readable.fromWeb(
              (Readable.toWeb(upstreamNode) as ReadableStream<Uint8Array>).pipeThrough(openAiSseToAnthropic(model)) as unknown as Parameters<typeof Readable.fromWeb>[0]
              )
          : upstreamNode;
      out.pipe(res);
    } else {
      const text = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        upstreamNode.on("data", (c: Buffer) => chunks.push(c));
        upstreamNode.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        upstreamNode.on("error", reject);
      });
      let usage: RawUsage | null = null;
      try {
        const json = JSON.parse(text) as { usage?: RawUsage };
        usage = json.usage ?? null;
      } catch {
        usage = null;
      }
      if (!usage) this.deps.log("warn", "gateway", `edge response for ${model} carried no usage; metering zeros`);
      if (format === "anthropic") {
        try {
          res.end(JSON.stringify(openAiToAnthropic(JSON.parse(text) as Record<string, unknown>, model)));
        } catch {
          res.end(text);
        }
      } else {
        res.end(text);
      }
      meter(usage, upstream.ok);
    }
  }

  /** SaaS relay fallback: forward to the control plane with the configured ak_ key. */
  private async relayChat(raw: string, res: http.ServerResponse, model: string, started: number, format: "openai" | "anthropic"): Promise<void> {
    const config = this.deps.store.get();
    const version = typeof AEGIS_AGENT_VERSION !== "undefined" ? AEGIS_AGENT_VERSION : "0.1.0";
    let upstream: Response;
    try {
      upstream = await fetch(`${config.controlPlaneUrl}/api/gateway/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.gatewayApiKey}`,
          "x-aegis-agent": "aegis-local-agent",
          "x-aegis-agent-version": version,
          "x-aegis-device": this.deps.deviceId(),
        },
        body: raw,
        signal: AbortSignal.timeout(10 * 60_000),
      });
    } catch (err) {
      this.deps.log("error", "gateway", `control plane unreachable (${err instanceof Error ? err.message : String(err)})`);
      this.sendJson(
        res,
        503,
        openAiErrorBody("control_plane_unreachable", `Control plane unreachable at ${config.controlPlaneUrl}`)
      );
      return;
    }

    const trace = upstream.headers.get("x-aegis-trace");
    const headers: Record<string, string> = {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-cache",
      "x-aegis-mode": "relay",
    };
    if (trace) headers["x-aegis-trace"] = trace;
    res.writeHead(upstream.status, headers);
    this.deps.log(
      "info",
      "gateway",
      `POST /v1/chat/completions model=${model} mode=relay -> ${upstream.status} (${Date.now() - started}ms)`
    );
    const nodeStream = upstream.body
      ? Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0])
      : null;
    if (!nodeStream) {
      res.end();
      return;
    }
    if (format === "openai") {
      nodeStream.pipe(res);
      return;
    }
    if ((upstream.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
      Readable.fromWeb(
        (Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>).pipeThrough(openAiSseToAnthropic(model)) as unknown as Parameters<typeof Readable.fromWeb>[0]
        ).pipe(res);
      return;
    }
    const text = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      nodeStream.on("data", (c: Buffer) => chunks.push(c));
      nodeStream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      nodeStream.on("error", reject);
    });
    try {
      res.end(JSON.stringify(openAiToAnthropic(JSON.parse(text) as Record<string, unknown>, model)));
    } catch {
      res.end(text);
    }
  }

  // -------------------------------------------------------------------------
  // MCP / Skill entitlement enforcement
  // -------------------------------------------------------------------------

  private async mcpInvoke(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = Date.now();
    const authed = this.authorize(req, res);
    if (authed === null) return;
    const raw = await readBody(req);
    let parsed: { mcpId?: unknown; agentId?: unknown } = {};
    try {
      parsed = JSON.parse(raw) as { mcpId?: unknown; agentId?: unknown };
    } catch {
      this.sendJson(res, 400, openAiErrorBody("invalid_request_error", "Request body must be valid JSON"));
      return;
    }
    const mcpId = typeof parsed.mcpId === "string" ? parsed.mcpId : "";
    const agentId = (typeof parsed.agentId === "string" && parsed.agentId) || authed.agentId || this.header(req, "x-aegis-agent");
    if (!mcpId) {
      this.sendJson(res, 400, openAiErrorBody("mcp_id_required", "Body must include mcpId"));
      return;
    }

    // Policy gate (PRD 7.5): mcp:invoke, resource = the MCP server id. Default
    // deny in connected mode; standalone keeps skipping policy entirely.
    const cachedPolicy = this.deps.cache.readBootstrap();
    if (this.deps.store.get().mode !== "standalone") {
      const policy = evaluateAction({
        policies: cachedPolicy ? cachedPolicy.policies : null,
        action: "mcp:invoke",
        resource: mcpId,
        agentId,
        expr: this.policyExprCtx(cachedPolicy, agentId, ""),
      });
      if (!policy.allow) {
        this.deps.log("warn", "gateway", `POST /v1/mcp/invoke mcp=${mcpId} agent=${agentId || "-"} -> 403 policy_denied (${policy.reason})`);
        this.auditEvent({
          type: "policy_evaluated",
          agentId,
          agentVersion: "",
          model: "",
          traceId: "",
          tool: mcpId,
          outcome: "DENY",
          detail: { action: "mcp:invoke", resource: mcpId, reason: policy.reason, policyName: policy.policyName ?? "" },
          cost: 0,
        });
        this.sendJson(res, 403, openAiErrorBody("policy_denied", `Local policy denied mcp:invoke (${policy.reason})`));
        return;
      }
    }

    const view = this.findMcpAny(mcpId);
    const decision = checkMcpEntitlement(view, agentId);
    if (!decision.allow || !view) {
      this.deps.log("warn", "gateway", `POST /v1/mcp/invoke mcp=${mcpId} agent=${agentId || "-"} -> 403 ${decision.reason}`);
      this.auditEvent({
        type: "tool_invoked",
        agentId,
        agentVersion: "",
        model: "",
        traceId: "",
        tool: mcpId,
        outcome: "DENY",
        detail: { reason: decision.reason },
        cost: 0,
      });
      this.sendJson(res, 403, openAiErrorBody("mcp_denied", `MCP invoke denied (${decision.reason})`));
      return;
    }

    let upstream: Response;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "aegis-local-agent/0.1" };
      if (view.authType === "API_KEY" && view.authTokenEnc) {
        try {
          headers.Authorization = `Bearer ${decryptSecret(view.authTokenEnc)}`;
        } catch (err) {
          this.deps.log("warn", "gateway", `mcp ${view.name} auth token decrypt failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      upstream = await fetch(view.endpoint, {
        method: "POST",
        headers,
        body: raw,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      this.deps.log("error", "gateway", `mcp upstream ${view.endpoint} unreachable: ${err instanceof Error ? err.message : String(err)}`);
      this.auditEvent({
        type: "tool_invoked",
        agentId,
        agentVersion: "",
        model: "",
        traceId: "",
        tool: view.name,
        outcome: "ERROR",
        detail: { mcpId: view.id, error: "mcp_upstream_unreachable" },
        cost: 0,
      });
      this.sendJson(res, 502, openAiErrorBody("mcp_upstream_error", `MCP endpoint unreachable: ${view.endpoint}`));
      return;
    }
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-cache",
    });
    this.deps.log(
      "info",
      "gateway",
      `POST /v1/mcp/invoke mcp=${view.name} agent=${agentId || "-"} -> ${upstream.status} (${Date.now() - started}ms)`
    );
    this.auditEvent({
      type: "tool_invoked",
      agentId,
      agentVersion: "",
      model: "",
      traceId: "",
      tool: view.name,
      outcome: "SUCCESS",
      detail: { mcpId: view.id, upstreamStatus: upstream.status, latencyMs: Date.now() - started },
      cost: 0,
    });
    if (upstream.body) {
      Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
    } else {
      res.end();
    }
  }

  private async skillUse(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const authed = this.authorize(req, res);
    if (authed === null) return;
    const raw = await readBody(req);
    let parsed: { skillId?: unknown; agentId?: unknown } = {};
    try {
      parsed = JSON.parse(raw) as { skillId?: unknown; agentId?: unknown };
    } catch {
      this.sendJson(res, 400, openAiErrorBody("invalid_request_error", "Request body must be valid JSON"));
      return;
    }
    const skillId = typeof parsed.skillId === "string" ? parsed.skillId : "";
    const agentId = (typeof parsed.agentId === "string" && parsed.agentId) || authed.agentId || this.header(req, "x-aegis-agent");
    if (!skillId) {
      this.sendJson(res, 400, openAiErrorBody("skill_id_required", "Body must include skillId"));
      return;
    }

    // Policy gate (PRD 7.5): skill:use, resource = the skill id. Default deny
    // in connected mode; standalone keeps skipping policy entirely.
    const cachedPolicy = this.deps.cache.readBootstrap();
    if (this.deps.store.get().mode !== "standalone") {
      const policy = evaluateAction({
        policies: cachedPolicy ? cachedPolicy.policies : null,
        action: "skill:use",
        resource: skillId,
        agentId,
        expr: this.policyExprCtx(cachedPolicy, agentId, ""),
      });
      if (!policy.allow) {
        this.deps.log("warn", "gateway", `POST /v1/skills/use skill=${skillId} agent=${agentId || "-"} -> 403 policy_denied (${policy.reason})`);
        this.sendJson(res, 403, openAiErrorBody("policy_denied", `Local policy denied skill:use (${policy.reason})`));
        return;
      }
    }

    const view = this.findSkillAny(skillId);
    const decision = checkSkillEntitlement(view, agentId);
    if (!decision.allow || !view) {
      this.deps.log("warn", "gateway", `POST /v1/skills/use skill=${skillId} agent=${agentId || "-"} -> 403 ${decision.reason}`);
      this.sendJson(res, 403, openAiErrorBody("skill_denied", `Skill use denied (${decision.reason})`));
      return;
    }
    if (!view.activeVersion) {
      this.sendJson(res, 404, openAiErrorBody("skill_no_active_version", `Skill ${view.name} has no active version`));
      return;
    }
    this.deps.log("info", "gateway", `POST /v1/skills/use skill=${view.name} agent=${agentId || "-"} -> 200`);
    this.sendJson(res, 200, {
      id: view.id,
      name: view.name,
      source: view.source,
      version: view.activeVersion.version,
      format: view.activeVersion.format,
      content: view.activeVersion.content,
    });
  }

  // -------------------------------------------------------------------------
  // Models (relay)
  // -------------------------------------------------------------------------

  private async forwardModels(res: http.ServerResponse): Promise<void> {
    const started = Date.now();
    const config = this.deps.store.get();

    // Standalone mode: model list is synthesized from locally configured
    // credentials (credentials claiming all models contribute nothing enumerable).
    if (config.mode === "standalone") {
      const seen = new Set<string>();
      const data: { id: string; object: "model"; created: number; owned_by: string }[] = [];
      for (const c of this.deps.local.listCredentials()) {
        for (const m of c.models) {
          if (!seen.has(m)) {
            seen.add(m);
            data.push({ id: m, object: "model", created: 0, owned_by: c.provider });
          }
        }
      }
      this.sendJson(res, 200, { object: "list", data });
      this.deps.log("info", "gateway", `GET /v1/models standalone -> ${data.length} models (${Date.now() - started}ms)`);
      return;
    }

    if (!config.gatewayApiKey) {
      this.sendJson(
        res,
        428,
        openAiErrorBody("no_api_key", "Gateway API key (ak_...) not configured. Set it in the Aegis agent settings.")
      );
      return;
    }
    const version = typeof AEGIS_AGENT_VERSION !== "undefined" ? AEGIS_AGENT_VERSION : "0.1.0";
    let upstream: Response;
    try {
      upstream = await fetch(`${config.controlPlaneUrl}/api/gateway/v1/models`, {
        headers: {
          Authorization: `Bearer ${config.gatewayApiKey}`,
          "x-aegis-agent": "aegis-local-agent",
          "x-aegis-agent-version": version,
          "x-aegis-device": this.deps.deviceId(),
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      this.sendJson(
        res,
        503,
        openAiErrorBody("control_plane_unreachable", `Control plane unreachable at ${config.controlPlaneUrl}`)
      );
      return;
    }
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-cache",
    });
    this.deps.log("info", "gateway", `GET /v1/models -> ${upstream.status} (${Date.now() - started}ms)`);
    if (upstream.body) {
      Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
    } else {
      res.end();
    }
  }

  // -------------------------------------------------------------------------

  private header(req: http.IncomingMessage, name: string): string {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  }

  private sendJson(res: http.ServerResponse, status: number, payload: unknown, headers?: Record<string, string>): void {
    const text = JSON.stringify(payload);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache", ...headers });
    res.end(text);
  }
}
