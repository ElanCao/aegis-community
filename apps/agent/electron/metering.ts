import fs from "node:fs";
import path from "node:path";
import type { ConfigStore } from "./store";
import type { LogFn, MeterEvent } from "./types";

const MAX_BATCH = 500;
const FLUSH_THROTTLE_MS = 10_000;

export interface MeteringDeps {
  store: ConfigStore;
  log: LogFn;
  onChange: () => void;
}

export interface MeterTotals {
  events: number;
  promptTokens: number;
  completionTokens: number;
  totalCost: number;
}

/**
 * Local usage meter for edge-direct model calls. Events are buffered on disk
 * (userData/usage-queue.json) and batch-uploaded to POST /api/agent/usage;
 * the control plane is idempotent on (tenant, device, eventId) so retries are
 * safe. Cost is computed locally from the local price table (bundled DeepSeek
 * defaults) so standalone proxies can bill without SaaS; in connected mode the
 * billing recompute route can still flag drift against server price versions.
 *
 * Standalone mode never queues: events fold into lifetime billing totals
 * (userData/usage-totals.json) because there is no control plane to drain to.
 */
export class MeterBuffer {
  private readonly file: string;
  private readonly totalsFile: string;
  private events: MeterEvent[] = [];
  private readonly seen = new Set<string>();
  private flushing = false;
  private lastAttempt = 0;
  private totals: MeterTotals = { events: 0, promptTokens: 0, completionTokens: 0, totalCost: 0 };

  constructor(userData: string, private readonly deps: MeteringDeps) {
    this.file = path.join(userData, "usage-queue.json");
    this.totalsFile = path.join(userData, "usage-totals.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(this.totalsFile, "utf8")) as MeterTotals;
      if (parsed && typeof parsed.events === "number") this.totals = parsed;
    } catch {
      /* first run */
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as MeterEvent[];
      if (Array.isArray(parsed)) {
        this.events = parsed.filter((e) => e && typeof e.eventId === "string");
      }
    } catch {
      this.events = [];
    }
    for (const e of this.events) this.seen.add(e.eventId);
  }

  /** Lifetime billing totals (standalone mode; session view when connected). */
  totalsNow(): MeterTotals {
    return { ...this.totals };
  }

  private persistTotals(): void {
    try {
      const tmp = `${this.totalsFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.totals, null, 2), "utf8");
      fs.renameSync(tmp, this.totalsFile);
    } catch {
      /* best effort */
    }
  }

  pending(): number {
    return this.events.length;
  }

  enqueue(event: MeterEvent): void {
    // Standalone mode: nothing is ever uploaded, so queueing would grow
    // without bound — fold events straight into local billing totals instead.
    if (this.deps.store.get().mode === "standalone") {
      this.totals.events += 1;
      this.totals.promptTokens += event.promptTokens;
      this.totals.completionTokens += event.completionTokens;
      this.totals.totalCost += event.cost;
      this.persistTotals();
      this.deps.log(
        "info",
        "meter",
        `metered ${event.provider}/${event.model} tokens=${event.totalTokens} cost=${event.cost.toFixed(6)} trace=${event.traceId}`
      );
      this.deps.onChange();
      return;
    }
    if (this.seen.has(event.eventId)) return;
    this.seen.add(event.eventId);
    this.events.push(event);
    this.persist();
    this.deps.log(
      "info",
      "meter",
      `metered ${event.provider}/${event.model} tokens=${event.totalTokens} status=${event.status} trace=${event.traceId}`
    );
    this.deps.onChange();
    void this.flush();
  }

  /** Upload buffered events in batches of 500. Returns true when the buffer drained. */
  async flush(force = false): Promise<boolean> {
    if (this.flushing) return false;
    if (this.events.length === 0) return true;
    if (!force && Date.now() - this.lastAttempt < FLUSH_THROTTLE_MS) return false;
    const config = this.deps.store.get();
    if (!config.deviceKey) return false;

    this.flushing = true;
    try {
      for (;;) {
        const batch = this.events.slice(0, MAX_BATCH);
        if (batch.length === 0) break;
        let res: Response;
        try {
          res = await fetch(`${config.controlPlaneUrl}/api/agent/usage`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.deviceKey}`,
            },
            body: JSON.stringify({ events: batch }),
            signal: AbortSignal.timeout(15_000),
          });
        } catch (err) {
          this.lastAttempt = Date.now();
          this.deps.log("warn", "meter", `usage upload failed: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
        if (!res.ok) {
          this.lastAttempt = Date.now();
          this.deps.log("warn", "meter", `usage upload rejected: HTTP ${res.status}`);
          return false;
        }
        this.events.splice(0, batch.length);
        this.persist();
        this.deps.onChange();
        this.deps.log("info", "meter", `synced ${batch.length} usage event(s) to control plane`);
      }
      return true;
    } finally {
      this.flushing = false;
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.events, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }
}
