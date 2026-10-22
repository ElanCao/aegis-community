import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_AI_GUARD,
  DEFAULT_CONTENT_SAFETY,
  DEFAULT_LIMITS,
  normalizeAiGuard,
  normalizeContentSafety,
  normalizeLimits,
} from "@aegis/shared";
import type { AgentConfig } from "./types";

const DEFAULTS: AgentConfig = {
  controlPlaneUrl: "http://localhost:3000",
  deviceKey: "",
  gatewayApiKey: "",
  localPort: 8931,
  bindHost: "127.0.0.1",
  locale: "zh",
  checkIntervalMinutes: 15,
  mode: "connected",
  materializeSkills: true,
  materializeClaude: false,
  materializeWorkBuddy: false,
  contentSafety: DEFAULT_CONTENT_SAFETY,
  limits: DEFAULT_LIMITS,
  aiGuard: DEFAULT_AI_GUARD,
};

/** JSON config persisted at userData/config.json (no electron-store dependency). */
function normalizeBindHost(value: unknown): string {
  const s = String(value ?? "").trim();
  if (!s) return "127.0.0.1";
  // allow IPv4 / IPv6 / hostnames; "0.0.0.0" = all interfaces (central mode)
  if (/^[0-9a-fA-F.:_-]+$/.test(s) && s.length <= 64) return s;
  return "127.0.0.1";
}

export class ConfigStore {
  private readonly file: string;
  private config: AgentConfig;

  constructor(userData: string) {
    this.file = path.join(userData, "config.json");
    this.config = this.load();
  }

  private load(): AgentConfig {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      return this.normalize({ ...DEFAULTS, ...(JSON.parse(raw) as Partial<AgentConfig>) });
    } catch {
      return { ...DEFAULTS };
    }
  }

  private normalize(input: Partial<AgentConfig>): AgentConfig {
    const port = Number(input.localPort);
    const minutes = Number(input.checkIntervalMinutes);
    return {
      controlPlaneUrl: String(input.controlPlaneUrl ?? "")
        .trim()
        .replace(/\/+$/, ""),
      deviceKey: String(input.deviceKey ?? "").trim(),
      gatewayApiKey: String(input.gatewayApiKey ?? "").trim(),
      localPort:
        Number.isFinite(port) && port >= 1024 && port <= 65535
          ? Math.floor(port)
          : DEFAULTS.localPort,
      bindHost: normalizeBindHost(input.bindHost),
      locale: input.locale === "en" ? "en" : "zh",
      checkIntervalMinutes:
        Number.isFinite(minutes) && minutes >= 1 && minutes <= 24 * 60
          ? Math.floor(minutes)
          : DEFAULTS.checkIntervalMinutes,
      materializeSkills: input.materializeSkills !== false,
      materializeClaude: input.materializeClaude === true,
      materializeWorkBuddy: input.materializeWorkBuddy === true,
      mode: input.mode === "standalone" ? "standalone" : "connected",
      contentSafety: normalizeContentSafety(input.contentSafety),
      limits: normalizeLimits(input.limits),
      aiGuard: normalizeAiGuard(input.aiGuard),
    };
  }

  get(): AgentConfig {
    return { ...this.config };
  }

  update(patch: Partial<AgentConfig>): AgentConfig {
    this.config = this.normalize({ ...this.config, ...patch });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
    return this.get();
  }
}
