import { create } from 'zustand'
import type {
  ApiConfig,
  ChatSession,
  GroupSettings,
  HistoryState,
  ImportedFile,
  Message,
  Preset,
  SessionGroup,
  SessionStatus
} from '../types'
import { createId } from '../lib/id'

type AppStore = {
  ready: boolean
  sidebarCollapsed: boolean
  config: ApiConfig | null
  paths: { configPath: string; historyPath: string; defaultOutputDir: string } | null
  preset: Preset | null
  customSystemPrompt: string
  customSystemEnabled: boolean
  history: HistoryState
  draft: string
  stagedFiles: ImportedFile[]
  setReady: (ready: boolean) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setConfig: (config: ApiConfig) => void
  setPaths: (paths: AppStore['paths']) => void
  setPreset: (preset: Preset | null) => void
  updatePromptEnabled: (identifier: string, enabled: boolean) => void
  setCustomSystemPrompt: (value: string) => void
  setCustomSystemEnabled: (enabled: boolean) => void
  setHistory: (history: HistoryState) => void
  setDraft: (draft: string) => void
  setStagedFiles: (files: ImportedFile[]) => void
  createGroupWithSessions: (instruction: string, files: ImportedFile[]) => ChatSession[]
  createEmptyGroup: () => void
  addUserMessage: (sessionId: string, content: string) => void
  addFilesToGroup: (groupId: string, instruction: string, files: ImportedFile[]) => ChatSession[]
  deleteSession: (sessionId: string) => void
  deleteGroup: (groupId: string) => void
  rollbackToMessage: (sessionId: string, messageId: string) => void
  setActiveSession: (sessionId: string) => void
  toggleGroup: (groupId: string) => void
  updateGroupSettings: (groupId: string, settings: GroupSettings) => void
  renameGroup: (groupId: string, title: string) => void
  renameSession: (sessionId: string, title: string) => void
  updateSessionStatus: (sessionId: string, status: SessionStatus, error?: string) => void
  appendAssistantChunk: (sessionId: string, requestId: string, content: string, reasoning: string) => void
  finishAssistant: (sessionId: string, requestId: string) => void
  setMessageValidation: (sessionId: string, messageId: string, validation: Message['validation']) => void
}

export const emptyHistory: HistoryState = {
  groups: [],
  sessions: {}
}

