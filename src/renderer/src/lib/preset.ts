import type { Preset, PromptItem } from '../types'

type RawPreset = {
  prompts?: Array<Partial<PromptItem>>
  prompt_order?: Array<{ order?: Array<{ identifier: string; enabled: boolean }> }>
  temperature?: number
  openai_max_tokens?: number
  top_p?: number
}

function normalizeRole(role: unknown): 'system' | 'user' | 'assistant' {
  return role === 'assistant' || role === 'user' || role === 'system' ? role : 'system'
}

export function parsePreset(rawJson: string, name = '导入预设'): Preset {
  const raw = JSON.parse(rawJson) as RawPreset
  const order = raw.prompt_order?.[0]?.order ?? []

  const prompts = (raw.prompts ?? []).map((prompt, index) => ({
    identifier: String(prompt.identifier || `prompt_${index + 1}`),
    name: String(prompt.name || prompt.identifier || `Prompt ${index + 1}`),
    enabled: Boolean(prompt.enabled),
    role: normalizeRole(prompt.role),
    content: prompt.content ?? '',
    system_prompt: Boolean(prompt.system_prompt),
    marker: Boolean(prompt.marker)
  }))

  return {
    name,
    prompts,
    order,
    parameters: {
      temperature: raw.temperature,
      maxTokens: raw.openai_max_tokens,
      topP: raw.top_p
    }
  }
}

export function orderedPrompts(preset: Preset | null): PromptItem[] {
  if (!preset) return []

  const byId = new Map(preset.prompts.map((prompt) => [prompt.identifier, prompt]))
  const ordered = preset.order
    .map((entry) => byId.get(entry.identifier))
    .filter((prompt): prompt is PromptItem => Boolean(prompt))
  const orderedIds = new Set(ordered.map((prompt) => prompt.identifier))
  const rest = preset.prompts.filter((prompt) => !orderedIds.has(prompt.identifier))
  return [...ordered, ...rest]
}
