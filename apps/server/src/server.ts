/**
 * Aegis Gateway — Community headless edition (Apache 2.0).
 *
 * One Node process that bundles the entire open-core data plane:
 *   - the OpenAI/Anthropic-compatible gateway + local repos (keys / MCP /
 *     Skill / agents / prices), identical to the Electron enterprise proxy
 *   - the same management UI the desktop app ships, served over HTTP with a
 *     REST + SSE bridge standing in for the Electron preload
 *
 * Core classes are shared with apps/agent (dependency-injected, no Electron
 * imports); only the host orchestration below is specific to this binary.
 *
 * Usage: node dist/server.js [--port 8929]
 *   AEGIS_DATA_DIR  data directory (default ~/.aegis/server)
 *   AEGIS_PUBLIC    static UI directory (default <pkg>/public)
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LICENSE_SECRET, normalizeAiGuard, normalizeContentSafety, normalizeLimits, verifyLicense, verifySnapshotSignature } from "@aegis/shared";
import type { BootstrapCache } from "../../agent/electron/cache";
import { Cache } from "../../agent/electron/cache";
import { initLocalKey } from "../../agent/electron/crypto";
import { GatewayServer } from "../../agent/electron/gateway";
import type { LocalAgent, LocalCredential, LocalMcp, LocalPrice, LocalSkill } from "../../agent/electron/localstore";
import { LocalStores } from "../../agent/electron/localstore";
import { MeterBuffer } from "../../agent/electron/metering";
import { AuditBuffer } from "../../agent/electron/audit";
import { ReachabilityRunner } from "../../agent/electron/reachability";
import { syncCapabilities } from "../../agent/electron/materialize";
import { ConfigStore } from "../../agent/electron/store";
import type {
  ActivationInput,
  ActivationResult,
  AgentConfig,
  BootstrapState,
  LogEntry,
  StateSnapshot,
  UpdateInfo,
} from "../../agent/electron/types";

declare const AEGIS_AGENT_VERSION: string;
const VERSION = typeof AEGIS_AGENT_VERSION !== "undefined" ? AEGIS_AGENT_VERSION : "0.1.0";

const args = process.argv.slice(2);
const argPort = Number(args[args.indexOf("--port") + 1]);
const HTTP_PORT = Number.isFinite(argPort) && argPort > 0 ? Math.floor(argPort) : Number(process.env.AEGIS_PORT ?? 8929);
const DATA_DIR = process.env.AEGIS_DATA_DIR ?? path.join(os.homedir(), ".aegis", "server");
const PUBLIC_DIR = process.env.AEGIS_PUBLIC ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const BOOTSTRAP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const METER_FLUSH_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Core wiring (shared with the Electron edition)
// ---------------------------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });
initLocalKey(DATA_DIR);

const store = new ConfigStore(DATA_DIR);
const cache = new Cache(DATA_DIR);
const local = new LocalStores(DATA_DIR);

const logBuffer: LogEntry[] = [];
function log(level: LogEntry["level"], kind: string, message: string): void {
  const entry: LogEntry = { ts: Date.now(), level, kind, message };
  logBuffer.push(entry);
  if (logBuffer.length > 500) logBuffer.shift();
  const line = `[${new Date(entry.ts).toISOString()}] [${kind}] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  broadcast("log", entry);
}

function deviceId(): string {
  return cache.readBootstrap()?.device?.id ?? "";
}

let online = false;
let bootstrapState: BootstrapState = { status: "none", at: null, error: null };
let updateInfo: UpdateInfo | null = null;
let lastCheckAt: string | null = null;
let licenseState: StateSnapshot["license"] = null;
let snapshotVerified = false;
let replayAttempts = 0;
let replayTimer: NodeJS.Timeout | null = null;

function collectHostIp(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "";
}

function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

const meter = new MeterBuffer(DATA_DIR, { store, log, onChange: pushState });
const audit = new AuditBuffer(DATA_DIR, { store, log, onChange: pushState });
const gateway = new GatewayServer({ store, cache, meter, audit, local, log, deviceId, emitState: pushState });
const runner = new ReachabilityRunner({
  store,
  cache,
  log,
  deviceId,
  onResults: (results) => {
    cache.writeResults(results);
    lastCheckAt = new Date().toISOString();
    pushState();
  },
  onQueueChange: pushState,
  onSyncFailure: scheduleQueueReplay,
  onSyncSuccess: () => {
    replayAttempts = 0;
  },
});

function maskAgent<T extends { keyHash: string }>(a: T): T {
  return { ...a, keyHash: a.keyHash ? "••••••••" : "" };
}

function capabilitySource(): BootstrapCache | null {
  if (store.get().mode === "standalone") {
    return {
      cachedAt: new Date().toISOString(),
      device: null,
      gatewayUrl: "",
      policies: [],
      credentials: [],
      mcp: [],
      skills: local.listSkills().map((s) => ({
        id: s.id,
        name: s.name,
        source: "LOCAL",
        description: s.description,
        allowedAgentIds: [],
        activeVersion: { version: s.version, content: s.content, format: s.format },
      })),
      catalog: [],
    };
  }
  return cache.readBootstrap();
}

function snapshot(): StateSnapshot {
  const config = store.get();
  const cached = cache.readBootstrap();
  const catalog = runner.catalog();
  const results = cache.readResults();
  const reachable = results.filter((r) => r.reachable).length;
  return {
    version: VERSION,
    online,
    checking: runner.busy,
    config,
    gateway: { running: gateway.running, port: gateway.currentPort, url: gateway.url },
    device: cached?.device ?? null,
    endpoint: { hostIp: collectHostIp(), gatewayPort: config.localPort },
    bootstrap: bootstrapState,
    policies: { count: cached?.policies.length ?? 0, cachedAt: cached?.cachedAt ?? null },
    catalog: { count: catalog.endpoints.length, source: catalog.source, endpoints: catalog.endpoints },
    edge: {
      mode: cached && cached.mode === "edge" ? "edge" : "relay",
      credentials: cached?.credentials.length ?? 0,
      meterPending: meter.pending(),
      mcp: cached?.mcp.length ?? 0,
      skills: cached?.skills.length ?? 0,
    },
    lastCheck: { at: lastCheckAt, total: results.length, reachable, unreachable: results.length - reachable },
    results,
    queue: { pending: cache.queueLength },
    update: updateInfo,
    license: licenseState,
    snapshotVerified,
    local: {
      credentials: local.listCredentials().length,
      mcp: local.listMcp().length,
      skills: local.listSkills().length,
    },
    meterTotals: meter.totalsNow(),
  };
}

// ---------------------------------------------------------------------------
// SSE broadcast (stands in for Electron's webContents.send)
// ---------------------------------------------------------------------------

interface SseClient { res: http.ServerResponse }
const sseClients = new Set<SseClient>();

function broadcast(type: "state" | "log", payload: unknown): void {
  const frame = `data: ${JSON.stringify({ type, payload })}\n\n`;
  for (const client of sseClients) {
    try {
      client.res.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

let pushTimer: NodeJS.Timeout | null = null;
function pushState(): void {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    broadcast("state", snapshot());
  }, 250);
}

// ---------------------------------------------------------------------------
// Control-plane orchestration (ported from the Electron host; UI-independent)
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<boolean> {
  const config = store.get();
  if (config.mode === "standalone") {
    bootstrapState = { status: "standalone", at: new Date().toISOString(), error: null };
    online = true;
    syncCapabilities(DATA_DIR, capabilitySource(), config, log);
    pushState();
    return true;
  }
  if (!config.deviceKey) {
    bootstrapState = { status: "none", at: new Date().toISOString(), error: "device_key_missing" };
    online = false;
    pushState();
    return false;
  }
  try {
    const res = await fetch(`${config.controlPlaneUrl}/api/agent/bootstrap`, {
      headers: { Authorization: `Bearer ${config.deviceKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; data?: Record<string, unknown>; error?: { message?: string } }
      | null;
    if (!res.ok || !json?.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
    const data = json.data as {
      device?: { id: string; name: string; tenantId: string };
      mode?: string;
      gatewayUrl?: string;
      policies?: unknown[];
      plan?: string;
      credentials?: unknown[];
      mcp?: unknown[];
      skills?: unknown[];
      publicAiCatalog?: unknown[];
      govPrompt?: string;
      apiKeyHashes?: { hash: string; agentId: string }[];
      snapshotVersion?: string;
      snapshotSignature?: string;
      license?: string;
      contentSafety?: unknown;
      limits?: unknown;
      aiGuard?: unknown;
    };
    cache.writeBootstrap({
      device: data.device ?? null,
      mode: data.mode === "edge" ? "edge" : "relay",
      gatewayUrl: typeof data.gatewayUrl === "string" ? data.gatewayUrl : "/api/gateway/v1",
      policies: Array.isArray(data.policies) ? (data.policies as never[]) : [],
      plan: typeof data.plan === "string" ? data.plan : "",
      credentials: Array.isArray(data.credentials) ? (data.credentials as never[]) : [],
      mcp: Array.isArray(data.mcp) ? (data.mcp as never[]) : [],
      skills: Array.isArray(data.skills) ? (data.skills as never[]) : [],
      catalog: Array.isArray(data.publicAiCatalog) ? (data.publicAiCatalog as never[]) : [],
      govPrompt: typeof data.govPrompt === "string" ? data.govPrompt : "",
      apiKeyHashes: Array.isArray(data.apiKeyHashes) ? data.apiKeyHashes : [],
      snapshotVersion: typeof data.snapshotVersion === "string" ? data.snapshotVersion : "",
      contentSafety: normalizeContentSafety(data.contentSafety),
      limits: normalizeLimits(data.limits),
      aiGuard: normalizeAiGuard(data.aiGuard),
    });
    bootstrapState = { status: "ok", at: new Date().toISOString(), error: null };
    online = true;
    syncCapabilities(DATA_DIR, capabilitySource(), store.get(), log);

    licenseState = null;
    snapshotVerified = false;
    const tenantId = data.device?.tenantId ?? "";
    if (typeof data.license === "string" && data.license) {
      const v = verifyLicense(data.license, DEFAULT_LICENSE_SECRET, tenantId);
      licenseState = { plan: v.payload?.plan ?? "", valid: v.valid, expiresAt: v.payload?.expiresAt ?? "", reason: v.reason ?? "" };
      if (!v.valid) log("warn", "bootstrap", `license verification failed: ${v.reason}`);
    }
    if (typeof data.snapshotSignature === "string" && data.snapshotVersion) {
      snapshotVerified = verifySnapshotSignature(tenantId, data.snapshotVersion, data.snapshotSignature);
      if (!snapshotVerified) log("warn", "bootstrap", "snapshot signature verification FAILED");
    }
    pushState();
    void runner.replayQueue();
    void meter.flush();
    void audit.flush();
    void checkForUpdates();
    void heartbeat();
    return true;
  } catch (err) {
    bootstrapState = { status: "error", at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) };
    online = false;
    log("warn", "bootstrap", `failed: ${bootstrapState.error}`);
    pushState();
    return false;
  }
}

async function heartbeat(): Promise<void> {
  const config = store.get();
  if (!config.deviceKey) return;
  const boot = cache.readBootstrap();
  try {
    const res = await fetch(`${config.controlPlaneUrl}/api/agent/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.deviceKey}` },
      body: JSON.stringify({
        hostIp: collectHostIp(),
        gatewayPort: config.localPort,
        mode: config.mode,
        snapshotVersion: boot?.snapshotVersion ?? "",
        agentVersion: VERSION,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: { snapshotVersion?: string } } | null;
    const remote = json?.data?.snapshotVersion;
    const localVersion = boot?.snapshotVersion;
    if (remote && localVersion && remote !== localVersion) void bootstrap();
  } catch {
    /* offline: next tick retries */
  }
}

