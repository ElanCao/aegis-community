import type { ActivationInput, ActivationResult, AgentConfig, LogEntry, StateSnapshot } from "../electron/types";

export interface LocalCredentialRow {
  id: string;
  provider: string;
  label: string;
  baseUrl: string;
  models: string[];
  apiKeyEnc: string;
  createdAt: string;
}

export interface LocalMcpRow {
  id: string;
  name: string;
  endpoint: string;
  transport: string;
  riskLevel: string;
  authType: string;
  authTokenEnc: string;
  allowedAgentIds: string[];
  createdAt: string;
}

export interface LocalSkillRow {
  id: string;
  name: string;
  description: string;
  version: string;
  format: string;
  content: string;
  updatedAt: string;
}

export interface LocalSnapshot {
  credentials: LocalCredentialRow[];
  mcp: LocalMcpRow[];
  skills: LocalSkillRow[];
  prices: LocalPriceRow[];
  agents: LocalAgentRow[];
}

export interface LocalAgentRow {
  id: string;
  name: string;
  type: string;
  keyPrefix: string;
  keyHash: string;
  models: string[];
  createdAt: string;
}

export interface LocalPriceRow {
  id: string;
  model: string;
  inputPrice: number;
  outputPrice: number;
  cacheHitPrice: number | null;
}

export interface AegisBridge {
  getState(): Promise<StateSnapshot>;
  saveConfig(patch: Partial<AgentConfig>): Promise<StateSnapshot>;
  runCheckNow(): Promise<void>;
  refreshBootstrap(): Promise<void>;
  activate(input: ActivationInput): Promise<ActivationResult>;
  openExternal(url: string): Promise<boolean>;
  getLocal(): Promise<LocalSnapshot>;
  saveLocalCredential(input: Record<string, unknown>): Promise<LocalCredentialRow[]>;
  deleteLocalCredential(id: string): Promise<LocalCredentialRow[]>;
  saveLocalMcp(input: Record<string, unknown>): Promise<LocalMcpRow[]>;
  deleteLocalMcp(id: string): Promise<LocalMcpRow[]>;
  saveLocalSkill(input: Record<string, unknown>): Promise<LocalSkillRow[]>;
  deleteLocalSkill(id: string): Promise<LocalSkillRow[]>;
  saveLocalPrice(input: Record<string, unknown>): Promise<LocalPriceRow[]>;
  deleteLocalPrice(id: string): Promise<LocalPriceRow[]>;
  saveLocalAgent(input: Record<string, unknown>): Promise<{ rows: LocalAgentRow[]; token: string }>;
  deleteLocalAgent(id: string): Promise<LocalAgentRow[]>;
  onState(cb: (state: StateSnapshot) => void): () => void;
  onLog(cb: (entry: LogEntry) => void): () => void;
}

declare global {
  interface Window {
    aegis: AegisBridge;
  }
}