export const useAppStore = create<AppStore>((set, get) => ({
  ready: false,
  sidebarCollapsed: false,
  config: null,
  paths: null,
  preset: null,
  customSystemPrompt:
    '你是专业字幕与文本翻译助手。翻译 SRT 时必须保留序号、时间轴和空行结构，只翻译字幕文本，不添加解释。',
  customSystemEnabled: true,
  history: emptyHistory,
  draft: '',
  stagedFiles: [],
  setReady: (ready) => set({ ready }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setConfig: (config) => set({ config }),
  setPaths: (paths) => set({ paths }),
  setPreset: (preset) => set({ preset }),
  updatePromptEnabled: (identifier, enabled) =>
    set((state) => ({
      preset: state.preset
        ? {
            ...state.preset,
            prompts: state.preset.prompts.map((prompt) =>
              prompt.identifier === identifier ? { ...prompt, enabled } : prompt
            )
          }
        : state.preset
    })),
  setCustomSystemPrompt: (customSystemPrompt) => set({ customSystemPrompt }),
  setCustomSystemEnabled: (customSystemEnabled) => set({ customSystemEnabled }),
  setHistory: (history) => set({ history }),
  setDraft: (draft) => set({ draft }),
  setStagedFiles: (stagedFiles) => set({ stagedFiles }),
  createGroupWithSessions: (instruction, files) => {
    const now = Date.now()
    const groupId = createId('group')
    const inputs = files.length > 0 ? files : []
    const sessions: ChatSession[] =
      inputs.length > 0
        ? inputs.map((file) => makeSession(groupId, instruction, file, now))
        : [makeSession(groupId, instruction, undefined, now)]

    const group: SessionGroup = {
      id: groupId,
      title: `${new Date(now).toLocaleString()} ${sessions.length > 1 ? '批量翻译' : '翻译'}`,
      createdAt: now,
      sessionIds: sessions.map((session) => session.id),
      expanded: true
    }

    set((state) => ({
      history: {
        groups: [group, ...state.history.groups],
        sessions: {
          ...sessions.reduce<Record<string, ChatSession>>((acc, session) => {
            acc[session.id] = session
            return acc
          }, {}),
          ...state.history.sessions
        },
        activeSessionId: sessions[0]?.id
      },
      stagedFiles: []
    }))

    return sessions
  },
  createEmptyGroup: () => {
    const now = Date.now()
    const groupId = createId('group')
    const session = makeSession(groupId, '', undefined, now)

    const group: SessionGroup = {
      id: groupId,
      title: `${new Date(now).toLocaleString()} 新任务`,
      createdAt: now,
      sessionIds: [session.id],
      expanded: true
    }

    set((state) => ({
      history: {
        groups: [group, ...state.history.groups],
        sessions: { [session.id]: session, ...state.history.sessions },
        activeSessionId: session.id
      }
    }))
  },
  addUserMessage: (sessionId, content) =>
    set((state) => {
      const session = state.history.sessions[sessionId]
      if (!session) return state

      const userMessage: Message = {
        id: createId('msg'),
        role: 'user',
        content,
        createdAt: Date.now()
      }

      return {
        history: {
          ...state.history,
          sessions: updateSession(state.history.sessions, sessionId, {
            messages: [...session.messages, userMessage],
            instruction: session.instruction || content,
            updatedAt: Date.now()
          })
        }
      }
    }),
  addFilesToGroup: (groupId, instruction, files) => {
    const state = get()
    const group = state.history.groups.find((g) => g.id === groupId)
    if (!group || files.length === 0) return []

    const now = Date.now()
    const sessions = files.map((file) => makeSession(groupId, instruction, file, now))

    set((s) => ({
      history: {
        ...s.history,
        groups: s.history.groups.map((g) =>
          g.id === groupId ? { ...g, sessionIds: [...g.sessionIds, ...sessions.map((sess) => sess.id)] } : g
        ),
        sessions: {
          ...sessions.reduce<Record<string, ChatSession>>((acc, sess) => {
            acc[sess.id] = sess
            return acc
          }, {}),
          ...s.history.sessions
        }
      }
    }))

    return sessions
  },
  deleteSession: (sessionId) =>
    set((state) => {
      const session = state.history.sessions[sessionId]
      if (!session) return state

      // Remove session from its group's sessionIds, delete group if empty
      const groups = state.history.groups
        .map((g) =>
          g.id === session.groupId ? { ...g, sessionIds: g.sessionIds.filter((id) => id !== sessionId) } : g
        )
        .filter((g) => g.sessionIds.length > 0)

      // Remove session from sessions map
      const { [sessionId]: _, ...remainingSessions } = state.history.sessions

      // Determine new activeSessionId
      let nextActiveId = state.history.activeSessionId
      if (nextActiveId === sessionId) {
        // Try another session from another group, or clear
        const firstGroup = groups[0]
        nextActiveId = firstGroup?.sessionIds[0]
      }

      return {
        history: {
          ...state.history,
          groups,
          sessions: remainingSessions,
          activeSessionId: nextActiveId
        }
      }
    }),
  deleteGroup: (groupId) =>
    set((state) => {
      const group = state.history.groups.find((g) => g.id === groupId)
      if (!group) return state

      // Remove all sessions belonging to this group
      const remainingSessions = { ...state.history.sessions }
      for (const sid of group.sessionIds) {
        delete remainingSessions[sid]
      }

      // Remove group
      const groups = state.history.groups.filter((g) => g.id !== groupId)

      // Clear activeSessionId if it was in this group
      const nextActiveId =
        state.history.activeSessionId && group.sessionIds.includes(state.history.activeSessionId)
          ? undefined
          : state.history.activeSessionId

      return {
        history: {
          ...state.history,
          groups,
          sessions: remainingSessions,
          activeSessionId: nextActiveId
        }
      }
    }),
  rollbackToMessage: (sessionId, messageId) =>
    set((state) => {
      const session = state.history.sessions[sessionId]
      if (!session) return state

      const idx = session.messages.findIndex((m) => m.id === messageId)
      if (idx === -1) return state

      return {
        history: {
          ...state.history,
          sessions: updateSession(state.history.sessions, sessionId, {
            messages: session.messages.slice(0, idx),
            status: 'idle' as SessionStatus,
            updatedAt: Date.now()
          })
        }
      }
    }),
  setActiveSession: (sessionId) =>
    set((state) => ({
      history: { ...state.history, activeSessionId: sessionId }
    })),
  toggleGroup: (groupId) =>
    set((state) => ({
      history: {
        ...state.history,
        groups: state.history.groups.map((group) =>
          group.id === groupId ? { ...group, expanded: !group.expanded } : group
        )
      }
    })),
  updateGroupSettings: (groupId, settings) =>
    set((state) => ({
      history: {
        ...state.history,
        groups: state.history.groups.map((group) => (group.id === groupId ? { ...group, settings } : group))
      }
    })),
  renameGroup: (groupId, title) =>
    set((state) => ({
      history: {
        ...state.history,
        groups: state.history.groups.map((group) =>
          group.id === groupId ? { ...group, title: title.trim() || group.title } : group
        )
      }
    })),
  renameSession: (sessionId, title) =>
    set((state) => ({
      history: {
        ...state.history,
        sessions: {
          ...state.history.sessions,
          [sessionId]: {
            ...state.history.sessions[sessionId],
            title: title.trim() || state.history.sessions[sessionId].title,
            updatedAt: Date.now()
          }
        }
      }
    })),
  updateSessionStatus: (sessionId, status, error) =>
    set((state) => ({
      history: {
        ...state.history,
        sessions: updateSession(state.history.sessions, sessionId, {
          status,
          error,
          updatedAt: Date.now()
        })
      }
    })),
  appendAssistantChunk: (sessionId, requestId, content, reasoning) =>
    set((state) => {
      const session = state.history.sessions[sessionId]
      if (!session) return state

      const messages = [...session.messages]
      const last = messages[messages.length - 1]
      if (last?.role === 'assistant' && last.requestId === requestId) {
        messages[messages.length - 1] = {
          ...last,
          content: last.content + content,
          reasoning: (last.reasoning ?? '') + reasoning
        }
      } else {
        messages.push({
          id: createId('msg'),
          role: 'assistant',
          content,
          reasoning: reasoning || undefined,
          createdAt: Date.now(),
          requestId
        })
      }

      return {
        history: {
          ...state.history,
          sessions: updateSession(state.history.sessions, sessionId, {
            messages,
            updatedAt: Date.now()
          })
        }
      }
    }),
  finishAssistant: (sessionId, _requestId) => get().updateSessionStatus(sessionId, 'done'),
  setMessageValidation: (sessionId, messageId, validation) =>
    set((state) => {
      const session = state.history.sessions[sessionId]
      if (!session) return state

      return {
        history: {
          ...state.history,
          sessions: updateSession(state.history.sessions, sessionId, {
            messages: session.messages.map((message) =>
              message.id === messageId ? { ...message, validation } : message
            ),
            updatedAt: Date.now()
          })
        }
      }
    })
}))

function makeSession(groupId: string, instruction: string, file: ImportedFile | undefined, now: number): ChatSession {
  const id = createId('session')
  const hasContent = Boolean(instruction.trim() || file)
  return {
    id,
    groupId,
    title: file?.name || '零散翻译',
    fileName: file?.name,
    sourceText: file?.content,
    instruction,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    messages: hasContent
      ? [
          {
            id: createId('msg'),
            role: 'user' as const,
            content: file ? `${instruction}\n\n已导入文件：${file.name}` : instruction,
            createdAt: now,
            fileName: file?.name
          }
        ]
      : []
  }
}

function updateSession(
  sessions: Record<string, ChatSession>,
  sessionId: string,
  patch: Partial<ChatSession>
): Record<string, ChatSession> {
  const session = sessions[sessionId]
  if (!session) return sessions
  return {
    ...sessions,
    [sessionId]: {
      ...session,
      ...patch
    }
  }
}
