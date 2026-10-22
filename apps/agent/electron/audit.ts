import fs from "node:fs";
import path from "node:path";
import type { ConfigStore } from "./store";
import type { EdgeAuditEvent, LogFn } from "./types";

const MAX_BATCH = 500;
const FLUSH_THROTTLE_MS = 10_000;
/** Standalone / never-paired proxies keep a bounded local trail only. */
const MAX_RETAINED = 5000;

export interface AuditDeps {
  store: ConfigStore;
  log: LogFn;
  onChange: () => void;
}

/**
 * Per-call governance audit queue for edge-direct traffic. Mirrors
 * MeterBuffer's disk-queue + batch-upload pattern (userData/audit-queue.json
 * -> POST /api/agent/audit): the control plane is idempotent on
 * (tenant, device, eventId), network failures leave events on disk for the
 * next flush, and events carry metadata only — no message bodies or secrets.
 *
 * Unlike metering, standalone mode still records: a SaaS-less proxy has no
 * control plane to drain to unless a device key happens to be configured
 * (activated earlier), in which case uploads continue and are tagged
 * deviceMode=standalone server-side. Without a key the queue simply caps at
 * MAX_RETAINED as a local trail.
 */
export class AuditBuffer {
  private readonly file: string;
  private events: EdgeAuditEvent[] = [];
  private readonly seen = new Set<string>();
  private flushing = false;
  private lastAttempt = 0;

  constructor(userData: string, private readonly deps: AuditDeps) {
    this.file = path.join(userData, "audit-queue.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as EdgeAuditEvent[];
      if (Array.isArray(parsed)) {
        this.events = parsed.filter((e) => e && typeof e.eventId === "string" && typeof e.type === "string");
      }
    } catch {
      this.events = [];
    }
    if (this.events.length > MAX_RETAINED) this.events = this.events.slice(-MAX_RETAINED);
    for (const e of this.events) this.seen.add(e.eventId);
  }

  pending(): number {
    return this.events.length;
  }

  enqueue(event: EdgeAuditEvent): void {
    if (this.seen.has(event.eventId)) return;
    this.seen.add(event.eventId);
    this.events.push(event);
    if (this.events.length > MAX_RETAINED) {
      const dropped = this.events.splice(0, this.events.length - MAX_RETAINED);
      for (const d of dropped) this.seen.delete(d.eventId);
    }
    this.persist();
    this.deps.log("info", "audit", `${event.type} outcome=${event.outcome} model=${event.model || "-"} agent=${event.agentId || "-"}`);
    this.deps.onChange();
    void this.flush();
  }

  /** Upload buffered events in batches of 500. Returns true when the buffer drained. */
  async flush(force = false): Promise<boolean> {
    if (this.flushing) return false;
    if (this.events.length === 0) return true;
    if (!force && Date.now() - this.lastAttempt < FLUSH_THROTTLE_MS) return false;
    const config = this.deps.store.get();
    // No device key (standalone, never activated): nothing to drain to —
    // events stay on disk as the bounded local trail.
    if (!config.deviceKey) return false;

    this.flushing = true;
    try {
      for (;;) {
        const batch = this.events.slice(0, MAX_BATCH);
        if (batch.length === 0) break;
        let res: Response;
        try {
          res = await fetch(`${config.controlPlaneUrl}/api/agent/audit`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.deviceKey}`,
            },
            body: JSON.stringify({ deviceMode: config.mode, events: batch }),
            signal: AbortSignal.timeout(15_000),
          });
        } catch (err) {
          this.lastAttempt = Date.now();
          this.deps.log("warn", "audit", `audit upload failed: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
        if (!res.ok) {
          this.lastAttempt = Date.now();
          this.deps.log("warn", "audit", `audit upload rejected: HTTP ${res.status}`);
          return false;
        }
        this.events.splice(0, batch.length);
        this.persist();
        this.deps.onChange();
        this.deps.log("info", "audit", `synced ${batch.length} audit event(s) to control plane`);
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