async function activate(input: ActivationInput): Promise<ActivationResult> {
  const platformUrl = String(input.platformUrl ?? "").trim().replace(/\/+$/, "");
  const code = String(input.code ?? "").trim();
  const deviceName = String(input.deviceName ?? "").trim();
  if (!platformUrl || !code) return { ok: false, error: { code: "VALIDATION", message: "platformUrl and code are required" } };
  let res: Response;
  try {
    res = await fetch(`${platformUrl}/api/agent/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, deviceName }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, error: { code: "NETWORK_ERROR", message: err instanceof Error ? err.message : String(err) } };
  }
  const json = (await res.json().catch(() => null)) as
    | { ok?: boolean; data?: { deviceKey?: string; device?: ActivationResult["device"] }; error?: { code?: string; message?: string } }
    | null;
  if (!res.ok || !json?.ok || !json.data?.deviceKey) {
    return {
      ok: false,
      error: {
        code: json?.error?.code ?? (res.ok ? "ACTIVATION_FAILED" : `HTTP_${res.status}`),
        message: json?.error?.message ?? `Activation failed (HTTP ${res.status})`,
      },
    };
  }
  store.update({ controlPlaneUrl: platformUrl, deviceKey: json.data.deviceKey, mode: "connected" });
  log("info", "activation", `device activated on ${platformUrl}`);
  const device = json.data.device ?? { id: "", name: deviceName || "Aegis Gateway", status: "ACTIVE" };
  void bootstrap();
  return { ok: true, device };
}

async function checkForUpdates(): Promise<void> {
  const config = store.get();
  if (!config.controlPlaneUrl || config.mode === "standalone") return;
  try {
    const res = await fetch(`${config.controlPlaneUrl}/api/releases/latest`, { signal: AbortSignal.timeout(10_000) });
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; data?: { version?: string; downloadUrl?: string; notes?: string } }
      | null;
    if (!res.ok || !json?.ok || !json.data?.version) return;
    const latest = json.data.version;
    updateInfo = {
      currentVersion: VERSION,
      latestVersion: latest,
      downloadUrl: json.data.downloadUrl ?? "",
      notes: json.data.notes ?? "",
      checkedAt: new Date().toISOString(),
      updateAvailable: compareVersions(latest, VERSION) > 0,
    };
    pushState();
  } catch {
    /* offline: banner stays out */
  }
}

async function runCheck(): Promise<void> {
  try {
    await runner.runOnce();
  } catch (err) {
    log("error", "probe", `check failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    pushState();
  }
}

let probeTimer: NodeJS.Timeout | null = null;
function scheduleProbe(): void {
  if (probeTimer) clearInterval(probeTimer);
  const minutes = store.get().checkIntervalMinutes;
  probeTimer = setInterval(() => void runCheck(), minutes * 60_000);
  probeTimer.unref?.();
}

function scheduleQueueReplay(): void {
  if (replayTimer || replayAttempts >= 5) return;
  replayAttempts += 1;
  const delay = Math.min(15 * 60_000, 30_000 * replayAttempts);
  replayTimer = setTimeout(() => {
    replayTimer = null;
    void runner.replayQueue();
  }, delay);
  replayTimer.unref?.();
}

// ---------------------------------------------------------------------------
// REST API — parity with the Electron preload bridge
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage, limit = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
};

