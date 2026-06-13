export type ApiConfig = {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  rpm: number
  concurrency: number
  outputDir: string
  modelsQueryPath: string
  modelsCache: Record<string, string[]>
  defaultGroupMode: 'conversation' | 'autoSrt'
  autoValidationRetryCount: number
  customSystemPrompt: string
  preset: unknown
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type GenerationRequest = {
  requestId: string
  sessionId: string
  groupId: string
  config: ApiConfig
  messages: ChatMessage[]
}

export type StoredFile = {
  name: string
  path: string
  content: string
}

export type SaveOutputRequest = {
  fileName: string
  content: string
  extension: string
  outputDir?: string
}
