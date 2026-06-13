import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defaultOutputDir } from './storage'
import type { SaveOutputRequest, StoredFile } from './types'

const require = createRequire(import.meta.url)
const electron = require('electron') as typeof import('electron')
const { dialog } = electron

export async function selectTextFiles(): Promise<StoredFile[]> {
  const result = await dialog.showOpenDialog({
    title: '选择 SRT 文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'SRT subtitles', extensions: ['srt'] },
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

export async function selectSrtSources(): Promise<StoredFile[]> {
  const result = await dialog.showOpenDialog({
    title: '导入 SRT 或字幕文件夹',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [
      { name: 'SRT subtitles', extensions: ['srt'] },
      { name: 'All files', extensions: ['*'] }
    ]
  })

  if (result.canceled) return []
  return loadSrtSources(result.filePaths)
}

export async function selectSrtFolder(): Promise<StoredFile[]> {
  const result = await dialog.showOpenDialog({
    title: '选择字幕文件夹',
    properties: ['openDirectory']
  })

  if (result.canceled || result.filePaths.length === 0) return []

  const rootPath = result.filePaths[0]
  const filePaths = await findSrtFiles(rootPath)
  filePaths.sort((left, right) => left.localeCompare(right))

  return Promise.all(
    filePaths.map(async (filePath) => ({
      name: relative(rootPath, filePath),
      path: filePath,
      content: await readFile(filePath, 'utf8')
    }))
  )
}

export async function loadSrtSources(paths: string[]): Promise<StoredFile[]> {
  const nestedFiles = await Promise.all(paths.map((sourcePath) => loadSrtSource(sourcePath)))
  return nestedFiles
    .flat()
    .sort((left, right) => left.name.localeCompare(right.name))
}

async function loadSrtSource(sourcePath: string): Promise<StoredFile[]> {
  const sourceStat = await stat(sourcePath)
  if (sourceStat.isDirectory()) {
    const filePaths = await findSrtFiles(sourcePath)
    filePaths.sort((left, right) => left.localeCompare(right))
    return Promise.all(filePaths.map((filePath) => readStoredFile(filePath, relative(sourcePath, filePath))))
  }

  if (sourceStat.isFile() && isSrtFile(sourcePath)) return [await readStoredFile(sourcePath)]
  return []
}

async function findSrtFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) return findSrtFiles(entryPath)
      if (entry.isFile() && extname(entry.name).toLocaleLowerCase() === '.srt') return [entryPath]
      return []
    })
  )
  return nestedFiles.flat()
}

function isSrtFile(filePath: string): boolean {
  return extname(filePath).toLocaleLowerCase() === '.srt'
}

async function readStoredFile(filePath: string, name = basename(filePath)): Promise<StoredFile> {
  return {
    name,
    path: filePath,
    content: await readFile(filePath, 'utf8')
  }
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
