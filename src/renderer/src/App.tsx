import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clipboard,
  Download,
  FilePlus2,
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
import type { ApiConfig, ChatSession, GroupSettings, Message, PromptItem, SessionGroup } from './types'

type RunSettings = {
  mode: GroupSettings['mode']
  model: string
  concurrency: number
  outputDir: string
  systemPrompt: string
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

  async function chooseFiles(): Promise<void> {
    const files = await window.translator.selectFiles()
    if (files.length) setStagedFiles(files)
  }

  async function chooseSrtFolder(): Promise<void> {
    const files = await window.translator.selectSrtFolder()
    if (files.length) setStagedFiles(files)
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
        const newSessions = createGroupWithSessions(instruction, files)
        for (const session of newSessions) {
          await startGeneration(session)
        }
      }
    } else if (activeSession) {
      // Continue existing conversation with multi-turn context
      const prevMessages = activeSession.messages
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
      const newSessions = createGroupWithSessions(instruction, [])
      for (const session of newSessions) {
        await startGeneration(session)
      }
    }
  }

  async function startGeneration(session: ChatSession): Promise<void> {
    if (!config) return
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
      updateSessionStatus(sessionId, 'error', `自动校验失败：${validation.summary}`)
      return
    }

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
                  </div>

                  {/* 预设与提示词 */}
                  <div className="panel">
                    <PanelTitle icon={<ListTree size={16} />} title="预设与提示词" />
                    <button className="soft-button" onClick={importPreset}>
                      <Upload size={15} />
                      导入预设 JSON
                    </button>
                    <textarea
                      className="system-prompt"
                      value={customSystemPrompt}
                      onChange={(event) => handleSetCustomSystemPrompt(event.target.value)}
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
              {activeGroup ? `${activeGroup.title} · ` : ''}{activeSession?.title || '新翻译'}
              {activeGroup?.settings?.mode === 'autoSrt' && <span className="mode-badge">自动字幕</span>}
            </div>
            <div className="chat-subtitle">
              {statusSummary || ' '}
            </div>
          </div>
          <button className="icon-button" onClick={createEmptyGroup} title="新建对话">
            <Plus size={20} />
          </button>
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
                <span className="file-chip" key={file.path || file.name}>
                  {file.name}
                </span>
              ))}
              <button className="link-button" onClick={() => setStagedFiles([])}>
                清空
              </button>
            </div>
          )}
          <div className="composer">
            <div className="composer-tools">
              <button className="icon-button large" onClick={chooseFiles} title="批量导入文件">
                <FilePlus2 size={20} />
              </button>
              <button className="icon-button large" onClick={chooseSrtFolder} title="递归导入文件夹内所有 SRT">
                <FolderOpen size={20} />
              </button>
            </div>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
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

function PromptPreviewItem({
  prompt,
  onEnabledChange
}: {
  prompt: PromptItem
  onEnabledChange: (enabled: boolean) => void
}): JSX.Element {
  const [previewPosition, setPreviewPosition] = useState<{ left: number; top: number } | null>(null)

  function positionPreview(clientX: number, clientY: number): void {
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
      onMouseEnter={(event) => positionPreview(event.clientX, event.clientY)}
      onMouseMove={(event) => positionPreview(event.clientX, event.clientY)}
      onMouseLeave={() => setPreviewPosition(null)}
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
        <aside className="prompt-preview-card" style={previewPosition}>
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
