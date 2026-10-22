import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mcpSlug } from "@aegis/shared";
import type { BootstrapCache } from "./cache";
import type { AgentConfig, LogFn, SkillEntitlement } from "./types";

// Materialization channel: mirrors the control-plane capability repo (skills
// and the aggregated MCP endpoint) into the standard load locations of native
// clients — Claude Code (~/.claude/skills, ~/.claude.json mcpServers), WorkBuddy
// (~/.workbuddy), plus the proxy's own canonical store under userData. Native
// clients load skills/MCPs with zero Aegis-specific code; the entitlements and
// audit stay on the gateway. Idempotent: writes only on content change, and
// only directories carrying an .aegis.json marker are pruned.

const MARKER = ".aegis.json";

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function skillDoc(skill: SkillEntitlement): string {
  const v = skill.activeVersion!;
  const desc = (skill.description || skill.name).replace(/\r?\n/g, " ").trim();
  return [
    "---",
    `name: ${mcpSlug(skill.name)}`,
    `description: ${desc}`,
    `version: ${v.version}`,
    `source: aegis:${skill.source.toLowerCase()}`,
    "---",
    "",
    v.content,
    "",
  ].join("\n");
}

function mirrorRoot(kind: "claude" | "workbuddy"): string {
  const home = os.homedir();
  return kind === "claude" ? path.join(home, ".claude", "skills") : path.join(home, ".workbuddy", "skills");
}

function upsertSkillDir(root: string, skill: SkillEntitlement, now: string, log: LogFn): void {
  const dir = path.join(root, mcpSlug(skill.name));
  const docFile = path.join(dir, "SKILL.md");
  const markerFile = path.join(dir, MARKER);
  const doc = skillDoc(skill);
  const marker = JSON.stringify(
    { id: skill.id, name: skill.name, version: skill.activeVersion!.version, updatedAt: now },
    null,
    2,
  );
  let current = "";
  try {
    current = fs.readFileSync(docFile, "utf8");
  } catch {
    /* new */
  }
  if (current !== doc) {
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(docFile, doc);
    writeAtomic(markerFile, marker);
    log("info", "sync", `skill materialized: ${docFile}`);
  }
}

/** Remove aegis-managed skill dirs whose skill is gone/disabled from the repo. */
function pruneSkillDir(root: string, validIds: Set<string>, log: LogFn): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let marker: { id?: string } | null = null;
    try {
      marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), "utf8")) as { id?: string };
    } catch {
      continue; // not aegis-managed; never touch
    }
    if (marker?.id && !validIds.has(marker.id)) {
      fs.rmSync(dir, { recursive: true, force: true });
      log("info", "sync", `stale skill removed: ${dir}`);
    }
  }
}

function syncSkillMirrors(userData: string, skills: SkillEntitlement[], config: AgentConfig, log: LogFn): void {
  const roots: string[] = [];
  if (config.materializeSkills) roots.push(path.join(userData, "skills"));
  if (config.materializeClaude) roots.push(mirrorRoot("claude"));
  if (config.materializeWorkBuddy) roots.push(mirrorRoot("workbuddy"));
  const now = new Date().toISOString();
  const validIds = new Set(skills.map((s) => s.id));
  for (const root of roots) {
    fs.mkdirSync(root, { recursive: true });
    for (const skill of skills) upsertSkillDir(root, skill, now, log);
    pruneSkillDir(root, validIds, log);
  }
}

function gatewayMcpUrl(config: AgentConfig): string {
  const host = config.bindHost === "0.0.0.0" ? "127.0.0.1" : config.bindHost;
  return `http://${host}:${config.localPort}/mcp`;
}

/** Merge (or, when enabled=false, best-effort remove) the `aegis` mcpServers entry. */
function mergeClaudeMcpJson(config: AgentConfig, enabled: boolean, log: LogFn): void {
  const file = path.join(os.homedir(), ".claude.json");
  let doc: Record<string, unknown> = {};
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    /* missing or unreadable -> start fresh */
  }
  const servers = (doc.mcpServers && typeof doc.mcpServers === "object" ? doc.mcpServers : {}) as Record<
    string,
    unknown
  >;
  const url = gatewayMcpUrl(config);
  const existing = servers.aegis as { url?: string } | undefined;
  if (enabled) {
    if (existing?.url === url) return;
    servers.aegis = { type: "http", url };
    doc.mcpServers = servers;
    writeAtomic(file, JSON.stringify(doc, null, 2));
    log("info", "sync", `claude mcpServers.aegis -> ${url}`);
    return;
  }
  if (existing?.url === url) {
    delete servers.aegis;
    doc.mcpServers = servers;
    writeAtomic(file, JSON.stringify(doc, null, 2));
    log("info", "sync", "claude mcpServers.aegis removed (materialization disabled)");
  }
}

function mergeWorkBuddyMcpJson(config: AgentConfig, enabled: boolean, log: LogFn): void {
  const dir = path.join(os.homedir(), ".workbuddy");
  const file = path.join(dir, "mcp.json");
  let doc: Record<string, unknown> = {};
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    /* missing -> start fresh */
  }
  const servers = (doc.mcpServers && typeof doc.mcpServers === "object" ? doc.mcpServers : {}) as Record<
    string,
    unknown
  >;
  const url = gatewayMcpUrl(config);
  const existing = servers.aegis as { url?: string } | undefined;
  if (enabled) {
    if (existing?.url === url) return;
    servers.aegis = { url };
    doc.mcpServers = servers;
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(file, JSON.stringify(doc, null, 2));
    log("info", "sync", `workbuddy mcp.json aegis -> ${url}`);
    return;
  }
  if (existing?.url === url) {
    delete servers.aegis;
    doc.mcpServers = servers;
    writeAtomic(file, JSON.stringify(doc, null, 2));
    log("info", "sync", "workbuddy mcp.json aegis removed (materialization disabled)");
  }
}

export function syncCapabilities(
  userData: string,
  cached: BootstrapCache | null,
  config: AgentConfig,
  log: LogFn,
): void {
  if (!cached) return;
  const skills = (cached.skills ?? []).filter((s) => s.activeVersion);
  try {
    syncSkillMirrors(userData, skills, config, log);
  } catch (err) {
    log("warn", "sync", `skill materialization failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    mergeClaudeMcpJson(config, config.materializeClaude, log);
    mergeWorkBuddyMcpJson(config, config.materializeWorkBuddy, log);
  } catch (err) {
    log("warn", "sync", `mcp config materialization failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
