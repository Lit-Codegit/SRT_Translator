import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { ApiConfig, GenerationRequest, SaveOutputRequest, StoredFile } from '../main/types'

type GenerationStatus = {
  requestId: string
  sessionId: string
  status: 'queued' | 'connecting' | 'streaming'
}

type GenerationChunk = {
  requestId: string
  sessionId: string
  content: string
  reasoning: string
}

type GenerationDone = {
  requestId: string
  sessionId: string
}

type GenerationError = {
  requestId: string
  sessionId: string
  error: string
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  getConfig: (): Promise<ApiConfig> => ipcRenderer.invoke('config:get'),
  saveConfig: (config: ApiConfig): Promise<ApiConfig> => ipcRenderer.invoke('config:save', config),
  testApi: (config: ApiConfig): Promise<{ ok: boolean; message: string; latencyMs: number }> =>
    ipcRenderer.invoke('config:test', config),
  listModels: (config: ApiConfig): Promise<{ ok: boolean; models: string[]; message: string }> =>
    ipcRenderer.invoke('config:listModels', config),
  getPaths: (): Promise<{ configPath: string; historyPath: string; defaultOutputDir: string }> =>
    ipcRenderer.invoke('config:paths'),
  selectOutputDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:select-output-dir'),
  selectFiles: (): Promise<StoredFile[]> => ipcRenderer.invoke('files:select'),
  selectPreset: (): Promise<StoredFile | null> => ipcRenderer.invoke('preset:select'),
  saveOutput: (request: SaveOutputRequest): Promise<string> => ipcRenderer.invoke('output:save', request),
  getHistory: (): Promise<unknown> => ipcRenderer.invoke('history:get'),
  saveHistory: (history: unknown): Promise<boolean> => ipcRenderer.invoke('history:save', history),
  exportHistory: (history: unknown): Promise<string | null> => ipcRenderer.invoke('history:export', history),
  importHistory: (): Promise<unknown> => ipcRenderer.invoke('history:import'),
  startGeneration: (request: GenerationRequest): Promise<boolean> => ipcRenderer.invoke('generation:start', request),
  cancelGeneration: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('generation:cancel', sessionId),
  onGenerationStatus: (callback: (payload: GenerationStatus) => void): (() => void) =>
    subscribe('generation:status', callback),
  onGenerationChunk: (callback: (payload: GenerationChunk) => void): (() => void) =>
    subscribe('generation:chunk', callback),
  onGenerationDone: (callback: (payload: GenerationDone) => void): (() => void) =>
    subscribe('generation:done', callback),
  onGenerationError: (callback: (payload: GenerationError) => void): (() => void) =>
    subscribe('generation:error', callback)
}

contextBridge.exposeInMainWorld('translator', api)

export type TranslatorApi = typeof api