function serveStatic(res: http.ServerResponse, urlPath: string): void {
  let rel = urlPath === "/" || urlPath === "/index.html" ? "index-headless.html" : urlPath.slice(1);
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(path.normalize(PUBLIC_DIR))) {
    sendJson(res, 403, { ok: false, error: { code: "FORBIDDEN", message: "forbidden" } });
    return;
  }
  let file = full;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(PUBLIC_DIR, "index-headless.html"); // SPA fallback
  }
  try {
    const content = fs.readFileSync(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(content);
  } catch {
    sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `file not found: ${rel}` } });
  }
}

function localSnapshot() {
  return {
    credentials: local.listCredentials().map((c: LocalCredential) => ({ ...c, apiKeyEnc: c.apiKeyEnc ? "••••••••" : "" })),
    mcp: local.listMcp().map((m: LocalMcp) => ({ ...m, authTokenEnc: m.authTokenEnc ? "••••••••" : "" })),
    skills: local.listSkills(),
    prices: local.listPrices(),
    agents: local.listAgents().map(maskAgent),
  };
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const method = req.method ?? "GET";
  const p = url.pathname;

  if (p === "/api/events" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "state", payload: snapshot() })}\n\n`);
    const client = { res };
    sseClients.add(client);
    req.on("close", () => sseClients.delete(client));
    return true;
  }

  if (p === "/api/state" && method === "GET") {
    sendJson(res, 200, { ok: true, data: snapshot() });
    return true;
  }

  if (p === "/api/config" && method === "POST") {
    const body = JSON.parse(await readBody(req)) as Partial<AgentConfig>;
    const before = store.get();
    store.update(body);
    const after = store.get();
    log("info", "config", "configuration updated");
    if (after.localPort !== before.localPort || after.bindHost !== before.bindHost) {
      await gateway.start(after.localPort);
    }
    syncCapabilities(DATA_DIR, capabilitySource(), after, log);
    scheduleProbe();
    pushState();
    if (after.mode === "standalone") {
      bootstrapState = { status: "standalone", at: new Date().toISOString(), error: null };
      online = true;
      pushState();
    } else {
      void bootstrap();
    }
    sendJson(res, 200, { ok: true, data: snapshot() });
    return true;
  }

  if (p === "/api/run-check" && method === "POST") {
    void runCheck();
    sendJson(res, 200, { ok: true, data: { started: true } });
    return true;
  }

  if (p === "/api/refresh-bootstrap" && method === "POST") {
    void bootstrap();
    void checkForUpdates();
    sendJson(res, 200, { ok: true, data: { started: true } });
    return true;
  }

  if (p === "/api/activate" && method === "POST") {
    const input = JSON.parse(await readBody(req)) as ActivationInput;
    const result = await activate(input);
    sendJson(res, result.ok ? 200 : 400, result.ok ? { ok: true, data: result } : { ok: false, error: { code: result.error?.code ?? "ACTIVATION_FAILED", message: result.error?.message ?? "activation failed" } });
    return true;
  }

  if (p === "/api/open-external" && method === "POST") {
    sendJson(res, 200, { ok: true, data: true });
    return true;
  }

  if (p === "/api/local" && method === "GET") {
    sendJson(res, 200, { ok: true, data: localSnapshot() });
    return true;
  }

  const localMatch = p.match(/^\/api\/local\/(credentials|mcp|skills|prices|agents)(?:\/([0-9a-f-]+))?$/i);
  if (localMatch) {
    const kind = localMatch[1]!.toLowerCase();
    const id = localMatch[2];
    const body = method === "POST" ? JSON.parse(await readBody(req)) : null;
    if (method === "POST" && !id) {
      let out: unknown;
      if (kind === "credentials") out = local.saveCredential(body).map((c: LocalCredential) => ({ ...c, apiKeyEnc: c.apiKeyEnc ? "••••••••" : "" }));
      else if (kind === "mcp") out = local.saveMcp(body).map((m: LocalMcp) => ({ ...m, authTokenEnc: m.authTokenEnc ? "••••••••" : "" }));
      else if (kind === "skills") out = local.saveSkill(body);
      else if (kind === "prices") out = local.savePrice(body);
      else {
        const token = `ak_${randomBytes(24).toString("hex")}`;
        const rows = local.saveAgent({
          name: String(body?.name ?? "").trim() || "agent",
          type: String(body?.type ?? "SHARED"),
          models: Array.isArray(body?.models) ? body.models : [],
          keyPrefix: token.slice(0, 12),
          keyHash: createHash("sha256").update(token).digest("hex"),
        });
        gateway.clearMcpToolsCache();
        syncCapabilities(DATA_DIR, capabilitySource(), store.get(), log);
        pushState();
        sendJson(res, 200, { ok: true, data: { rows: rows.map(maskAgent), token } });
        return true;
      }
      gateway.clearMcpToolsCache();
      syncCapabilities(DATA_DIR, capabilitySource(), store.get(), log);
      pushState();
      sendJson(res, 200, { ok: true, data: out });
      return true;
    }
    if (method === "DELETE" && id) {
      let out: unknown;
      if (kind === "credentials") out = local.deleteCredential(id).map((c: LocalCredential) => ({ ...c, apiKeyEnc: c.apiKeyEnc ? "••••••••" : "" }));
      else if (kind === "mcp") out = local.deleteMcp(id).map((m: LocalMcp) => ({ ...m, authTokenEnc: m.authTokenEnc ? "••••••••" : "" }));
      else if (kind === "skills") out = local.deleteSkill(id);
      else if (kind === "prices") out = local.deletePrice(id);
      else out = local.deleteAgent(id).map(maskAgent);
      gateway.clearMcpToolsCache();
      syncCapabilities(DATA_DIR, capabilitySource(), store.get(), log);
      pushState();
      sendJson(res, 200, { ok: true, data: out });
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname.startsWith("/api/")) {
          const handled = await handleApi(req, res, url);
          if (!handled) sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `${req.method} ${url.pathname}` } });
          return;
        }
        if (req.method === "GET") {
          serveStatic(res, url.pathname);
          return;
        }
        sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `${req.method} ${url.pathname}` } });
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } });
        else res.end();
      }
    })();
  });

  await gateway.start(store.get().localPort);
  await new Promise<void>((resolve) => {
    server.listen(HTTP_PORT, () => resolve());
  });
  log("info", "server", `Aegis Gateway v${VERSION} listening: UI http://127.0.0.1:${HTTP_PORT} · gateway ${gateway.url} · data ${DATA_DIR}`);

  scheduleProbe();
  setInterval(() => void bootstrap(), BOOTSTRAP_INTERVAL_MS).unref();
  setInterval(() => {
    void meter.flush();
    void audit.flush();
  }, METER_FLUSH_MS).unref();
  setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS).unref();

  await bootstrap();
  void runCheck();
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
