import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { encryptSecret } from "./crypto";

// Local capability stores — the standalone (SaaS-less) source of truth for
// model credentials, MCP servers and Skills. In connected mode these merge
// with the control-plane entitlement views pushed at bootstrap, with local
// entries winning on name collision. Secrets (provider keys, MCP upstream
// tokens) are AES-256-GCM sealed with the machine-local key; only encrypted
// payloads ever touch disk.

export interface LocalCredential {
  id: string;
  provider: string;
  label: string;
  baseUrl: string;
  models: string[]; // empty => any model
  apiKeyEnc: string;
  createdAt: string;
}

export interface LocalMcp {
  id: string;
  name: string;
  endpoint: string;
  transport: string; // STREAMABLE_HTTP (aggregated) | STDIO (documented, not aggregated)
  riskLevel: string;
  authType: string; // NONE | API_KEY
  authTokenEnc: string; // "" unless API_KEY
  allowedAgentIds: string[]; // empty => every caller
  createdAt: string;
}

export interface LocalSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  format: string; // MARKDOWN | CODE
  content: string;
  updatedAt: string;
}

// Local price table (CNY per 1M tokens) — the standalone billing source.
// Mirrors the control plane's PriceVersion shape so costs computed on the
// proxy match what the SaaS would compute for the same calls.
export interface LocalPrice {
  id: string;
  model: string;
  inputPrice: number;
  outputPrice: number;
  cacheHitPrice: number | null;
}

// Community-edition local agent registry: identities the proxy issues ak_
// tokens for on its own, so central-mode remote callers authenticate offline
// against the enterprise proxy alone (no SaaS required).
export interface LocalAgent {
  id: string;
  name: string;
  type: string; // SHARED | USER_SIDE | CLOUD | OTHER
  keyPrefix: string; // ak_xxxx… (identification only)
  keyHash: string; // sha256 of the full token
  models: string[]; // allowed models (empty = unrestricted)
  createdAt: string;
}

