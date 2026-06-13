import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clipboard,
  Download,
  FolderOpen,
  History,
  KeyRound,
  ListTree,
  Loader2,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings2,
  Square,
  ShieldCheck,
  Trash2,
  Upload,
  XCircle
} from 'lucide-react'
import { buildMessages } from './lib/prompts'
import { parsePreset } from './lib/preset'
import { validateSrt } from './lib/srt'
import { createId } from './lib/id'
import { parseThinking } from './lib/thinking'
import { emptyHistory, useAppStore } from './stores/appStore'
import type { ApiConfig, ChatSession, GroupSettings, ImportedFile, Message, PromptItem, SessionGroup } from './types'

type RunSettings = {
  mode: GroupSettings['mode']
  model: string
  concurrency: number
  outputDir: string
  systemPrompt: string
}

type FileSystemEntryLike = {
  name: string
  isFile: boolean
  isDirectory: boolean
}

type FileSystemFileEntryLike = FileSystemEntryLike & {
  file: (success: (file: File) => void, error?: (error: DOMException) => void) => void
}

type FileSystemDirectoryEntryLike = FileSystemEntryLike & {
  createReader: () => {
    readEntries: (
      success: (entries: FileSystemEntryLike[]) => void,
      error?: (error: DOMException) => void
    ) => void
  }
}

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => FileSystemEntryLike | null
}

