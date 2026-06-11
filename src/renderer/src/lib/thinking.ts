export type ParsedThinking = {
  thinking: string
  body: string
  hasThinkTag: boolean
  thinkClosed: boolean
}

export function parseThinking(content: string): ParsedThinking {
  const openMatch = /<think>/i.exec(content)
  if (!openMatch) {
    return { thinking: '', body: content, hasThinkTag: false, thinkClosed: false }
  }

  const before = content.slice(0, openMatch.index)
  const thinkingStart = openMatch.index + openMatch[0].length
  const afterOpen = content.slice(thinkingStart)
  const closeMatch = /<\/think>\s*/i.exec(afterOpen)

  if (!closeMatch) {
    return {
      thinking: afterOpen.trim(),
      body: before,
      hasThinkTag: true,
      thinkClosed: false
    }
  }

  return {
    thinking: afterOpen.slice(0, closeMatch.index).trim(),
    body: before + afterOpen.slice(closeMatch.index + closeMatch[0].length),
    hasThinkTag: true,
    thinkClosed: true
  }
}
