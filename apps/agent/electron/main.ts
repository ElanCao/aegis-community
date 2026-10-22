import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { Cache } from "./cache";
import type { BootstrapCache } from "./cache";
import { GatewayServer } from "./gateway";
import { initLocalKey } from "./crypto";
import { LocalStores } from "./localstore";
import { AuditBuffer } from "./audit";
import { MeterBuffer } from "./metering";
import { syncCapabilities } from "./materialize";
import { ReachabilityRunner } from "./reachability";
import { DEFAULT_LICENSE_SECRET, normalizeAiGuard, normalizeContentSafety, normalizeLimits, verifyLicense, verifySnapshotSignature } from "@aegis/shared";
import { ConfigStore } from "./store";
import { IPC } from "./types";
import type { ActivationInput, ActivationResult, AgentConfig, BootstrapState, LogEntry, StateSnapshot, UpdateInfo } from "./types";

declare const AEGIS_AGENT_VERSION: string;
const VERSION = typeof AEGIS_AGENT_VERSION !== "undefined" ? AEGIS_AGENT_VERSION : "0.1.0";
const BOOTSTRAP_INTERVAL_MS = 24 * 60 * 60 * 1000; // refresh policy cache daily
const METER_FLUSH_MS = 60_000; // periodic usage sync
const HEARTBEAT_INTERVAL_MS = 60_000; // report liveness + endpoint address

let win: BrowserWindow | null = null;
let store: ConfigStore;
let cache: Cache;
let local: LocalStores;
let gateway: GatewayServer;
let runner: ReachabilityRunner;
let meter: MeterBuffer;
let audit: AuditBuffer;

let probeTimer: NodeJS.Timeout | null = null;
let bootstrapTimer: NodeJS.Timeout | null = null;
let pushTimer: NodeJS.Timeout | null = null;
let replayTimer: NodeJS.Timeout | null = null;
let meterTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let replayAttempts = 0;

let bootstrapState: BootstrapState = { status: "none", at: null, error: null };
let lastCheckAt: string | null = null;
let online = false;
let updateInfo: UpdateInfo | null = null;
let userDataDir = "";

// ---------------------------------------------------------------------------
// Logging + state push
// ---------------------------------------------------------------------------

const logBuffer: LogEntry[] = [];

function log(level: LogEntry["level"], kind: string, message: string): void {
  const entry: LogEntry = { ts: Date.now(), level, kind, message };
  logBuffer.push(entry);
  if (logBuffer.length > 500) logBuffer.shift();
  const line = `[${new Date(entry.ts).toISOString()}] [${kind}] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  win?.webContents.send(IPC.pushLog, entry);
}

function deviceId(): string {
  return cache.readBootstrap()?.device?.id ?? "";
}

function snapshot(): StateSnapshot {
  const config = store.get();
  const cached = cache.readBootstrap();
  const results = cache.readResults();
  const catalog = runner.catalog();
  const reachable = results.filter((r) => r.reachable).length;
  return {
    version: VERSION,
    online,
    checking: runner.busy,
    config,
    gateway: { running: gateway.running, port: gateway.currentPort, url: gateway.url },
    device: cached?.device ?? null,
    endpoint: { hostIp: collectHostIp(), gatewayPort: store.get().localPort },
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
    lastCheck: {
      at: lastCheckAt,
      total: results.length,
      reachable,
      unreachable: results.length - reachable,
    },
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

let licenseState: StateSnapshot["license"] = null;
let snapshotVerified = false;

function pushState(): void {
  if (!win) return;
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    win?.webContents.send(IPC.pushState, snapshot());
  }, 250);
}

// ---------------------------------------------------------------------------
// Control plane bootstrap
// ---------------------------------------------------------------------------

// Item 20: compare dotted version strings ("v1.2.3" tolerated); pre-release
// suffixes compare lower than the same release number.
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

// Public release channel (GET /api/releases/latest, no auth). Best-effort:
// any failure keeps the client fully usable and just leaves the banner out.
async function checkForUpdates(): Promise<void> {
  const config = store.get();
  if (!config.controlPlaneUrl || config.mode === "standalone") return;
  try {
    const res = await fetch(`${config.controlPlaneUrl}/api/releases/latest`, {
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; data?: { version?: string; downloadUrl?: string; notes?: string } }
      | null;
    if (!res.ok || !json?.ok || !json.data?.version) return;
    const latest = json.data.version;
    const available = compareVersions(latest, VERSION) > 0;
    updateInfo = {
      currentVersion: VERSION,
      latestVersion: latest,
      downloadUrl: json.data.downloadUrl ?? "",
      notes: json.data.notes ?? "",
      checkedAt: new Date().toISOString(),
      updateAvailable: available,
    };
    if (available) log("info", "update", `new version available: ${latest} (current ${VERSION})`);
  } catch {
    /* offline / endpoint missing — stay silent, client remains usable */
  }
}

// Item 19: the activation string IS the credential. The main process posts it
// to the public activate endpoint; on success the device key + platform URL
// are persisted locally and normal bootstrap takes over from there.
async function activate(input: ActivationInput): Promise<ActivationResult> {
  const platformUrl = String(input.platformUrl ?? "")
    .trim()
    .replace(/\/+$/, "");
  const code = String(input.code ?? "").trim();
  const deviceName = String(input.deviceName ?? "").trim();
  if (!platformUrl || !code) {
    return { ok: false, error: { code: "VALIDATION", message: "platformUrl and code are required" } };
  }
  let res: Response;
  try {
    res = await fetch(`${platformUrl}/api/agent/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, deviceName }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return {
      ok: false,
      error: { code: "NETWORK_ERROR", message: err instanceof Error ? err.message : String(err) },
    };
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
  log("info", "activation", `device activated: ${json.data.device?.name ?? "?"} on ${platformUrl}`);
  const device = json.data.device ?? { id: "", name: deviceName || "Aegis Client", status: "ACTIVE" };
  await bootstrap();
  void checkForUpdates();
  return { ok: true, device };
}

