import https from "node:https";
import { PUBLIC_AI_CATALOG } from "@aegis/shared";
import type { Cache, QueuedReport } from "./cache";
import type { ConfigStore } from "./store";
import type { CatalogEndpoint, LogFn, ReachResult } from "./types";

const USER_AGENT = "aegis-local-agent/0.1";
const TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 5;

export interface ReachabilityDeps {
  store: ConfigStore;
  cache: Cache;
  log: LogFn;
  deviceId: () => string;
  onResults: (results: ReachResult[]) => void;
  onQueueChange: () => void;
  onSyncFailure: () => void; // scheduler hook: retry with exponential backoff
  onSyncSuccess: () => void;
}

function probeDomain(
  domain: string
): Promise<{ ok: true; statusCode: number; latencyMs: number } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.request(
      {
        host: domain,
        method: "HEAD",
        path: "/",
        timeout: TIMEOUT_MS,
        headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      },
      (res) => {
        res.resume();
        resolve({ ok: true, statusCode: res.statusCode ?? 0, latencyMs: Date.now() - started });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err: Error) => {
      resolve({ ok: false, error: err.message === "timeout" ? "timeout" : err.message });
    });
    req.end();
  });
}

/**
 * Public-AI reachability prober. Probes every domain of every catalog endpoint
 * (any domain reachable => endpoint reachable), keeps the latest results on
 * disk and syncs batches to the control plane through an offline queue with
 * bounded retries and replay.
 */
export class ReachabilityRunner {
  busy = false;

  constructor(private readonly deps: ReachabilityDeps) {}

  /** Control-plane catalog when bootstrapped; built-in shared catalog as pre-bootstrap fallback. */
  catalog(): { endpoints: CatalogEndpoint[]; source: "bootstrap" | "builtin" } {
    const cached = this.deps.cache.readBootstrap();
    if (cached && cached.catalog.length > 0) {
      return { endpoints: cached.catalog, source: "bootstrap" };
    }
    return {
      endpoints: PUBLIC_AI_CATALOG.map((e) => ({
        id: `key:${e.key}`,
        key: e.key,
        name: e.name,
        category: e.category,
        vendor: e.vendor,
        domains: e.domains,
        langs: e.langs,
      })),
      source: "builtin",
    };
  }

  async runOnce(): Promise<ReachResult[]> {
    if (this.busy) return this.deps.cache.readResults();
    this.busy = true;
    try {
      const { endpoints } = this.catalog();
      this.deps.log("info", "probe", `checking ${endpoints.length} public AI endpoints...`);
      const results: ReachResult[] = [];
      let index = 0;
      const workerCount = Math.min(6, endpoints.length);
      const workers = Array.from({ length: workerCount }, async () => {
        for (;;) {
          const endpoint = endpoints[index];
          index += 1;
          if (!endpoint) break;
          results.push(await this.probeEndpoint(endpoint));
        }
      });
      await Promise.all(workers);
      results.sort((a, b) => a.endpointId.localeCompare(b.endpointId));
      this.deps.cache.writeResults(results);
      const reachable = results.filter((r) => r.reachable).length;
      this.deps.log("info", "probe", `check finished: ${reachable}/${results.length} reachable`);
      this.deps.onResults(results);
      await this.report(results);
      return results;
    } finally {
      this.busy = false;
    }
  }

  private async probeEndpoint(endpoint: CatalogEndpoint): Promise<ReachResult> {
    const checkedAt = new Date().toISOString();
    const details: string[] = [];
    let firstOk: { statusCode: number; latencyMs: number } | null = null;
    for (const domain of endpoint.domains) {
      const result = await probeDomain(domain);
      if (result.ok) {
        details.push(`${domain} -> ${result.statusCode} (${result.latencyMs}ms)`);
        if (!firstOk) firstOk = { statusCode: result.statusCode, latencyMs: result.latencyMs };
      } else {
        details.push(`${domain} -> ${result.error}`);
      }
    }
    if (firstOk) {
      return {
        endpointId: endpoint.id,
        reachable: true,
        statusCode: firstOk.statusCode,
        latencyMs: firstOk.latencyMs,
        checkedAt,
        detail: details.join("; "),
      };
    }
    return { endpointId: endpoint.id, reachable: false, checkedAt, detail: details.join("; ") };
  }

  /** Only results keyed by control-plane endpoint ids are reported. */
  private reportable(results: ReachResult[]): ReachResult[] {
    return results.filter((r) => !r.endpointId.startsWith("key:"));
  }

  private async report(results: ReachResult[]): Promise<void> {
    const config = this.deps.store.get();
    const reportable = this.reportable(results);
    if (!config.deviceKey || reportable.length === 0) {
      if (!config.deviceKey && reportable.length === 0) {
        this.deps.log("info", "sync", "no device key yet; results kept locally only");
      }
      this.deps.onQueueChange();
      return;
    }
    const ok = await this.postReport({ deviceKeyId: this.deps.deviceId(), results: reportable });
    if (ok) {
      this.deps.log("info", "sync", `reported ${reportable.length} results to control plane`);
      this.deps.onSyncSuccess();
      await this.replayQueue();
    } else {
      this.deps.cache.enqueueReport({ deviceKeyId: this.deps.deviceId(), results: reportable });
      this.deps.log("warn", "sync", `report failed; queued (${this.deps.cache.queueLength} pending)`);
      this.deps.onSyncFailure();
    }
    this.deps.onQueueChange();
  }

  /** Replay queued reports in order; stop at the first failure. Returns true when the queue drained. */
  async replayQueue(): Promise<boolean> {
    const config = this.deps.store.get();
    if (!config.deviceKey) return false;
    for (const item of this.deps.cache.listQueue()) {
      const ok = await this.postReport(item.data.report);
      if (ok) {
        this.deps.cache.removeQueued(item.file);
        this.deps.log("info", "sync", `replayed queued report (${item.data.report.results.length} results)`);
      } else {
        const attempts = item.data.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          this.deps.log("error", "sync", `queued report reached ${MAX_ATTEMPTS} attempts; kept for next start`);
        } else {
          this.deps.cache.setAttempts(item.file, attempts);
          this.deps.log("warn", "sync", `queued report retry failed (${attempts}/${MAX_ATTEMPTS})`);
        }
        this.deps.onQueueChange();
        return false;
      }
      this.deps.onQueueChange();
    }
    return true;
  }

  private async postReport(report: QueuedReport["report"]): Promise<boolean> {
    const config = this.deps.store.get();
    try {
      const res = await fetch(`${config.controlPlaneUrl}/api/agent/reachability`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.deviceKey}`,
        },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(15_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
