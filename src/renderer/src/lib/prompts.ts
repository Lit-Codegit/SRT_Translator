import type { ApiChatMessage, Message, Preset } from '../types'
import { orderedPrompts } from './preset'

export function buildMessages(options: {
  preset: Preset | null
  customSystemPrompt: string
  instruction: string
  fileName?: string
  sourceText?: string
  existingMessages?: Message[]
}): ApiChatMessage[] {
  const messages: ApiChatMessage[] = []

  for (const prompt of orderedPrompts(options.preset)) {
    if (!prompt.enabled || !prompt.content?.trim()) continue
    messages.push({
      role: prompt.role,
      content: prompt.content
    })
  }

  // Custom system prompt always appended after preset prompts
  if (options.customSystemPrompt.trim()) {
    messages.push({
      role: 'system',
      content: options.customSystemPrompt.trim()
    })
  }

  // Include existing conversation history for multi-turn context
  if (options.existingMessages && options.existingMessages.length > 0) {
    for (const msg of options.existingMessages) {
      messages.push({ role: msg.role, content: msg.content })
    }
  }

  const fileBlock = options.sourceText
    ? `\n\n文件名：${options.fileName || '未命名文件'}\n\n待处理全文：\n${options.sourceText}`
    : ''

  messages.push({
    role: 'user',
    content: `${options.instruction.trim() || '请翻译以下内容，尽量保持原始格式。'}${fileBlock}`
  })

  return messages
}