function writeAtomic(file: string, payload: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export class LocalStores {
  private readonly dir: string;
  private readonly credFile: string;
  private readonly mcpFile: string;
  private readonly skillFile: string;
  private readonly priceFile: string;

  constructor(userData: string) {
    this.dir = path.join(userData, "local");
    this.credFile = path.join(this.dir, "credentials.json");
    this.mcpFile = path.join(this.dir, "mcp.json");
    this.skillFile = path.join(this.dir, "skills.json");
    this.priceFile = path.join(this.dir, "prices.json");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  // ---- model credentials -------------------------------------------------

  listCredentials(): LocalCredential[] {
    const rows = readJson<LocalCredential[]>(this.credFile, []);
    return Array.isArray(rows) ? rows : [];
  }

  saveCredential(input: Omit<LocalCredential, "id" | "createdAt" | "apiKeyEnc"> & { apiKey?: string; id?: string }): LocalCredential[] {
    const rows = this.listCredentials();
    const existing = input.id ? rows.find((r) => r.id === input.id) : undefined;
    const row: LocalCredential = {
      id: existing?.id ?? randomUUID(),
      provider: input.provider,
      label: input.label,
      baseUrl: input.baseUrl.replace(/\/+$/, ""),
      models: input.models,
      apiKeyEnc: input.apiKey ? encryptSecret(input.apiKey) : (existing?.apiKeyEnc ?? ""),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    const next = existing ? rows.map((r) => (r.id === row.id ? row : r)) : [...rows, row];
    writeAtomic(this.credFile, next);
    return next;
  }

  deleteCredential(id: string): LocalCredential[] {
    const next = this.listCredentials().filter((r) => r.id !== id);
    writeAtomic(this.credFile, next);
    return next;
  }

  // ---- MCP registry --------------------------------------------------------

  listMcp(): LocalMcp[] {
    const rows = readJson<LocalMcp[]>(this.mcpFile, []);
    return Array.isArray(rows) ? rows : [];
  }

  saveMcp(input: Omit<LocalMcp, "id" | "createdAt" | "authTokenEnc"> & { authToken?: string; id?: string }): LocalMcp[] {
    const rows = this.listMcp();
    const existing = input.id ? rows.find((r) => r.id === input.id) : undefined;
    const row: LocalMcp = {
      id: existing?.id ?? randomUUID(),
      name: input.name,
      endpoint: input.endpoint,
      transport: input.transport,
      riskLevel: input.riskLevel,
      authType: input.authType,
      authTokenEnc: input.authToken ? encryptSecret(input.authToken) : (existing?.authTokenEnc ?? ""),
      allowedAgentIds: input.allowedAgentIds,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    const next = existing ? rows.map((r) => (r.id === row.id ? row : r)) : [...rows, row];
    writeAtomic(this.mcpFile, next);
    return next;
  }

  deleteMcp(id: string): LocalMcp[] {
    const next = this.listMcp().filter((r) => r.id !== id);
    writeAtomic(this.mcpFile, next);
    return next;
  }

  // ---- Skill repository ----------------------------------------------------

  listSkills(): LocalSkill[] {
    const rows = readJson<LocalSkill[]>(this.skillFile, []);
    return Array.isArray(rows) ? rows : [];
  }

  saveSkill(input: Omit<LocalSkill, "id" | "updatedAt"> & { id?: string }): LocalSkill[] {
    const rows = this.listSkills();
    const existing = input.id ? rows.find((r) => r.id === input.id) : undefined;
    const row: LocalSkill = {
      id: existing?.id ?? randomUUID(),
      name: input.name,
      description: input.description,
      version: input.version,
      format: input.format,
      content: input.content,
      updatedAt: new Date().toISOString(),
    };
    const next = existing ? rows.map((r) => (r.id === row.id ? row : r)) : [...rows, row];
    writeAtomic(this.skillFile, next);
    return next;
  }

  deleteSkill(id: string): LocalSkill[] {
    const next = this.listSkills().filter((r) => r.id !== id);
    writeAtomic(this.skillFile, next);
    return next;
  }

  // ---- local price table (standalone billing) ------------------------------

  listPrices(): LocalPrice[] {
    const rows = readJson<LocalPrice[]>(this.priceFile, []);
    return Array.isArray(rows) ? rows : [];
  }

  savePrice(input: { id?: string; model: string; inputPrice: number; outputPrice: number; cacheHitPrice?: number | null }): LocalPrice[] {
    const rows = this.listPrices();
    const existing = input.id ? rows.find((r) => r.id === input.id) : undefined;
    const row: LocalPrice = {
      id: existing?.id ?? randomUUID(),
      model: input.model.trim(),
      inputPrice: Number(input.inputPrice) || 0,
      outputPrice: Number(input.outputPrice) || 0,
      cacheHitPrice: input.cacheHitPrice === undefined ? (existing?.cacheHitPrice ?? null) : input.cacheHitPrice,
    };
    const next = existing ? rows.map((r) => (r.id === row.id ? row : r)) : [...rows, row];
    writeAtomic(this.priceFile, next);
    return next;
  }

  deletePrice(id: string): LocalPrice[] {
    const next = this.listPrices().filter((r) => r.id !== id);
    writeAtomic(this.priceFile, next);
    return next;
  }

  // ---- local agent registry (community-edition identity) -------------------

  listAgents(): LocalAgent[] {
    const rows = readJson<LocalAgent[]>(path.join(this.dir, "agents.json"), []);
    return Array.isArray(rows) ? rows : [];
  }

  saveAgent(input: { name: string; type: string; models: string[]; keyPrefix: string; keyHash: string }): LocalAgent[] {
    const file = path.join(this.dir, "agents.json");
    const rows = this.listAgents();
    const row: LocalAgent = {
      id: randomUUID(),
      name: input.name,
      type: input.type,
      keyPrefix: input.keyPrefix,
      keyHash: input.keyHash,
      models: input.models,
      createdAt: new Date().toISOString(),
    };
    const next = [...rows, row];
    writeAtomic(file, next);
    return next;
  }

  deleteAgent(id: string): LocalAgent[] {
    const file = path.join(this.dir, "agents.json");
    const next = this.listAgents().filter((r) => r.id !== id);
    writeAtomic(file, next);
    return next;
  }
}
