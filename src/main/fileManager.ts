import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defaultOutputDir } from './storage'
import type { SaveOutputRequest, StoredFile } from './types'

const require = createRequire(import.meta.url)
const electron = require('electron') as typeof import('electron')
const { dialog } = electron

export async function selectTextFiles(): Promise<StoredFile[]> {
  const result = await dialog.showOpenDialog({
    title: '选择要翻译的文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Text files', extensions: ['srt', 'txt', 'md', 'ass', 'vtt', 'json'] },
      { name: 'All files', extensions: ['*'] }
    ]
  })

  if (result.canceled) return []

  return Promise.all(
    result.filePaths.map(async (filePath) => ({
      name: basename(filePath),
      path: filePath,
      content: await readFile(filePath, 'utf8')
    }))
  )
}

export async function selectPresetFile(): Promise<StoredFile | null> {
  const result = await dialog.showOpenDialog({
    title: '导入预设 JSON',
    properties: ['openFile'],
    filters: [
      { name: 'JSON', extensions: ['json'] },
      { name: 'All files', extensions: ['*'] }
    ]
  })

  if (result.canceled || result.filePaths.length === 0) return null
  const filePath = result.filePaths[0]
  return {
    name: basename(filePath),
    path: filePath,
    content: await readFile(filePath, 'utf8')
  }
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim() || 'translation'
}

export async function saveOutput(request: SaveOutputRequest): Promise<string> {
  const targetDir = resolve(request.outputDir || defaultOutputDir)
  await mkdir(targetDir, { recursive: true })

  const cleanExtension = request.extension.replace(/^\.+/, '') || 'srt'
  const baseName = sanitizeFileName(request.fileName.replace(extname(request.fileName), ''))
  const outputPath = join(targetDir, `${baseName}.${cleanExtension}`)
  await writeFile(outputPath, request.content, 'utf8')
  return outputPath
}
