import type { ApiConfig, ChatMessage as ApiChatMessage, StoredFile } from '../../main/types'

export type { ApiConfig, ApiChatMessage, StoredFile }

export type PromptItem = {
  identifier: string
  name: string
  enabled: boolean
  role: 'system' | 'user' | 'assistant'
  content?: string
  system_prompt?: boolean
  marker?: boolean
}

export type Preset = {
  name: string
  prompts: PromptItem[]
  order: Array<{ identifier: string; enabled: boolean }>
  parameters: {
    temperature?: number
    maxTokens?: number
    topP?: number
  }
}

export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  createdAt: number
  fileName?: string
  requestId?: string
  validation?: SrtValidationResult
}

export type SessionStatus =
  | 'idle'
  | 'queued'
  | 'connecting'
  | 'streaming'
  | 'validating'
  | 'downloading'
  | 'done'
  | 'error'

export type GroupMode = 'conversation' | 'autoSrt'

export type GroupSettings = {
  mode: GroupMode
  model?: string
  concurrency?: number
  outputDir?: string
  systemPrompt?: string
}

export type ChatSession = {
  id: string
  groupId: string
  title: string
  fileName?: string
  sourceText?: string
  instruction: string
  messages: Message[]
  status: SessionStatus
  error?: string
  createdAt: number
  updatedAt: number
}

export type SessionGroup = {
  id: string
  title: string
  createdAt: number
  sessionIds: string[]
  expanded: boolean
  settings?: GroupSettings
}

export type HistoryState = {
  groups: SessionGroup[]
  sessions: Record<string, ChatSession>
  activeSessionId?: string
}

export type SrtValidationResult = {
  checkedAt: number
  ok: boolean
  summary: string
  errors: string[]
  warnings: string[]
}

export type ImportedFile = StoredFile
