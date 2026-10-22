import fs from "node:fs";
import path from "node:path";
import { normalizeAiGuard, normalizeContentSafety, normalizeLimits, type AiGuardConfig, type ContentSafetyConfig, type TenantLimits } from "@aegis/shared";
import type {
  CachedPolicy,
  CatalogEndpoint,
  DeviceInfo,
  EdgeCredential,
  McpEntitlement,
  ReachResult,
  SkillEntitlement,
} from "./types";

export interface BootstrapCache {
  cachedAt: string; // ISO
  device: DeviceInfo | null;
  gatewayUrl: string;
  mode?: string; // "edge" when the tenant runs edge-direct
  policies: CachedPolicy[];
  /** Tenant plan pushed for offline conditions evaluation (tenant.plan). */
  plan?: string;
  credentials: EdgeCredential[];
  mcp: McpEntitlement[];
  skills: SkillEntitlement[];
  catalog: CatalogEndpoint[];
  govPrompt?: string; // governance system prompt injected into chat completions
  apiKeyHashes?: { hash: string; agentId: string }[]; // for offline LAN auth (hashes only)
  toolApprovals?: { tool: string; agentId: string }[]; // APPROVED, unexpired runtime tool grants
  snapshotVersion?: string; // control-plane content version at bootstrap time
  /** Tenant content-safety config (normalized; absent on old caches = disabled). */
  contentSafety?: ContentSafetyConfig;
  /** Tenant rate-limit / daily budget config (normalized; absent = unlimited). */
  limits?: TenantLimits;
  /** AI 决策式策略评估配置（normalized；旧缓存缺失 = 全关）。 */
  aiGuard?: AiGuardConfig;
}

export interface QueuedReport {
  attempts: number;
  enqueuedAt: string;
  report: { deviceKeyId: string; results: ReachResult[] };
}

function writeAtomic(file: string, payload: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** On-disk caches under userData: policy/bootstrap cache, latest results, report queue. */
export class Cache {
  private readonly policyFile: string;
  private readonly resultsFile: string;
  readonly queueDir: string;

  constructor(userData: string) {
    this.policyFile = path.join(userData, "policy-cache.json");
    this.resultsFile = path.join(userData, "reachability-results.json");
    this.queueDir = path.join(userData, "queue");
    fs.mkdirSync(this.queueDir, { recursive: true });
    this.resetQueueAttempts();
  }

  // ---- bootstrap / policy cache (userData/policy-cache.json) ----

  readBootstrap(): BootstrapCache | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.policyFile, "utf8")) as BootstrapCache;
      // Tolerate caches written by older agent versions.
      return {
        ...raw,
        credentials: Array.isArray(raw.credentials) ? raw.credentials : [],
        mcp: Array.isArray(raw.mcp) ? raw.mcp : [],
        skills: Array.isArray(raw.skills) ? raw.skills : [],
        policies: Array.isArray(raw.policies) ? raw.policies : [],
        catalog: Array.isArray(raw.catalog) ? raw.catalog : [],
        toolApprovals: Array.isArray(raw.toolApprovals) ? raw.toolApprovals : [],
        contentSafety: normalizeContentSafety(raw.contentSafety),
        limits: normalizeLimits(raw.limits),
        aiGuard: normalizeAiGuard(raw.aiGuard),
      };
    } catch {
      return null;
    }
  }

  writeBootstrap(cache: Omit<BootstrapCache, "cachedAt"> & { cachedAt?: string }): void {
    writeAtomic(this.policyFile, { ...cache, cachedAt: cache.cachedAt ?? new Date().toISOString() });
  }

  // ---- latest reachability results (userData/reachability-results.json) ----

  readResults(): ReachResult[] {
    try {
      return JSON.parse(fs.readFileSync(this.resultsFile, "utf8")) as ReachResult[];
    } catch {
      return [];
    }
  }

  writeResults(results: ReachResult[]): void {
    writeAtomic(this.resultsFile, results);
  }

  // ---- offline report queue (userData/queue/*.json) ----

  get queueLength(): number {
    try {
      return fs.readdirSync(this.queueDir).filter((f) => f.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }

  enqueueReport(report: QueuedReport["report"]): string {
    const name = `report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    writeAtomic(path.join(this.queueDir, name), {
      attempts: 0,
      enqueuedAt: new Date().toISOString(),
      report,
    } satisfies QueuedReport);
    return name;
  }

  listQueue(): { file: string; data: QueuedReport }[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.queueDir).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return [];
    }
    const out: { file: string; data: QueuedReport }[] = [];
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.queueDir, file), "utf8")) as QueuedReport;
        if (data && Array.isArray(data.report?.results)) out.push({ file, data });
      } catch {
        // drop unreadable queue files
        this.removeQueued(file);
      }
    }
    return out;
  }

  removeQueued(file: string): void {
    try {
      fs.rmSync(path.join(this.queueDir, path.basename(file)), { force: true });
    } catch {
      /* ignore */
    }
  }

  setAttempts(file: string, attempts: number): void {
    const full = path.join(this.queueDir, path.basename(file));
    try {
      const data = JSON.parse(fs.readFileSync(full, "utf8")) as QueuedReport;
      data.attempts = attempts;
      writeAtomic(full, data);
    } catch {
      /* ignore */
    }
  }

  /** Fresh attempt budget on every app start (PRD: keep after 5 failed attempts). */
  private resetQueueAttempts(): void {
    for (const item of this.listQueue()) {
      if (item.data.attempts !== 0) this.setAttempts(item.file, 0);
    }
  }
}
