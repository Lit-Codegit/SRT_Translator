import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ApiConfig } from './types'

export const projectRoot = process.cwd()
export const dataDir = join(projectRoot, 'data')
export const defaultOutputDir = join(projectRoot, 'output')
export const configPath = join(dataDir, 'config.json')
export const historyPath = join(dataDir, 'history.json')

export const defaultConfig: ApiConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  temperature: 0.3,
  maxTokens: 4096,
  rpm: 20,
  concurrency: 3,
  outputDir: defaultOutputDir,
  modelsQueryPath: 'models',
  modelsCache: {},
  customSystemPrompt:
    '你是专业字幕与文本翻译助手。翻译 SRT 时必须保留序号、时间轴和空行结构，只翻译字幕文本，不添加解释。',
  preset: null
}

export async function ensureStorage(): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  await mkdir(defaultOutputDir, { recursive: true })
}

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await ensureStorage()
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export async function loadConfig(): Promise<ApiConfig> {
  const stored = await readJsonFile<Partial<ApiConfig>>(configPath, {})
  return { ...defaultConfig, ...stored }
}

export async function saveConfig(config: ApiConfig): Promise<ApiConfig> {
  const normalized = {
    ...defaultConfig,
    ...config,
    outputDir: resolve(config.outputDir || defaultOutputDir)
  }
  await writeJsonFile(configPath, normalized)
  return normalized
}
