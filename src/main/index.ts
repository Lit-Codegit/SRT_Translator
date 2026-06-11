import { createRequire } from 'node:module'
import type { BrowserWindow as ElectronBrowserWindow } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { testApi, listModels } from './apiProxy'
import { saveOutput, selectPresetFile, selectTextFiles } from './fileManager'
import { GenerationQueue } from './taskQueue'
import { configPath, defaultConfig, ensureStorage, historyPath, loadConfig, readJsonFile, saveConfig, writeJsonFile } from './storage'
import type { ApiConfig, GenerationRequest, SaveOutputRequest } from './types'

const require = createRequire(import.meta.url)
const electron = require('electron') as typeof import('electron')
const { app, BrowserWindow, dialog, ipcMain } = electron

let mainWindow: ElectronBrowserWindow | null = null
const queue = new GenerationQueue(() => mainWindow)

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#f7f7f4',
    title: 'SRT Translator',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[preload-error]', preloadPath, error)
  })

  if (!app.isPackaged) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const hasTranslator = await mainWindow?.webContents.executeJavaScript('Boolean(window.translator)')
      console.log('[preload-check] window.translator =', hasTranslator)
    })
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadURL(pathToFileURL(join(__dirname, '../renderer/index.html')).toString())
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  await ensureStorage()

  ipcMain.handle('config:get', async () => loadConfig())
  ipcMain.handle('config:save', async (_event, config: ApiConfig) => saveConfig(config))
  ipcMain.handle('config:test', async (_event, config: ApiConfig) => testApi(config))
  ipcMain.handle('config:listModels', async (_event, config: ApiConfig) => listModels(config))
  ipcMain.handle('config:paths', async () => ({
    configPath,
    historyPath,
    defaultOutputDir: defaultConfig.outputDir
  }))
  ipcMain.handle('dialog:select-output-dir', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择默认下载目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('files:select', async () => selectTextFiles())
  ipcMain.handle('preset:select', async () => selectPresetFile())
  ipcMain.handle('output:save', async (_event, request: SaveOutputRequest) => saveOutput(request))

  ipcMain.handle('history:get', async () => readJsonFile(historyPath, null))
  ipcMain.handle('history:save', async (_event, history: unknown) => {
    await writeJsonFile(historyPath, history)
    return true
  })
  ipcMain.handle('history:export', async (_event, history: unknown) => {
    const result = await dialog.showSaveDialog({
      title: '导出历史记录',
      defaultPath: 'srt-translator-history.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null
    await writeJsonFile(result.filePath, history)
    return result.filePath
  })
  ipcMain.handle('history:import', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入历史记录',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return readJsonFile(result.filePaths[0], null)
  })

  ipcMain.handle('generation:start', async (_event, request: GenerationRequest) => {
    queue.enqueue(request)
    return true
  })
  ipcMain.handle('generation:cancel', async (_event, sessionId: string) => {
    queue.cancel(sessionId)
    return true
  })

  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