export function App(): JSX.Element {
  if (!window.translator) {
    return (
      <div className="loading-screen">
        <XCircle size={24} />
        <div>Electron preload 未加载。请在 Electron 应用窗口中打开，不要直接用浏览器访问开发地址。</div>
      </div>
    )
  }

  const {
    ready,
    sidebarCollapsed,
    config,
    preset,
    customSystemPrompt,
    history,
    draft,
    stagedFiles,
    setReady,
    setSidebarCollapsed,
    setConfig,
    setPaths,
    setPreset,
    updatePromptEnabled,
    setCustomSystemPrompt,
    setHistory,
    setDraft,
    setStagedFiles,
    createGroupWithSessions,
    createEmptyGroup,
    addUserMessage,
    addFilesToGroup,
    deleteSession,
    deleteGroup,
    rollbackToMessage,
    setActiveSession,
    toggleGroup,
    updateGroupSettings,
    renameGroup,
    renameSession,
    updateSessionStatus,
    appendAssistantChunk,
    finishAssistant,
    setMessageValidation
  } = useAppStore()

  const [apiTest, setApiTest] = useState<{ state: 'idle' | 'testing' | 'ok' | 'error'; message: string }>({
    state: 'idle',
    message: ''
  })
  const [modelQuery, setModelQuery] = useState<{ state: 'idle' | 'loading' | 'ok' | 'error'; message: string }>({
    state: 'idle',
    message: ''
  })
  const [expandedSection, setExpandedSection] = useState<'settings' | 'history'>('settings')
  const [settingsGroupId, setSettingsGroupId] = useState<string | null>(null)
  const [composerDragActive, setComposerDragActive] = useState(false)
  const [importNotice, setImportNotice] = useState('')

  const activeSession = history.activeSessionId ? history.sessions[history.activeSessionId] : undefined
  const activeGroup = activeSession
    ? history.groups.find((g) => g.sessionIds.includes(activeSession.id))
    : undefined
  const isGenerating =
    activeSession?.status === 'queued' ||
    activeSession?.status === 'connecting' ||
    activeSession?.status === 'streaming'
  const isBusy = isGenerating || activeSession?.status === 'validating' || activeSession?.status === 'downloading'
  const canSend = (draft.trim().length > 0 || stagedFiles.length > 0) && !isBusy
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const runSettingsRef = useRef(new Map<string, RunSettings>())
  const autoValidationRetryRef = useRef(new Map<string, number>())
  const composerDragDepthRef = useRef(0)
  const importNoticeTimerRef = useRef<number | null>(null)

  // Determine model list for current baseUrl
  const currentModels = config?.modelsCache?.[config?.baseUrl ?? ''] ?? []

  useEffect(() => {
    async function boot(): Promise<void> {
      const [loadedConfig, loadedPaths, loadedHistory] = await Promise.all([
        window.translator.getConfig(),
        window.translator.getPaths(),
        window.translator.getHistory()
      ])
      setConfig(loadedConfig)
      setPaths(loadedPaths)
      if (isHistoryState(loadedHistory)) setHistory(loadedHistory)
      // Restore preset and system prompt from persisted config
      setCustomSystemPrompt(loadedConfig.customSystemPrompt)
      if (loadedConfig.preset) setPreset(loadedConfig.preset as Parameters<typeof setPreset>[0])
      setReady(true)
    }

    boot()
  }, [setConfig, setHistory, setPaths, setReady])

  useEffect(() => {
    if (!ready) return
    const timeout = window.setTimeout(() => {
      window.translator.saveHistory(history)
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [history, ready])

  useEffect(() => {
    const unsubscribers = [
      window.translator.onGenerationStatus((payload) => {
        updateSessionStatus(payload.sessionId, payload.status)
      }),
      window.translator.onGenerationChunk((payload) => {
        appendAssistantChunk(payload.sessionId, payload.requestId, payload.content, payload.reasoning)
      }),
      window.translator.onGenerationDone((payload) => {
        void handleGenerationDone(payload.sessionId, payload.requestId)
      }),
      window.translator.onGenerationError((payload) => {
        updateSessionStatus(payload.sessionId, 'error', payload.error)
      })
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [appendAssistantChunk, finishAssistant, updateSessionStatus])

  useEffect(() => {
    if (stickToBottomRef.current) {
      messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight })
    }
  }, [activeSession?.messages.length, activeSession?.messages.at(-1)?.content])

  useEffect(() => {
    return () => {
      if (importNoticeTimerRef.current) window.clearTimeout(importNoticeTimerRef.current)
    }
  }, [])

  useEffect(() => {
    stickToBottomRef.current = true
    requestAnimationFrame(() => messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight }))
  }, [activeSession?.id])

  async function persistConfig(next: ApiConfig): Promise<void> {
    setConfig(next)
    const saved = await window.translator.saveConfig(next)
    setConfig(saved)
  }

  async function handleSetCustomSystemPrompt(value: string): Promise<void> {
    setCustomSystemPrompt(value)
    if (config) await persistConfig({ ...config, customSystemPrompt: value })
  }

  function defaultGroupSettings(currentConfig: ApiConfig): GroupSettings {
    return {
      mode: currentConfig.defaultGroupMode ?? 'conversation'
    }
  }

  function handleCreateEmptyGroup(): void {
    if (!config) return
    createEmptyGroup(defaultGroupSettings(config))
  }

  function toggleActiveGroupMode(): void {
    if (!activeGroup) return
    const currentMode = activeGroup.settings?.mode ?? 'conversation'
    const nextMode: GroupSettings['mode'] = currentMode === 'autoSrt' ? 'conversation' : 'autoSrt'
    updateGroupSettings(activeGroup.id, {
      ...activeGroup.settings,
      mode: nextMode
    })
  }

  async function handleBaseUrlChange(newUrl: string): Promise<void> {
    if (!config) return
    // Clear model selection when baseUrl changes
    await persistConfig({ ...config, baseUrl: newUrl, model: '' })
    setModelQuery({ state: 'idle', message: '' })
  }

  async function queryModels(): Promise<void> {
    if (!config) return
    setModelQuery({ state: 'loading', message: '查询模型列表中...' })

    const result = await window.translator.listModels(config)
    if (result.ok) {
      const nextCache = { ...config.modelsCache, [config.baseUrl]: result.models }
      await persistConfig({ ...config, modelsCache: nextCache })
      setModelQuery({ state: 'ok', message: result.message })
    } else {
      // Clear cache for this URL on failure
      const nextCache = { ...config.modelsCache }
      delete nextCache[config.baseUrl]
      await persistConfig({ ...config, modelsCache: nextCache })
      setModelQuery({ state: 'error', message: result.message })
    }
  }

  async function testCurrentApi(): Promise<void> {
    if (!config) return
    setApiTest({ state: 'testing', message: '测试中...' })
    const result = await window.translator.testApi(config)
    setApiTest({
      state: result.ok ? 'ok' : 'error',
      message: `${result.message}${result.latencyMs ? ` · ${result.latencyMs}ms` : ''}`
    })
  }

  function stageImportedFiles(files: ImportedFile[]): void {
    if (!files.length) return
    const merged = new Map(stagedFiles.map((file) => [file.path || file.name, file]))
    files.forEach((file) => merged.set(file.path || file.name, file))
    setStagedFiles([...merged.values()])
  }

  function showImportNotice(message: string): void {
    setImportNotice(message)
    if (importNoticeTimerRef.current) window.clearTimeout(importNoticeTimerRef.current)
    importNoticeTimerRef.current = window.setTimeout(() => {
      setImportNotice('')
      importNoticeTimerRef.current = null
    }, 2400)
  }

  async function chooseSrtSources(): Promise<void> {
    const files = await window.translator.selectFiles()
    const srtFiles = files.filter((file) => isSrtName(file.name))
    stageImportedFiles(srtFiles)
    if (srtFiles.length) showImportNotice(`已导入 ${srtFiles.length} 个 SRT`)
  }

  async function chooseSrtFolder(): Promise<void> {
    const files = await window.translator.selectSrtFolder()
    stageImportedFiles(files)
    if (files.length) showImportNotice(`已导入 ${files.length} 个 SRT`)
  }

  function removeStagedFile(fileKey: string): void {
    setStagedFiles(stagedFiles.filter((file) => (file.path || file.name) !== fileKey))
  }

  function hasDraggedSources(dataTransfer: DataTransfer): boolean {
    return Array.from(dataTransfer.types).some((type) => {
      const normalizedType = type.toLocaleLowerCase()
      return normalizedType === 'file' || normalizedType === 'files' || normalizedType.startsWith('text/') || normalizedType.includes('uri-list')
    })
  }

  function handleComposerDragEnter(event: React.DragEvent<HTMLDivElement>): void {
    if (!hasDraggedSources(event.dataTransfer)) return
    event.preventDefault()
    composerDragDepthRef.current += 1
    setComposerDragActive(true)
  }

  function handleComposerDragOver(event: React.DragEvent<HTMLDivElement>): void {
    if (!hasDraggedSources(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setComposerDragActive(true)
  }

  function handleComposerDragLeave(event: React.DragEvent<HTMLDivElement>): void {
    if (!hasDraggedSources(event.dataTransfer)) return
    composerDragDepthRef.current = Math.max(0, composerDragDepthRef.current - 1)
    if (composerDragDepthRef.current === 0) setComposerDragActive(false)
  }

  async function handleComposerDrop(event: React.DragEvent<HTMLDivElement>): Promise<void> {
    if (!hasDraggedSources(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    composerDragDepthRef.current = 0
    setComposerDragActive(false)

    try {
      const paths = await getDroppedSourcePaths(event.dataTransfer)
      const pathFiles = paths.length ? await window.translator.loadSrtSources(paths) : []
      const browserFiles = pathFiles.length ? [] : await getDroppedSourceFiles(event.dataTransfer)
      const files = [...pathFiles, ...browserFiles]
      if (!files.length) {
        const types = Array.from(event.dataTransfer.types).join(', ') || '空'
        showImportNotice(`没有找到可导入的 .srt · ${types}`)
        return
      }
      stageImportedFiles(files)
      showImportNotice(`已导入 ${files.length} 个 SRT`)
    } catch (error) {
      showImportNotice(`导入失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  async function getDroppedSourcePaths(dataTransfer: DataTransfer): Promise<string[]> {
    const droppedFiles = [
      ...Array.from(dataTransfer.files),
      ...Array.from(dataTransfer.items).flatMap((item) => {
        if (item.kind !== 'file') return []
        const file = item.getAsFile()
        return file ? [file] : []
      })
    ]
    const filePaths = droppedFiles.flatMap((file) => {
      try {
        const path = window.translator.getPathForFile(file)
        return path ? [path] : []
      } catch {
        return []
      }
    })
    const typeValues = Array.from(dataTransfer.types).flatMap((type) => getDroppedText(dataTransfer, type))
    const itemValues = await Promise.all(
      Array.from(dataTransfer.items)
        .filter((item) => item.kind === 'string')
        .map((item) => readDroppedItemText(item))
    )
    const textPaths = [...typeValues, ...itemValues].flatMap((value) => parseDroppedText(value))
    return Array.from(new Set([...filePaths, ...textPaths]))
  }

  async function getDroppedSourceFiles(dataTransfer: DataTransfer): Promise<ImportedFile[]> {
    const entryFiles = await getDroppedEntryFiles(dataTransfer)
    if (entryFiles.length) return entryFiles

    const droppedFiles = [
      ...Array.from(dataTransfer.files),
      ...Array.from(dataTransfer.items).flatMap((item) => {
        if (item.kind !== 'file') return []
        const file = item.getAsFile()
        return file ? [file] : []
      })
    ]
    const uniqueFiles = new Map(droppedFiles.map((file) => [`${file.name}:${file.size}:${file.lastModified}`, file]))
    const imported = await Promise.all(
      [...uniqueFiles.values()]
        .filter((file) => isSrtName(file.name))
        .map((file) => readDroppedFile(file, file.name))
    )
    return imported
  }

  async function getDroppedEntryFiles(dataTransfer: DataTransfer): Promise<ImportedFile[]> {
    const entries = Array.from(dataTransfer.items).flatMap((item) => {
      if (item.kind !== 'file') return []
      const entry = (item as DataTransferItemWithEntry).webkitGetAsEntry?.()
      return entry ? [entry] : []
    })
    const nestedFiles = await Promise.all(entries.map((entry) => readDroppedEntry(entry)))
    return nestedFiles.flat()
  }

  async function readDroppedEntry(entry: FileSystemEntryLike, parentPath = ''): Promise<ImportedFile[]> {
    const entryPath = parentPath ? `${parentPath}/${entry.name}` : entry.name
    if (entry.isFile) {
      if (!isSrtName(entry.name)) return []
      const file = await readEntryFile(entry as FileSystemFileEntryLike)
      return [await readDroppedFile(file, entryPath)]
    }
    if (!entry.isDirectory) return []

    const children = await readDirectoryEntries(entry as FileSystemDirectoryEntryLike)
    const nestedFiles = await Promise.all(children.map((child) => readDroppedEntry(child, entryPath)))
    return nestedFiles.flat()
  }

  function readEntryFile(entry: FileSystemFileEntryLike): Promise<File> {
    return new Promise((resolve, reject) => entry.file(resolve, reject))
  }

  async function readDirectoryEntries(entry: FileSystemDirectoryEntryLike): Promise<FileSystemEntryLike[]> {
    const reader = entry.createReader()
    const entries: FileSystemEntryLike[] = []
    while (true) {
      const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) => {
        reader.readEntries(resolve, reject)
      })
      if (!batch.length) return entries
      entries.push(...batch)
    }
  }

  async function readDroppedFile(file: File, name: string): Promise<ImportedFile> {
    return {
      name,
      path: name,
      content: await file.text()
    }
  }

  function isSrtName(name: string): boolean {
    return name.toLocaleLowerCase().endsWith('.srt')
  }

  function getDroppedText(dataTransfer: DataTransfer, type: string): string[] {
    try {
      const value = dataTransfer.getData(type)
      return value ? [value] : []
    } catch {
      return []
    }
  }

  function readDroppedItemText(item: DataTransferItem): Promise<string> {
    return new Promise((resolve) => {
      try {
        item.getAsString((value) => resolve(value || ''))
      } catch {
        resolve('')
      }
    })
  }

  function parseDroppedText(value: string): string[] {
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .flatMap((line) => {
        if (line.startsWith('/')) return [line]
        try {
          const url = new URL(line)
          return url.protocol === 'file:' ? [decodeURIComponent(url.pathname)] : []
        } catch {
          return []
        }
      })
  }

  async function importPreset(): Promise<void> {
    const file = await window.translator.selectPreset()
    if (!file) return
    const nextPreset = parsePreset(file.content, file.name)
    setPreset(nextPreset)
    if (config) {
      const nextConfig = {
        ...config,
        temperature: nextPreset.parameters.temperature ?? config.temperature,
        maxTokens: nextPreset.parameters.maxTokens ?? config.maxTokens,
        preset: nextPreset
      }
      await persistConfig(nextConfig)
    }
  }

  async function sendCurrentDraft(files = stagedFiles, instruction = draft.trim()): Promise<void> {
    if (!config) return
    if (!instruction && files.length === 0) return
    setDraft('')

    if (files.length > 0) {
      // Has staged files → add to active group or create new group
      if (activeGroup) {
        const newSessions = addFilesToGroup(activeGroup.id, instruction, files)
        setStagedFiles([])
        for (const session of newSessions) {
          await startGeneration(session)
        }
      } else {
        const newSessions = createGroupWithSessions(instruction, files, defaultGroupSettings(config))
        for (const session of newSessions) {
          await startGeneration(session)
        }
      }
    } else if (activeSession) {
      // Continue existing conversation with multi-turn context
      const prevMessages = activeSession.messages
      autoValidationRetryRef.current.delete(activeSession.id)
      addUserMessage(activeSession.id, instruction)
      updateSessionStatus(activeSession.id, 'queued')
      const runSettings = resolveRunSettings(activeSession.groupId, config, history.groups)
      const msgs = buildMessages({
        preset,
        customSystemPrompt: runSettings.systemPrompt,
        instruction,
        fileName: activeSession.fileName,
        sourceText: activeSession.sourceText,
        existingMessages: prevMessages
      })
      const requestId = createId('req')
      runSettingsRef.current.set(requestId, runSettings)
      await window.translator.startGeneration({
        requestId,
        sessionId: activeSession.id,
        groupId: activeSession.groupId,
        config: { ...config, model: runSettings.model, concurrency: runSettings.concurrency },
        messages: msgs
      })
    } else {
      // Fresh start — create new group with one session
      const newSessions = createGroupWithSessions(instruction, [], defaultGroupSettings(config))
      for (const session of newSessions) {
        await startGeneration(session)
      }
    }
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (canSend) void sendCurrentDraft()
  }

  async function startGeneration(session: ChatSession): Promise<void> {
    if (!config) return
    autoValidationRetryRef.current.delete(session.id)
    updateSessionStatus(session.id, 'queued')
    const runSettings = resolveRunSettings(session.groupId, config, useAppStore.getState().history.groups)
    const msgs = buildMessages({
      preset,
      customSystemPrompt: runSettings.systemPrompt,
      instruction: session.instruction,
      fileName: session.fileName,
      sourceText: session.sourceText,
      existingMessages: session.messages.length > 0 ? session.messages : undefined
    })
    const requestId = createId('req')
    runSettingsRef.current.set(requestId, runSettings)
    await window.translator.startGeneration({
      requestId,
      sessionId: session.id,
      groupId: session.groupId,
      config: { ...config, model: runSettings.model, concurrency: runSettings.concurrency },
      messages: msgs
    })
  }

  async function regenerate(session: ChatSession, messageId: string): Promise<void> {
    if (!config) return
    autoValidationRetryRef.current.delete(session.id)
    rollbackToMessage(session.id, messageId)
    const state = useAppStore.getState()
    const rolledBack = state.history.sessions[session.id]
    if (!rolledBack) return
    updateSessionStatus(session.id, 'queued')
    const runSettings = resolveRunSettings(session.groupId, config, state.history.groups)
    const msgs = buildMessages({
      preset,
      customSystemPrompt: runSettings.systemPrompt,
      instruction: session.instruction,
      fileName: session.fileName,
      sourceText: session.sourceText,
      existingMessages: rolledBack.messages.length > 0 ? rolledBack.messages : undefined
    })
    const requestId = createId('req')
    runSettingsRef.current.set(requestId, runSettings)
    await window.translator.startGeneration({
      requestId,
      sessionId: session.id,
      groupId: session.groupId,
      config: { ...config, model: runSettings.model, concurrency: runSettings.concurrency },
      messages: msgs
    })
  }

  async function downloadMessage(session: ChatSession, message: Message): Promise<void> {
    if (!config) return
    const runSettings = resolveRunSettings(session.groupId, config, history.groups)
    await window.translator.saveOutput({
      fileName: session.fileName || session.title || 'translation',
      content: message.content,
      extension: 'srt',
      outputDir: runSettings.outputDir
    })
  }

  async function handleGenerationDone(sessionId: string, requestId: string): Promise<void> {
    const state = useAppStore.getState()
    const session = state.history.sessions[sessionId]
    const currentConfig = state.config
    if (!session || !currentConfig) return

    const runSettings =
      runSettingsRef.current.get(requestId) ?? resolveRunSettings(session.groupId, currentConfig, state.history.groups)
    runSettingsRef.current.delete(requestId)

    if (runSettings.mode === 'conversation') {
      finishAssistant(sessionId, requestId)
      return
    }

    const message = [...session.messages]
      .reverse()
      .find((item) => item.role === 'assistant' && item.requestId === requestId)
    if (!message) {
      updateSessionStatus(sessionId, 'error', '自动处理失败：未找到 AI 回复。')
      return
    }

    updateSessionStatus(sessionId, 'validating')
    const parsed = parseThinking(message.content)
    const validation = validateSrt(parsed.body, session.sourceText)
    setMessageValidation(sessionId, message.id, validation)
    if (!validation.ok) {
      const retryStarted = await retryAfterValidationFailure(session, message, validation.summary, currentConfig, state.history.groups)
      if (retryStarted) return
      updateSessionStatus(sessionId, 'error', `自动校验失败：${validation.summary}`)
      return
    }
    autoValidationRetryRef.current.delete(sessionId)

    updateSessionStatus(sessionId, 'downloading')
    try {
      await window.translator.saveOutput({
        fileName: session.fileName || session.title || 'translation',
        content: parsed.body,
        extension: 'srt',
        outputDir: runSettings.outputDir
      })
      finishAssistant(sessionId, requestId)
    } catch (error) {
      updateSessionStatus(sessionId, 'error', `自动下载失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  async function retryAfterValidationFailure(
    session: ChatSession,
    message: Message,
    summary: string,
    currentConfig: ApiConfig,
    groups: SessionGroup[]
  ): Promise<boolean> {
    const maxRetries = Math.max(0, Math.floor(currentConfig.autoValidationRetryCount ?? 0))
    const currentRetry = autoValidationRetryRef.current.get(session.id) ?? 0
    if (currentRetry >= maxRetries) {
      autoValidationRetryRef.current.delete(session.id)
      return false
    }

    autoValidationRetryRef.current.set(session.id, currentRetry + 1)
    rollbackToMessage(session.id, message.id)
    const state = useAppStore.getState()
    const rolledBack = state.history.sessions[session.id]
    if (!rolledBack) return false

    updateSessionStatus(session.id, 'queued', `自动校验失败，正在重试 ${currentRetry + 1}/${maxRetries}：${summary}`)
    const runSettings = resolveRunSettings(session.groupId, currentConfig, groups)
    const retryRequestId = createId('req')
    const msgs = buildMessages({
      preset,
      customSystemPrompt: runSettings.systemPrompt,
      instruction: session.instruction,
      fileName: session.fileName,
      sourceText: session.sourceText,
      existingMessages: rolledBack.messages.length > 0 ? rolledBack.messages : undefined
    })
    runSettingsRef.current.set(retryRequestId, runSettings)
    await window.translator.startGeneration({
      requestId: retryRequestId,
      sessionId: session.id,
      groupId: session.groupId,
      config: { ...currentConfig, model: runSettings.model, concurrency: runSettings.concurrency },
      messages: msgs
    })
    return true
  }

  const statusCounts = useMemo(() => {
    const ids = activeGroup?.sessionIds ?? []
    const values = ids.map((id) => history.sessions[id]).filter(Boolean) as ChatSession[]
    return {
      queued: values.filter((s) => s.status === 'queued').length,
      streaming: values.filter((s) => s.status === 'streaming').length,
      validating: values.filter((s) => s.status === 'validating').length,
      downloading: values.filter((s) => s.status === 'downloading').length,
      done: values.filter((s) => s.status === 'done').length,
      error: values.filter((s) => s.status === 'error').length
    }
  }, [history.sessions, activeGroup])
  const statusSummary = [
    statusCounts.streaming > 0 && `${statusCounts.streaming} 处理中`,
    statusCounts.queued > 0 && `${statusCounts.queued} 排队`,
    statusCounts.validating > 0 && `${statusCounts.validating} 校验中`,
    statusCounts.downloading > 0 && `${statusCounts.downloading} 下载中`,
    statusCounts.done > 0 && `${statusCounts.done} 成功`,
    statusCounts.error > 0 && `${statusCounts.error} 失败`
  ]
    .filter(Boolean)
    .join(' · ')
  const settingsGroup = settingsGroupId ? history.groups.find((group) => group.id === settingsGroupId) : undefined

  if (!ready || !config) {
    return (
      <div className="loading-screen">
        <Loader2 className="spin" size={24} />
        正在启动本地翻译器
      </div>
    )
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-top">
          {!sidebarCollapsed && <div className="brand">SRT Translator</div>}
          <button className="icon-button" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} title="折叠侧栏">
            {sidebarCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          </button>
        </div>

        {!sidebarCollapsed && (
          <div className="sidebar-accordion">
            {/* ── Settings Section ── */}
            <section className={`accordion-section ${expandedSection === 'settings' ? 'expanded' : 'collapsed'}`}>
              <button className="section-header" onClick={() => setExpandedSection('settings')}>
                <Settings2 size={16} />
                <span>设置</span>
                {expandedSection === 'settings' ? <ChevronDown size={14} className="section-chevron" /> : <ChevronUp size={14} className="section-chevron" />}
              </button>
              {expandedSection === 'settings' && (
                <div className="section-body">
                  {/* API 设置 */}
                  <div className="panel">
                    <PanelTitle icon={<KeyRound size={16} />} title="API 设置" />
                    <Field label="Base URL">
                      <input
                        value={config.baseUrl}
                        onChange={(event) => handleBaseUrlChange(event.target.value)}
                      />
                    </Field>
                    <Field label="API Key">
                      <input
                        type="password"
                        value={config.apiKey}
                        onChange={(event) => persistConfig({ ...config, apiKey: event.target.value })}
                        placeholder="sk-..."
                      />
                    </Field>
                    <Field label="Model">
                      <ModelPicker
                        value={config.model}
                        models={currentModels}
                        placeholder="选择或输入模型 ID"
                        onChange={(model) => persistConfig({ ...config, model })}
                      />
                    </Field>
                    <div className="model-query-row">
                      <button className="soft-button compact" onClick={queryModels} disabled={modelQuery.state === 'loading'}>
                        {modelQuery.state === 'loading' ? <Loader2 className="spin" size={14} /> : <Search size={14} />}
                        查询模型
                      </button>
                    </div>
                    {modelQuery.message && (
                      <div className={`test-result ${modelQuery.state}`}>{modelQuery.message}</div>
                    )}
                    <Field label="模型查询路径">
                      <input
                        value={config.modelsQueryPath}
                        onChange={(event) => persistConfig({ ...config, modelsQueryPath: event.target.value })}
                        placeholder="models"
                      />
                    </Field>
                    <div className="field-grid">
                      <Field label="Temperature">
                        <input
                          type="number"
                          step="0.1"
                          value={config.temperature}
                          onChange={(event) => persistConfig({ ...config, temperature: Number(event.target.value) })}
                        />
                      </Field>
                      <Field label="Max Tokens">
                        <input
                          type="number"
                          value={config.maxTokens}
                          onChange={(event) => persistConfig({ ...config, maxTokens: Number(event.target.value) })}
                        />
                      </Field>
                    </div>
                    <div className="field-grid">
                      <Field label="RPM">
                        <input
                          type="number"
                          min={1}
                          value={config.rpm}
                          onChange={(event) => persistConfig({ ...config, rpm: Number(event.target.value) })}
                        />
                      </Field>
                      <Field label="并发">
                        <input
                          type="number"
                          min={1}
                          value={config.concurrency}
                          onChange={(event) => persistConfig({ ...config, concurrency: Number(event.target.value) })}
                        />
                      </Field>
                    </div>
                    <button className="soft-button" onClick={testCurrentApi}>
                      {apiTest.state === 'testing' ? <Loader2 className="spin" size={15} /> : <ShieldCheck size={15} />}
                      测试 API
                    </button>
                    {apiTest.message && <div className={`test-result ${apiTest.state}`}>{apiTest.message}</div>}
                    <Field label="下载目录">
                      <div className="path-row">
                        <input value={config.outputDir} onChange={(event) => persistConfig({ ...config, outputDir: event.target.value })} />
                        <button
                          className="icon-button"
                          title="选择目录"
                          onClick={async () => {
                            const dir = await window.translator.selectOutputDir()
                            if (dir) await persistConfig({ ...config, outputDir: dir })
                          }}
                        >
                          <FolderOpen size={16} />
                        </button>
                      </div>
                    </Field>
                    <Field label="新建任务默认模式">
                      <div className="global-mode-toggle">
                        <button
                          type="button"
                          className={(config.defaultGroupMode ?? 'conversation') === 'conversation' ? 'selected' : ''}
                          onClick={() => persistConfig({ ...config, defaultGroupMode: 'conversation' })}
                        >
                          对话模式
                        </button>
                        <button
                          type="button"
                          className={config.defaultGroupMode === 'autoSrt' ? 'selected' : ''}
                          onClick={() => persistConfig({ ...config, defaultGroupMode: 'autoSrt' })}
                        >
                          自动字幕
                        </button>
                      </div>
                    </Field>
                    <Field label="自动字幕校验失败重试次数">
                      <input
                        type="number"
                        min={0}
                        value={config.autoValidationRetryCount ?? 0}
                        onChange={(event) =>
                          persistConfig({
                            ...config,
                            autoValidationRetryCount: Math.max(0, Math.floor(Number(event.target.value) || 0))
                          })
                        }
                      />
                    </Field>
                  </div>

                  {/* 预设与提示词 */}
                  <div className="panel">
                    <PanelTitle icon={<ListTree size={16} />} title="预设与提示词" />
                    <button className="soft-button" onClick={importPreset}>
                      <Upload size={15} />
                      导入预设 JSON
                    </button>
                    <SystemPromptEditor
                      value={customSystemPrompt}
                      onSave={handleSetCustomSystemPrompt}
                    />
                    <div className="prompt-list">
                      {preset ? (
                        preset.prompts.map((prompt) => (
                          <PromptPreviewItem
                            key={prompt.identifier}
                            prompt={prompt}
                            onEnabledChange={(enabled) => updatePromptEnabled(prompt.identifier, enabled)}
                          />
                        ))
                      ) : (
                        <div className="empty-note">尚未导入预设。</div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </section>

            {/* ── History Section ── */}
            <section className={`accordion-section ${expandedSection === 'history' ? 'expanded' : 'collapsed'}`}>
              <button className="section-header" onClick={() => setExpandedSection('history')}>
                <History size={16} />
                <span>历史记录</span>
                {expandedSection === 'history' ? <ChevronDown size={14} className="section-chevron" /> : <ChevronUp size={14} className="section-chevron" />}
              </button>
              {expandedSection === 'history' && (
                <div className="section-body">
                  <div className="panel history-panel">
                    <div className="history-actions">
                      <button className="soft-button compact" onClick={() => window.translator.exportHistory(history)}>
                        <Save size={14} />
                        导出
                      </button>
                      <button
                        className="soft-button compact"
                        onClick={async () => {
                          const imported = await window.translator.importHistory()
                          if (isHistoryState(imported)) setHistory(imported)
                        }}
                      >
                        <Upload size={14} />
                        导入
                      </button>
                    </div>
                    <div className="history-list">
                      {history.groups.map((group) => (
                        <div className="group" key={group.id}>
                          <div className="group-title">
                            <button className="group-toggle" onClick={() => toggleGroup(group.id)}>
                              {group.expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                              <span>{group.title}</span>
                            </button>
                            <button
                              className="group-action"
                              title="组设置"
                              onClick={(event) => {
                                event.stopPropagation()
                                setSettingsGroupId(group.id)
                              }}
                            >
                              <Settings2 size={13} />
                            </button>
                            <button
                              className="delete-btn"
                              title="删除组"
                              onClick={(e) => {
                                e.stopPropagation()
                                deleteGroup(group.id)
                              }}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                          {group.expanded &&
                            group.sessionIds.map((sessionId) => {
                              const session = history.sessions[sessionId]
                              if (!session) return null
                              return (
                                <SessionRow
                                  key={session.id}
                                  session={session}
                                  active={session.id === history.activeSessionId}
                                  onSelect={() => setActiveSession(session.id)}
                                  onRename={(title) => renameSession(session.id, title)}
                                  onDelete={() => deleteSession(session.id)}
                                />
                              )
                            })}
                        </div>
                      ))}
                      {history.groups.length === 0 && <div className="empty-note">暂无历史。</div>}
                    </div>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </aside>

      <main className="chat-pane">
        <header className="chat-header">
          <div>
            <div className="chat-title">
              <span className="chat-title-text">
                {activeGroup ? `${activeGroup.title} · ` : ''}{activeSession?.title || '新翻译'}
              </span>
            </div>
            <div className="chat-subtitle">
              {statusSummary || ' '}
            </div>
          </div>
          <div className="chat-header-actions">
            {activeGroup && (
              <button
                type="button"
                className={`mode-badge ${activeGroup.settings?.mode === 'autoSrt' ? 'auto' : 'conversation'}`}
                onClick={toggleActiveGroupMode}
                title="点击切换当前任务模式"
              >
                {activeGroup.settings?.mode === 'autoSrt' ? '自动字幕' : '对话模式'}
              </button>
            )}
            <button className="icon-button" onClick={handleCreateEmptyGroup} title="新建任务">
              <Plus size={20} />
            </button>
          </div>
        </header>

        <div
          className="messages"
          ref={messagesRef}
          onScroll={(event) => {
            const target = event.currentTarget
            stickToBottomRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80
          }}
        >
          {activeSession ? (
            activeSession.messages.map((message) => (
              <ChatMessage
                key={message.id}
                session={activeSession}
                message={message}
                onDownload={(content) => downloadMessage(activeSession, { ...message, content })}
                onValidate={(content) =>
                  setMessageValidation(activeSession.id, message.id, validateSrt(content, activeSession.sourceText))
                }
                onRegenerate={() => regenerate(activeSession, message.id)}
              />
            ))
          ) : (
            <div className="welcome">
              <MessageSquare size={34} />
              <h1>导入字幕或直接开始翻译</h1>
              <p>左侧配置 API 与预设，底部选择一个或多个文件。多个文件会自动拆成同组下的多个会话。</p>
            </div>
          )}
          {activeSession &&
            (activeSession.status === 'queued' ||
              activeSession.status === 'connecting' ||
              activeSession.status === 'validating' ||
              activeSession.status === 'downloading') && (
            <div className="thinking-indicator">
              <Loader2 className="spin" size={16} />
              <span>
                {activeSession.status === 'queued'
                  ? '排队等待中...'
                  : activeSession.status === 'connecting'
                    ? '等待回复中...'
                    : activeSession.status === 'validating'
                      ? '正在校验 SRT 格式...'
                      : '校验通过，正在下载...'}
              </span>
            </div>
          )}
          {activeSession?.status === 'error' && <div className="error-banner">{activeSession.error}</div>}
        </div>

        <footer className="composer-wrap">
          {stagedFiles.length > 0 && (
            <div className="file-strip">
              {stagedFiles.map((file) => (
                <span className="file-chip" key={file.path || file.name} title={file.name}>
                  <span>{file.name}</span>
                  <button
                    type="button"
                    aria-label={`移除 ${file.name}`}
                    title="移除"
                    onClick={() => removeStagedFile(file.path || file.name)}
                  >
                    <XCircle size={12} />
                  </button>
                </span>
              ))}
              <button className="link-button" onClick={() => setStagedFiles([])}>
                清空
              </button>
            </div>
          )}
          {importNotice && <div className="import-notice">{importNotice}</div>}
          <div
            className={`composer ${composerDragActive ? 'drag-active' : ''}`}
            onDragEnter={handleComposerDragEnter}
            onDragOver={handleComposerDragOver}
            onDragLeave={handleComposerDragLeave}
            onDrop={handleComposerDrop}
          >
            {composerDragActive && (
              <div className="composer-drop-hint">
                <Upload size={18} />
                松开导入 SRT 或文件夹
              </div>
            )}
            <div className="composer-tools">
              <button className="icon-button large" onClick={chooseSrtSources} title="导入 SRT 文件">
                <Upload size={20} />
              </button>
              <button className="icon-button large" onClick={chooseSrtFolder} title="递归导入文件夹内所有 SRT">
                <FolderOpen size={20} />
              </button>
            </div>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={activeGroup?.settings?.mode === 'autoSrt' ? '输入翻译要求，回复完成后将自动校验并下载…' : '输入消息或翻译要求…'}
            />
            {isGenerating ? (
              <button
                className="send-button stop"
                onClick={async () => {
                  if (!activeSession) return
                  try {
                    await window.translator.cancelGeneration(activeSession.id)
                  } catch (err) {
                    console.error('cancel failed:', err)
                  }
                }}
                title="停止生成"
              >
                <Square size={16} />
              </button>
            ) : (
              <button className="send-button" disabled={!canSend} onClick={() => sendCurrentDraft()} title="发送">
                <Send size={19} />
              </button>
            )}
          </div>
        </footer>
      </main>
      {settingsGroup && config && (
        <GroupSettingsModal
          group={settingsGroup}
          globalConfig={config}
          onClose={() => setSettingsGroupId(null)}
          onSave={(title, settings) => {
            renameGroup(settingsGroup.id, title)
            updateGroupSettings(settingsGroup.id, settings)
            setSettingsGroupId(null)
          }}
          onChooseOutputDir={() => window.translator.selectOutputDir()}
        />
      )}
    </div>
  )
}

function PanelTitle({ icon, title }: { icon: React.ReactNode; title: string }): JSX.Element {
  return (
    <div className="panel-title">
      {icon}
      {title}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}

function SystemPromptEditor({
  value,
  onSave
}: {
  value: string
  onSave: (value: string) => void | Promise<void>
}): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const editorRef = useRef<HTMLElement | null>(null)
  const previewCloseTimerRef = useRef<number | null>(null)
  const [previewPosition, setPreviewPosition] = useState<CSSProperties | null>(null)
  const [editorPosition, setEditorPosition] = useState<CSSProperties | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const trimmedValue = value.trim()
  const previewText = trimmedValue || '尚未设置自定义系统提示词。点击此区域即可添加。'

  useEffect(() => {
    if (!editing) setDraft(value)
  }, [editing, value])

  useEffect(() => {
    return () => {
      if (previewCloseTimerRef.current) window.clearTimeout(previewCloseTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!editing) return

    function closeOnOutsideClick(event: MouseEvent): void {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || editorRef.current?.contains(target)) return
      setEditing(false)
    }

    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') setEditing(false)
    }

    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [editing])

  function cancelPreviewClose(): void {
    if (previewCloseTimerRef.current) {
      window.clearTimeout(previewCloseTimerRef.current)
      previewCloseTimerRef.current = null
    }
  }

  function schedulePreviewClose(): void {
    cancelPreviewClose()
    previewCloseTimerRef.current = window.setTimeout(() => {
      setPreviewPosition(null)
      previewCloseTimerRef.current = null
    }, 120)
  }

  function openPreview(clientX: number, clientY: number): void {
    if (editing) return
    cancelPreviewClose()
    if (previewPosition) return
    const width = Math.min(560, window.innerWidth - 24)
    const height = Math.min(440, window.innerHeight - 24)
    setPreviewPosition({
      left: Math.max(12, Math.min(clientX + 14, window.innerWidth - width - 12)),
      top: Math.max(12, Math.min(clientY + 14, window.innerHeight - height - 12)),
      width,
      maxHeight: height
    })
  }

  function openEditor(): void {
    const rect = triggerRef.current?.getBoundingClientRect()
    const width = Math.min(760, window.innerWidth - 24)
    const height = Math.min(640, window.innerHeight - 24)
    const preferredLeft = rect ? rect.right + 14 : 12
    const preferredTop = rect ? rect.top - 24 : 12
    setDraft(value)
    setPreviewPosition(null)
    setEditorPosition({
      left: Math.max(12, Math.min(preferredLeft, window.innerWidth - width - 12)),
      top: Math.max(12, Math.min(preferredTop, window.innerHeight - height - 12)),
      width,
      height
    })
    setEditing(true)
  }

  async function saveDraft(): Promise<void> {
    setSaving(true)
    try {
      await onSave(draft)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="system-prompt-editor">
      <button
        type="button"
        ref={triggerRef}
        className={`system-prompt-trigger ${trimmedValue ? 'has-content' : ''}`}
        onMouseEnter={(event) => openPreview(event.clientX, event.clientY)}
        onMouseLeave={schedulePreviewClose}
        onClick={openEditor}
      >
        <span>
          <strong>自定义系统提示词</strong>
          <small>{trimmedValue ? `${trimmedValue.length} 字 · 悬停预览，点击编辑` : '未设置 · 点击添加'}</small>
        </span>
        <span className="system-prompt-edit-hint">
          <Pencil size={13} />
          编辑
        </span>
      </button>

      {previewPosition && (
        <aside
          className="prompt-preview-card system-prompt-preview-card"
          style={previewPosition}
          onMouseEnter={cancelPreviewClose}
          onMouseLeave={schedulePreviewClose}
        >
          <header>
            <div>
              <strong>自定义系统提示词</strong>
              <small>会追加在导入预设之后</small>
            </div>
            <div className="prompt-preview-tags">
              <span>system</span>
              <span className={trimmedValue ? 'enabled' : 'disabled'}>{trimmedValue ? '已设置' : '未设置'}</span>
            </div>
          </header>
          <pre>{previewText}</pre>
        </aside>
      )}

      {editing && editorPosition && (
        <aside className="system-prompt-editor-card" ref={editorRef} style={editorPosition}>
          <header>
            <div>
              <strong>编辑系统提示词</strong>
              <small>这段内容会作为额外 system message 追加到预设提示词后。</small>
            </div>
            <button className="mini-icon" type="button" title="关闭" onClick={() => setEditing(false)}>
              <XCircle size={14} />
            </button>
          </header>
          <textarea
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="输入希望所有对话默认遵循的系统提示词..."
          />
          <footer>
            <span>{draft.trim().length} 字</span>
            <div>
              <button type="button" className="system-prompt-secondary" onClick={() => setEditing(false)}>
                取消
              </button>
              <button type="button" className="system-prompt-save" disabled={saving} onClick={saveDraft}>
                {saving ? <Loader2 className="spin" size={14} /> : <Save size={14} />}
                保存
              </button>
            </div>
          </footer>
        </aside>
      )}
    </div>
  )
}

function PromptPreviewItem({
  prompt,
  onEnabledChange
}: {
  prompt: PromptItem
  onEnabledChange: (enabled: boolean) => void
}): JSX.Element {
  const previewCloseTimerRef = useRef<number | null>(null)
  const [previewPosition, setPreviewPosition] = useState<CSSProperties | null>(null)

  useEffect(() => {
    return () => {
      if (previewCloseTimerRef.current) window.clearTimeout(previewCloseTimerRef.current)
    }
  }, [])

  function cancelPreviewClose(): void {
    if (previewCloseTimerRef.current) {
      window.clearTimeout(previewCloseTimerRef.current)
      previewCloseTimerRef.current = null
    }
  }

  function schedulePreviewClose(): void {
    cancelPreviewClose()
    previewCloseTimerRef.current = window.setTimeout(() => {
      setPreviewPosition(null)
      previewCloseTimerRef.current = null
    }, 120)
  }

  function openPreview(clientX: number, clientY: number): void {
    cancelPreviewClose()
    if (previewPosition) return
    const width = 420
    const height = 360
    setPreviewPosition({
      left: Math.max(12, Math.min(clientX + 14, window.innerWidth - width - 12)),
      top: Math.max(12, Math.min(clientY + 14, window.innerHeight - height - 12))
    })
  }

  return (
    <label
      className="prompt-item"
      onMouseEnter={(event) => openPreview(event.clientX, event.clientY)}
      onMouseLeave={schedulePreviewClose}
    >
      <input
        type="checkbox"
        checked={prompt.enabled}
        onChange={(event) => onEnabledChange(event.target.checked)}
      />
      <span>
        <strong>{prompt.name}</strong>
        <small>{prompt.role}</small>
      </span>
      {previewPosition && (
        <aside
          className="prompt-preview-card"
          style={previewPosition}
          onMouseEnter={cancelPreviewClose}
          onMouseLeave={schedulePreviewClose}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => event.preventDefault()}
        >
          <header>
            <div>
              <strong>{prompt.name}</strong>
              <small>{prompt.identifier}</small>
            </div>
            <div className="prompt-preview-tags">
              <span>{prompt.role}</span>
              <span className={prompt.enabled ? 'enabled' : 'disabled'}>{prompt.enabled ? '已启用' : '未启用'}</span>
            </div>
          </header>
          <pre>{prompt.content?.trim() || '此预设部件没有内容。'}</pre>
        </aside>
      )}
    </label>
  )
}

function ModelPicker({
  value,
  models,
  placeholder,
  allowClear = false,
  onChange
}: {
  value: string
  models: string[]
  placeholder: string
  allowClear?: boolean
  onChange: (value: string) => void
}): JSX.Element {
  const pickerRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const filteredModels = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return normalizedQuery
      ? models.filter((model) => model.toLocaleLowerCase().includes(normalizedQuery))
      : models
  }, [models, query])

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent): void {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    return () => document.removeEventListener('mousedown', closeOnOutsideClick)
  }, [])

  return (
    <div className="model-picker" ref={pickerRef}>
      <div className="model-picker-input">
        <input
          value={value}
          onFocus={() => setOpen(true)}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
        <button type="button" onClick={() => setOpen((current) => !current)} title="选择模型">
          <ChevronDown size={15} />
        </button>
      </div>
      {open && (
        <div className="model-picker-menu">
          <div className="model-picker-search">
            <Search size={14} />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索模型"
            />
          </div>
          <div className="model-picker-list">
            {filteredModels.map((model) => (
              <button
                type="button"
                className={model === value ? 'selected' : ''}
                key={model}
                title={model}
                onClick={() => {
                  onChange(model)
                  setOpen(false)
                }}
              >
                {model}
              </button>
            ))}
            {filteredModels.length === 0 && <div className="model-picker-empty">没有匹配的模型，可直接在上方输入 ID。</div>}
          </div>
          <div className="model-picker-footer">
            {allowClear ? (
              <button
                type="button"
                className="model-picker-clear"
                onClick={() => {
                  onChange('')
                  setOpen(false)
                }}
              >
                清空并继承全局
              </button>
            ) : (
              <span>{filteredModels.length} 个模型</span>
            )}
            {allowClear && <span>{filteredModels.length} 个模型</span>}
          </div>
        </div>
      )}
    </div>
  )
}

function SessionRow({
  session,
  active,
  onSelect,
  onRename,
  onDelete
}: {
  session: ChatSession
  active: boolean
  onSelect: () => void
  onRename: (title: string) => void
  onDelete: () => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(session.title)

  useEffect(() => setTitle(session.title), [session.title])

  return (
    <div className={`session-row ${active ? 'active' : ''}`} onClick={onSelect}>
      <StatusDot status={session.status} />
      {editing ? (
        <input
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            setEditing(false)
            onRename(title)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              setEditing(false)
              onRename(title)
            }
          }}
        />
      ) : (
        <button className="session-name" onDoubleClick={() => setEditing(true)}>
          {session.title}
        </button>
      )}
      <button
        className="mini-icon"
        title="重命名"
        onClick={(event) => {
          event.stopPropagation()
          setEditing(true)
        }}
      >
        <Pencil size={12} />
      </button>
      <button
        className="mini-icon delete-btn"
        title="删除会话"
        onClick={(event) => {
          event.stopPropagation()
          onDelete()
        }}
      >
        <Trash2 size={12} />
      </button>
    </div>
  )
}

function StatusDot({ status }: { status: ChatSession['status'] }): JSX.Element {
  if (status === 'streaming') return <Loader2 className="status-dot spin streaming" size={13} />
  if (status === 'connecting') return <Loader2 className="status-dot spin connecting" size={13} />
  if (status === 'queued') return <Play className="status-dot queued" size={12} />
  if (status === 'validating') return <ShieldCheck className="status-dot validating" size={13} />
  if (status === 'downloading') return <Download className="status-dot downloading" size={13} />
  if (status === 'error') return <XCircle className="status-dot error" size={13} />
  if (status === 'done') return <CheckCircle2 className="status-dot done" size={13} />
  return <span className="status-dot idle" />
}

function ChatMessage({
  session,
  message,
  onDownload,
  onValidate,
  onRegenerate
}: {
  session: ChatSession
  message: Message
  onDownload: (content: string) => void
  onValidate: (content: string) => void
  onRegenerate: () => void
}): JSX.Element {
  const assistant = message.role === 'assistant'
  const [feedback, setFeedback] = useState<string | null>(null)
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const wasActivelyThinking = useRef(false)

  const parsed = useMemo(() => parseThinking(message.content), [message.content])
  const thinking = message.reasoning || parsed.thinking || undefined
  const body = parsed.body
  const activelyThinking =
    assistant &&
    session.status === 'streaming' &&
    Boolean(thinking) &&
    !body.trim() &&
    (!parsed.hasThinkTag || !parsed.thinkClosed)

  useEffect(() => {
    if (activelyThinking) setReasoningOpen(true)
    else if (wasActivelyThinking.current) setReasoningOpen(false)
    wasActivelyThinking.current = activelyThinking
  }, [activelyThinking])

  function showFeedback(text: string): void {
    setFeedback(text)
    setTimeout(() => setFeedback(null), 1500)
  }

  return (
    <article className={`message ${message.role}`}>
      <div className="message-avatar">{assistant ? 'AI' : '你'}</div>
      <div className="message-body">
        {thinking && (
          <details
            className="reasoning-block"
            open={reasoningOpen}
            onToggle={(event) => setReasoningOpen(event.currentTarget.open)}
          >
            <summary>{activelyThinking ? '正在思考…' : '思考过程'}</summary>
            <pre>{thinking}</pre>
          </details>
        )}
        {body && <pre>{body}</pre>}
        {assistant && (
          <div className="message-actions">
            <button
              onClick={() => {
                navigator.clipboard.writeText(body)
                showFeedback('已复制')
              }}
              title="复制"
            >
              <Clipboard size={15} />
            </button>
            <button
              onClick={() => {
                onDownload(body)
                showFeedback('已下载')
              }}
              title="下载 SRT"
            >
              <Download size={15} />
            </button>
            <button onClick={() => onValidate(body)} title="校验 SRT">
              <ShieldCheck size={15} />
            </button>
            <button
              disabled={
                session.status === 'streaming' ||
                session.status === 'queued' ||
                session.status === 'connecting' ||
                session.status === 'validating' ||
                session.status === 'downloading'
              }
              onClick={onRegenerate}
              title="重新生成"
            >
              <RefreshCw size={15} />
            </button>
            {feedback && <span className="action-feedback">{feedback}</span>}
          </div>
        )}
        {message.validation && (
          <div className={`validation ${message.validation.ok ? 'ok' : 'bad'}`}>
            <strong>{message.validation.summary}</strong>
            {[...message.validation.errors, ...message.validation.warnings].map((item) => (
              <div key={item}>{item}</div>
            ))}
          </div>
        )}
      </div>
    </article>
  )
}

function GroupSettingsModal({
  group,
  globalConfig,
  onClose,
  onSave,
  onChooseOutputDir
}: {
  group: SessionGroup
  globalConfig: ApiConfig
  onClose: () => void
  onSave: (title: string, settings: GroupSettings) => void
  onChooseOutputDir: () => Promise<string | null>
}): JSX.Element {
  const [title, setTitle] = useState(group.title)
  const [mode, setMode] = useState<GroupSettings['mode']>(group.settings?.mode ?? 'conversation')
  const [model, setModel] = useState(group.settings?.model ?? '')
  const [concurrency, setConcurrency] = useState(group.settings?.concurrency?.toString() ?? '')
  const [outputDir, setOutputDir] = useState(group.settings?.outputDir ?? '')
  const [systemPrompt, setSystemPrompt] = useState(group.settings?.systemPrompt ?? '')

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="group-settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div>
            <span className="eyebrow">组设置</span>
            <input
              className="group-title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={group.title}
              aria-label="组名称"
            />
          </div>
          <button className="icon-button" onClick={onClose} title="关闭">
            <XCircle size={18} />
          </button>
        </header>

        <div className="mode-options">
          <label className={`mode-option ${mode === 'conversation' ? 'selected' : ''}`}>
            <input type="radio" name="group-mode" checked={mode === 'conversation'} onChange={() => setMode('conversation')} />
            <span>
              <strong>对话模式</strong>
              <small>保留当前工作流，回复完成即成功。</small>
            </span>
          </label>
          <label className={`mode-option ${mode === 'autoSrt' ? 'selected' : ''}`}>
            <input type="radio" name="group-mode" checked={mode === 'autoSrt'} onChange={() => setMode('autoSrt')} />
            <span>
              <strong>自动翻译字幕</strong>
              <small>完成后校验正文，校验通过才自动下载并标记成功。</small>
            </span>
          </label>
        </div>

        <div className="modal-fields">
          <Field label={`调用模型 · 留空继承全局 ${globalConfig.model || '未设置'}`}>
            <ModelPicker
              value={model}
              models={globalConfig.modelsCache?.[globalConfig.baseUrl] ?? []}
              onChange={setModel}
              placeholder={globalConfig.model || '选择或输入模型 ID'}
              allowClear
            />
          </Field>
          <Field label={`并发数 · 留空继承全局 ${globalConfig.concurrency}`}>
            <input
              type="number"
              min={1}
              value={concurrency}
              onChange={(event) => setConcurrency(event.target.value)}
              placeholder={String(globalConfig.concurrency)}
            />
          </Field>
          <Field label="下载目录 · 留空继承全局">
            <div className="path-row">
              <input value={outputDir} onChange={(event) => setOutputDir(event.target.value)} placeholder={globalConfig.outputDir} />
              <button
                className="icon-button bordered"
                title="选择目录"
                onClick={async () => {
                  const dir = await onChooseOutputDir()
                  if (dir) setOutputDir(dir)
                }}
              >
                <FolderOpen size={16} />
              </button>
            </div>
          </Field>
          <Field label="系统提示词 · 留空继承全局">
            <textarea
              className="group-system-prompt"
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              placeholder={globalConfig.customSystemPrompt}
            />
          </Field>
        </div>

        <footer className="modal-actions">
          <button className="ghost-button" onClick={onClose}>取消</button>
          <button
            className="primary-button"
            onClick={() =>
              onSave(
                title,
                {
                  mode,
                  model: model.trim() || undefined,
                  concurrency: concurrency.trim() ? Math.max(1, Math.floor(Number(concurrency) || 1)) : undefined,
                  outputDir: outputDir.trim() || undefined,
                  systemPrompt: systemPrompt.trim() || undefined
                }
              )
            }
          >
            保存组设置
          </button>
        </footer>
      </section>
    </div>
  )
}

function resolveRunSettings(groupId: string, config: ApiConfig, groups: SessionGroup[]): RunSettings {
  const settings = groups.find((group) => group.id === groupId)?.settings
  return {
    mode: settings?.mode ?? 'conversation',
    model: settings?.model?.trim() || config.model,
    concurrency: Math.max(1, Math.floor(settings?.concurrency ?? config.concurrency ?? 1)),
    outputDir: settings?.outputDir?.trim() || config.outputDir,
    systemPrompt: settings?.systemPrompt?.trim() || config.customSystemPrompt
  }
}

function isHistoryState(value: unknown): value is typeof emptyHistory {
  if (!value || typeof value !== 'object') return false
  const maybe = value as { groups?: unknown; sessions?: unknown }
  return Array.isArray(maybe.groups) && Boolean(maybe.sessions) && typeof maybe.sessions === 'object'
}
