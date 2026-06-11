import type { ApiConfig, ChatMessage } from './types'

function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

function modelsUrl(baseUrl: string, queryPath: string): string {
  const path = queryPath.replace(/^\/+/, '')
  return `${baseUrl.replace(/\/+$/, '')}/${path}`
}

function requestHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  }
}

export async function testApi(config: ApiConfig): Promise<{ ok: boolean; message: string; latencyMs: number }> {
  const started = Date.now()
  if (!config.apiKey.trim()) {
    return { ok: false, message: 'API Key 为空', latencyMs: 0 }
  }
  if (!config.model.trim()) {
    return { ok: false, message: 'Model 为空', latencyMs: 0 }
  }

  try {
    const response = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: 'POST',
      headers: requestHeaders(config.apiKey),
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 8,
        temperature: 0,
        stream: false
      })
    })

    const latencyMs = Date.now() - started
    if (!response.ok) {
      const text = await response.text()
      return { ok: false, message: text.slice(0, 300) || response.statusText, latencyMs }
    }

    return { ok: true, message: 'API 可用', latencyMs }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '未知错误',
      latencyMs: Date.now() - started
    }
  }
}

export async function listModels(config: ApiConfig): Promise<{ ok: boolean; models: string[]; message: string }> {
  if (!config.apiKey.trim()) {
    return { ok: false, models: [], message: 'API Key 为空' }
  }

  try {
    const response = await fetch(modelsUrl(config.baseUrl, config.modelsQueryPath), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiKey}`
      }
    })

    if (!response.ok) {
      const text = await response.text()
      return { ok: false, models: [], message: text.slice(0, 300) || response.statusText }
    }

    const payload = (await response.json()) as { data?: Array<{ id: string }> }
    const models = (payload.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .sort((a, b) => a.localeCompare(b))

    if (models.length === 0) {
      return { ok: false, models: [], message: '未找到模型' }
    }

    return { ok: true, models, message: `找到 ${models.length} 个模型` }
  } catch (error) {
    return {
      ok: false,
      models: [],
      message: error instanceof Error ? error.message : '未知错误'
    }
  }
}

export type StreamChunk = { content: string; reasoning: string }

export async function streamChatCompletion(
  config: ApiConfig,
  messages: ChatMessage[],
  onChunk: (chunk: StreamChunk) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(chatCompletionsUrl(config.baseUrl), {
    method: 'POST',
    headers: requestHeaders(config.apiKey),
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: Number(config.temperature),
      max_tokens: Number(config.maxTokens),
      stream: true
    }),
    signal
  })

  if (!response.ok || !response.body) {
    const text = await response.text()
    throw new Error(text.slice(0, 600) || response.statusText)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue

      const payload = trimmed.replace(/^data:\s*/, '')
      if (payload === '[DONE]') return

      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; text?: string }>
        }
        const delta = parsed.choices?.[0]?.delta
        const content = delta?.content ?? parsed.choices?.[0]?.text ?? ''
        const reasoning = delta?.reasoning_content ?? ''
        if (content || reasoning) onChunk({ content, reasoning })
      } catch {
        // Some compatible providers send keep-alive payloads that are not JSON.
      }
    }
  }
}
