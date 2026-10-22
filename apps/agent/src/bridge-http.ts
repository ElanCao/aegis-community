// Headless bridge: provides the same `window.aegis` surface the Electron
// preload exposes, backed by same-origin REST + SSE against the embedded
// server (apps/server). Loaded before main.tsx by index-headless.html.

import type { AegisBridge } from "./api";
import type { ActivationInput, StateSnapshot, LogEntry, AgentConfig } from "../electron/types";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: T; error?: { message?: string } } | null;
  if (!res.ok || !json?.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
  return json.data as T;
}

type StateCb = (state: StateSnapshot) => void;
type LogCb = (entry: LogEntry) => void;
let source: EventSource | null = null;
let stateListeners: StateCb[] = [];
let logListeners: LogCb[] = [];

function ensureEvents(): void {
  if (source) return;
  source = new EventSource("/api/events");
  source.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as { type: "state" | "log"; payload: never };
      if (msg.type === "state") stateListeners.forEach((cb) => cb(msg.payload as StateSnapshot));
      else logListeners.forEach((cb) => cb(msg.payload as LogEntry));
    } catch {
      /* malformed event; ignore */
    }
  };
  source.onerror = () => {
    // EventSource auto-reconnects; nothing to do.
  };
}

const bridge: AegisBridge = {
  getState: () => req<StateSnapshot>("/api/state"),
  saveConfig: (patch: Partial<AgentConfig>) =>
    req<StateSnapshot>("/api/config", { method: "POST", body: JSON.stringify(patch) }),
  runCheckNow: () => req<void>("/api/run-check", { method: "POST", body: "{}" }),
  refreshBootstrap: () => req<void>("/api/refresh-bootstrap", { method: "POST", body: "{}" }),
  activate: (input: ActivationInput) => req("/api/activate", { method: "POST", body: JSON.stringify(input) }),
  openExternal: async (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  },
  getLocal: () => req("/api/local"),
  saveLocalCredential: (input) => req("/api/local/credentials", { method: "POST", body: JSON.stringify(input) }),
  deleteLocalCredential: (id) => req(`/api/local/credentials/${id}`, { method: "DELETE" }),
  saveLocalMcp: (input) => req("/api/local/mcp", { method: "POST", body: JSON.stringify(input) }),
  deleteLocalMcp: (id) => req(`/api/local/mcp/${id}`, { method: "DELETE" }),
  saveLocalSkill: (input) => req("/api/local/skills", { method: "POST", body: JSON.stringify(input) }),
  deleteLocalSkill: (id) => req(`/api/local/skills/${id}`, { method: "DELETE" }),
  saveLocalPrice: (input) => req("/api/local/prices", { method: "POST", body: JSON.stringify(input) }),
  deleteLocalPrice: (id) => req(`/api/local/prices/${id}`, { method: "DELETE" }),
  saveLocalAgent: (input) => req("/api/local/agents", { method: "POST", body: JSON.stringify(input) }),
  deleteLocalAgent: (id) => req(`/api/local/agents/${id}`, { method: "DELETE" }),
  onState: (cb: StateCb) => {
    ensureEvents();
    stateListeners.push(cb);
    return () => {
      stateListeners = stateListeners.filter((l) => l !== cb);
    };
  },
  onLog: (cb: LogCb) => {
    ensureEvents();
    logListeners.push(cb);
    return () => {
      logListeners = logListeners.filter((l) => l !== cb);
    };
  },
};

window.aegis = bridge;
