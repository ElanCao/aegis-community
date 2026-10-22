import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "./types";
import type { ActivationInput, ActivationResult, AgentConfig, LogEntry, StateSnapshot } from "./types";

const api = {
  getState: (): Promise<StateSnapshot> => ipcRenderer.invoke(IPC.getState),

  saveConfig: (patch: Partial<AgentConfig>): Promise<StateSnapshot> =>
    ipcRenderer.invoke(IPC.saveConfig, patch),

  runCheckNow: (): Promise<void> => ipcRenderer.invoke(IPC.runCheck),

  refreshBootstrap: (): Promise<void> => ipcRenderer.invoke(IPC.refreshBootstrap),

  activate: (input: ActivationInput): Promise<ActivationResult> => ipcRenderer.invoke(IPC.activate, input),

  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke(IPC.openExternal, url),

  getLocal: (): Promise<unknown> => ipcRenderer.invoke(IPC.getLocal),

  saveLocalCredential: (input: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.saveLocalCredential, input),

  deleteLocalCredential: (id: string): Promise<unknown> => ipcRenderer.invoke(IPC.deleteLocalCredential, id),

  saveLocalMcp: (input: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.saveLocalMcp, input),

  deleteLocalMcp: (id: string): Promise<unknown> => ipcRenderer.invoke(IPC.deleteLocalMcp, id),

  saveLocalSkill: (input: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.saveLocalSkill, input),

  deleteLocalSkill: (id: string): Promise<unknown> => ipcRenderer.invoke(IPC.deleteLocalSkill, id),

  saveLocalPrice: (input: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.saveLocalPrice, input),

  deleteLocalPrice: (id: string): Promise<unknown> => ipcRenderer.invoke(IPC.deleteLocalPrice, id),

  saveLocalAgent: (input: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.saveLocalAgent, input),

  deleteLocalAgent: (id: string): Promise<unknown> => ipcRenderer.invoke(IPC.deleteLocalAgent, id),

  onState: (cb: (state: StateSnapshot) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: StateSnapshot) => cb(state);
    ipcRenderer.on(IPC.pushState, listener);
    return () => ipcRenderer.removeListener(IPC.pushState, listener);
  },

  onLog: (cb: (entry: LogEntry) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: LogEntry) => cb(entry);
    ipcRenderer.on(IPC.pushLog, listener);
    return () => ipcRenderer.removeListener(IPC.pushLog, listener);
  },
};

export type AegisApi = typeof api;

contextBridge.exposeInMainWorld("aegis", api);