function collectHostIp(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "";
}

// Best-effort liveness + endpoint reporting; failures never affect local function.
// Also the change-propagation channel: when the control plane reports a newer
// snapshotVersion than our cached bootstrap, re-bootstrap to pick up policy /
// key / credential / governance-prompt changes.
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
    const local = boot?.snapshotVersion;
    if (remote && local && remote !== local) void bootstrap();
  } catch {
    /* offline: next tick retries */
  }
}

// Materialization source: in standalone mode the local stores are the entire
// capability repo; in connected mode the bootstrap cache (local entries still
// win at merge time in the gateway).
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

async function bootstrap(): Promise<boolean> {
  const config = store.get();
  if (config.mode === "standalone") {
    // SaaS-less on-premise: the proxy runs entirely from local stores.
    bootstrapState = { status: "standalone", at: new Date().toISOString(), error: null };
    online = true;
    syncCapabilities(userDataDir, capabilitySource(), config, log);
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
      | { ok?: boolean; data?: unknown; error?: { message?: string } }
      | null;
    if (!res.ok || !json?.ok) {
      throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
    }
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
    syncCapabilities(userDataDir, cache.readBootstrap(), store.get(), log);

    // Commercial layer (QA.MD): verify the license token and the signed policy
    // snapshot fully offline. Fail-open by design — a data plane must stay
    // autonomous when it cannot verify (last known-good cache keeps working).
    licenseState = null;
    snapshotVerified = false;
    const tenantId = data.device?.tenantId ?? "";
    if (typeof data.license === "string" && data.license) {
      const v = verifyLicense(data.license, DEFAULT_LICENSE_SECRET, tenantId);
      licenseState = {
        plan: v.payload?.plan ?? "",
        valid: v.valid,
        expiresAt: v.payload?.expiresAt ?? "",
        reason: v.reason ?? "",
      };
      if (!v.valid) log("warn", "bootstrap", `license verification failed: ${v.reason}`);
    }
    if (typeof data.snapshotSignature === "string" && data.snapshotVersion) {
      snapshotVerified = verifySnapshotSignature(tenantId, data.snapshotVersion, data.snapshotSignature);
      if (!snapshotVerified) log("warn", "bootstrap", "snapshot signature verification FAILED — treating cache as unverified");
    }
    log(
      "info",
      "bootstrap",
      `ok: device=${data.device?.name ?? "?"} tenant=${data.device?.tenantId ?? "?"} mode=${data.mode === "edge" ? "edge" : "relay"} policies=${data.policies?.length ?? 0} credentials=${data.credentials?.length ?? 0} mcp=${data.mcp?.length ?? 0} skills=${data.skills?.length ?? 0} catalog=${data.publicAiCatalog?.length ?? 0}`
    );
    pushState();
    void runner.replayQueue();
    void meter.flush();
    void audit.flush();
    void checkForUpdates();
    void heartbeat();
    return true;
  } catch (err) {
    bootstrapState = {
      status: "error",
      at: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
    online = false;
    log("warn", "bootstrap", `failed: ${bootstrapState.error}`);
    pushState();
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

async function runCheck(): Promise<void> {
  try {
    await runner.runOnce();
  } catch (err) {
    log("error", "probe", `check failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    pushState();
  }
}

function scheduleProbe(): void {
  if (probeTimer) clearInterval(probeTimer);
  const minutes = store.get().checkIntervalMinutes;
  probeTimer = setInterval(() => void runCheck(), minutes * 60_000);
  probeTimer.unref?.();
  log("info", "config", `check interval set to ${minutes} minute(s)`);
}

/** Exponential backoff for queue replay: 30s, 60s, ... capped at 15 min, max 5 attempts. */
function scheduleQueueReplay(): void {
  if (replayTimer) return;
  replayAttempts += 1;
  if (replayAttempts > 5) {
    log("warn", "sync", "queue replay paused (max attempts); will retry after next app start");
    return;
  }
  const delay = Math.min(30_000 * 2 ** (replayAttempts - 1), 15 * 60_000);
  log("info", "sync", `next queue replay in ${Math.round(delay / 1000)}s (attempt ${replayAttempts}/5)`);
  replayTimer = setTimeout(() => {
    replayTimer = null;
    void runner.replayQueue().then((drained) => {
      if (drained) replayAttempts = 0;
      else scheduleQueueReplay();
    });
  }, delay);
  replayTimer.unref?.();
}

async function startGateway(): Promise<void> {
  const port = store.get().localPort;
  try {
    await gateway.start(port);
  } catch (err) {
    log("error", "gateway", `port ${port} unavailable (${err instanceof Error ? err.message : String(err)})`);
    try {
      await gateway.start(port + 1);
      log("warn", "gateway", `falling back to port ${port + 1}`);
    } catch (err2) {
      log("error", "gateway", `failed to start: ${err2 instanceof Error ? err2.message : String(err2)}`);
    }
  }
  pushState();
}

// ---------------------------------------------------------------------------
// Window + IPC
// ---------------------------------------------------------------------------

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0e1116",
    title: "Aegis Local Agent",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on("closed", () => {
    win = null;
  });
  const devServer = process.env.VITE_DEV_SERVER_URL ?? (process.argv.includes("--dev") ? "http://localhost:5173" : "");
  if (devServer) {
    void win.loadURL(devServer);
  } else {
    void win.loadFile(path.join(__dirname, "renderer", "index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.getState, () => snapshot());

  ipcMain.handle(IPC.saveConfig, (_event, patch: Partial<AgentConfig>) => {
    const before = store.get();
    store.update(patch);
    const after = store.get();
    log("info", "config", "configuration updated");
    if (after.localPort !== before.localPort || after.bindHost !== before.bindHost) {
      void startGateway();
    }
    // Materialization toggles apply immediately against the cached bootstrap,
    // even when the control plane is unreachable right now.
    syncCapabilities(userDataDir, capabilitySource(), after, log);
    scheduleProbe();
    pushState();
    if (after.mode === "standalone") {
      bootstrapState = { status: "standalone", at: new Date().toISOString(), error: null };
      online = true;
      pushState();
    } else {
      void bootstrap();
    }
    return snapshot();
  });

  ipcMain.handle(IPC.runCheck, () => {
    void runCheck();
  });

  ipcMain.handle(IPC.refreshBootstrap, () => {
    void bootstrap();
    void checkForUpdates();
  });

  ipcMain.handle(IPC.activate, (_event, input: ActivationInput) => activate(input));

  ipcMain.handle(IPC.openExternal, (_event, url: string) => {
    const target = String(url ?? "").trim();
    if (/^https?:\/\//i.test(target)) return shell.openExternal(target);
    return Promise.resolve(false);
  });

  // Local capability stores (standalone source of truth; merged when connected).
  ipcMain.handle(IPC.getLocal, () => ({
    credentials: local.listCredentials().map((c) => ({ ...c, apiKeyEnc: c.apiKeyEnc ? "••••••••" : "" })),
    mcp: local.listMcp().map((m) => ({ ...m, authTokenEnc: m.authTokenEnc ? "••••••••" : "" })),
    skills: local.listSkills(),
    prices: local.listPrices(),
    agents: local.listAgents().map(maskAgent),
  }));

  ipcMain.handle(IPC.saveLocalCredential, (_event, input) => {
    const rows = local.saveCredential(input);
    gateway.clearMcpToolsCache();
    syncCapabilities(userDataDir, capabilitySource(), store.get(), log);
    pushState();
    return rows.map((c) => ({ ...c, apiKeyEnc: c.apiKeyEnc ? "••••••••" : "" }));
  });

  ipcMain.handle(IPC.deleteLocalCredential, (_event, id: string) => {
    const rows = local.deleteCredential(id);
    gateway.clearMcpToolsCache();
    syncCapabilities(userDataDir, capabilitySource(), store.get(), log);
    pushState();
    return rows.map((c) => ({ ...c, apiKeyEnc: c.apiKeyEnc ? "••••••••" : "" }));
  });

  ipcMain.handle(IPC.saveLocalMcp, (_event, input) => {
    const rows = local.saveMcp(input);
    gateway.clearMcpToolsCache();
    syncCapabilities(userDataDir, capabilitySource(), store.get(), log);
    pushState();
    return rows.map((m) => ({ ...m, authTokenEnc: m.authTokenEnc ? "••••••••" : "" }));
  });

  ipcMain.handle(IPC.deleteLocalMcp, (_event, id: string) => {
    const rows = local.deleteMcp(id);
    gateway.clearMcpToolsCache();
    syncCapabilities(userDataDir, capabilitySource(), store.get(), log);
    pushState();
    return rows.map((m) => ({ ...m, authTokenEnc: m.authTokenEnc ? "••••••••" : "" }));
  });

  ipcMain.handle(IPC.saveLocalSkill, (_event, input) => {
    const rows = local.saveSkill(input);
    gateway.clearMcpToolsCache();
    syncCapabilities(userDataDir, capabilitySource(), store.get(), log);
    pushState();
    return rows;
  });

  ipcMain.handle(IPC.deleteLocalSkill, (_event, id: string) => {
    const rows = local.deleteSkill(id);
    gateway.clearMcpToolsCache();
    syncCapabilities(userDataDir, capabilitySource(), store.get(), log);
    pushState();
    return rows;
  });

  ipcMain.handle(IPC.saveLocalPrice, (_event, input) => {
    const rows = local.savePrice(input);
    pushState();
    return rows;
  });

  ipcMain.handle(IPC.deleteLocalPrice, (_event, id: string) => {
    const rows = local.deletePrice(id);
    pushState();
    return rows;
  });

  // Community-edition local agent registry: issue ak_ tokens that authenticate
  // offline against this proxy (LAN callers), no SaaS required.
  ipcMain.handle(IPC.saveLocalAgent, (_event, input: { name: string; type: string; models: string[] }) => {
    const token = `ak_${randomBytes(24).toString("hex")}`;
    const rows = local.saveAgent({
      name: String(input.name ?? "").trim() || "agent",
      type: String(input.type ?? "SHARED"),
      models: Array.isArray(input.models) ? input.models : [],
      keyPrefix: token.slice(0, 12),
      keyHash: createHash("sha256").update(token).digest("hex"),
    });
    gateway.clearMcpToolsCache();
    pushState();
    return { rows: rows.map(maskAgent), token };
  });

  ipcMain.handle(IPC.deleteLocalAgent, (_event, id: string) => {
    const rows = local.deleteAgent(id);
    gateway.clearMcpToolsCache();
    pushState();
    return rows.map(maskAgent);
  });
}

function maskAgent<T extends { keyHash: string }>(a: T): T {
  return { ...a, keyHash: a.keyHash ? "••••••••" : "" };
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    const userData = app.getPath("userData");
    userDataDir = userData;
    initLocalKey(userData);
    store = new ConfigStore(userData);
    cache = new Cache(userData);
    local = new LocalStores(userData);
    meter = new MeterBuffer(userData, { store, log, onChange: pushState });
    audit = new AuditBuffer(userData, { store, log, onChange: pushState });
    gateway = new GatewayServer({ store, cache, local, meter, audit, log, deviceId, emitState: pushState });
    runner = new ReachabilityRunner({
      store,
      cache,
      log,
      deviceId,
      onResults: () => {
        lastCheckAt = new Date().toISOString();
        pushState();
      },
      onQueueChange: pushState,
      onSyncFailure: scheduleQueueReplay,
      onSyncSuccess: () => {
        replayAttempts = 0;
      },
    });

    registerIpc();
    await startGateway();
    scheduleProbe();
    bootstrapTimer = setInterval(() => void bootstrap(), BOOTSTRAP_INTERVAL_MS);
    bootstrapTimer.unref?.();
    meterTimer = setInterval(() => {
      void meter.flush();
      void audit.flush();
    }, METER_FLUSH_MS);
    meterTimer.unref?.();
    heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();

    createWindow();

    log("info", "bootstrap", `starting up (userData=${userData})`);
    await bootstrap();
    void runCheck();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
