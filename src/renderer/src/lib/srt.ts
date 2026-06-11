import type { SrtValidationResult } from '../types'

const timecodePattern = /^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}(?:\s+.*)?$/

export function validateSrt(content: string, originalContent?: string): SrtValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const normalized = content.replace(/\r\n/g, '\n').trim()

  if (!normalized) {
    errors.push('回复内容为空。')
    return result(errors, warnings)
  }

  if (/^```/.test(normalized) || /```$/.test(normalized)) {
    warnings.push('回复中可能包含 Markdown 代码块包裹，下载前建议去除。')
  }

  const blocks = normalized.split(/\n{2,}/).filter(Boolean)
  if (blocks.length === 0) {
    errors.push('没有检测到 SRT 字幕块。')
    return result(errors, warnings)
  }

  let expectedIndex = 1
  for (const [blockIndex, block] of blocks.entries()) {
    const lines = block.split('\n').map((line) => line.trim())
    const numberLine = lines[0]
    const timeLine = lines[1]

    if (!/^\d+$/.test(numberLine || '')) {
      errors.push(`第 ${blockIndex + 1} 个字幕块缺少数字序号。`)
      continue
    }

    const parsedIndex = Number(numberLine)
    if (parsedIndex !== expectedIndex) {
      warnings.push(`序号 ${parsedIndex} 不连续，期望为 ${expectedIndex}。`)
      expectedIndex = parsedIndex
    }
    expectedIndex += 1

    if (!timecodePattern.test(timeLine || '')) {
      errors.push(`序号 ${parsedIndex} 的时间轴格式不正确。`)
    }

    if (lines.length < 3 || lines.slice(2).every((line) => !line)) {
      warnings.push(`序号 ${parsedIndex} 没有字幕文本。`)
    }
  }

  if (originalContent?.trim()) {
    const originalBlocks = originalContent.replace(/\r\n/g, '\n').trim().split(/\n{2,}/).filter(Boolean)
    if (originalBlocks.length > 0 && Math.abs(blocks.length - originalBlocks.length) > Math.max(2, originalBlocks.length * 0.08)) {
      warnings.push(`字幕块数量变化较大：原文 ${originalBlocks.length} 块，回复 ${blocks.length} 块。`)
    }
  }

  return result(errors, warnings)
}

function result(errors: string[], warnings: string[]): SrtValidationResult {
  const ok = errors.length === 0
  return {
    checkedAt: Date.now(),
    ok,
    errors,
    warnings,
    summary: ok ? (warnings.length ? 'SRT 格式基本可用，但有警告。' : 'SRT 格式校验通过。') : 'SRT 格式存在错误。'
  }
}
