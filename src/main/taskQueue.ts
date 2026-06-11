import type { BrowserWindow } from 'electron'
import type { StreamChunk } from './apiProxy'
import { streamChatCompletion } from './apiProxy'
import type { GenerationRequest } from './types'

type QueueTask = GenerationRequest

export class GenerationQueue {
  private queue: QueueTask[] = []
  private activeByGroup = new Map<string, number>()
  private requestTimestamps: number[] = []
  private timer: NodeJS.Timeout | null = null
  private controllers = new Map<string, AbortController>()

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  enqueue(task: QueueTask): void {
    this.queue.push(task)
    this.emit(task.sessionId, 'generation:status', {
      requestId: task.requestId,
      sessionId: task.sessionId,
      status: 'queued'
    })
    this.pump()
  }

  cancel(sessionId: string): void {
    const wasQueued = this.queue.some((t) => t.sessionId === sessionId)
    // Remove pending task from queue
    this.queue = this.queue.filter((t) => t.sessionId !== sessionId)
    // Abort running task (its catch block will emit the error)
    const controller = this.controllers.get(sessionId)
    if (controller) {
      controller.abort()
      this.controllers.delete(sessionId)
    } else if (wasQueued) {
      // Task was only queued, not running — must emit error here
      this.emit(sessionId, 'generation:error', {
        requestId: '',
        sessionId,
        error: '已取消'
      })
    }
  }

  private pump(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    while (this.queue.length > 0) {
      const nextIndex = this.queue.findIndex((task) => {
        const concurrency = Math.max(1, Math.floor(Number(task.config.concurrency) || 1))
        return (this.activeByGroup.get(task.groupId) ?? 0) < concurrency
      })
      if (nextIndex === -1) return
      const next = this.queue[nextIndex]

      const waitMs = this.rateLimitWaitMs(Math.max(1, Number(next.config.rpm) || 1))
      if (waitMs > 0) {
        this.timer = setTimeout(() => this.pump(), waitMs)
        return
      }

      this.queue.splice(nextIndex, 1)
      this.run(next)
    }
  }

  private rateLimitWaitMs(rpm: number): number {
    const now = Date.now()
    this.requestTimestamps = this.requestTimestamps.filter((timestamp) => now - timestamp < 60_000)
    if (this.requestTimestamps.length < rpm) return 0
    return Math.max(250, 60_000 - (now - this.requestTimestamps[0]))
  }

  private async run(task: QueueTask): Promise<void> {
    this.activeByGroup.set(task.groupId, (this.activeByGroup.get(task.groupId) ?? 0) + 1)
    this.requestTimestamps.push(Date.now())

    // Create abort controller for this task
    const controller = new AbortController()
    this.controllers.set(task.sessionId, controller)

    // Connecting: left queue, contacting API
    this.emit(task.sessionId, 'generation:status', {
      requestId: task.requestId,
      sessionId: task.sessionId,
      status: 'connecting'
    })

    let firstChunk = true

    try {
      await streamChatCompletion(task.config, task.messages, (chunk: StreamChunk) => {
        if (firstChunk) {
          firstChunk = false
          this.emit(task.sessionId, 'generation:status', {
            requestId: task.requestId,
            sessionId: task.sessionId,
            status: 'streaming'
          })
        }
        this.emit(task.sessionId, 'generation:chunk', {
          requestId: task.requestId,
          sessionId: task.sessionId,
          content: chunk.content,
          reasoning: chunk.reasoning
        })
      }, controller.signal)
      this.emit(task.sessionId, 'generation:done', {
        requestId: task.requestId,
        sessionId: task.sessionId
      })
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError'
      this.emit(task.sessionId, 'generation:error', {
        requestId: task.requestId,
        sessionId: task.sessionId,
        error: isAbort ? '已取消' : error instanceof Error ? error.message : '未知错误'
      })
    } finally {
      const remaining = (this.activeByGroup.get(task.groupId) ?? 1) - 1
      if (remaining > 0) this.activeByGroup.set(task.groupId, remaining)
      else this.activeByGroup.delete(task.groupId)
      this.controllers.delete(task.sessionId)
      this.pump()
    }
  }

  private emit(_sessionId: string, channel: string, payload: unknown): void {
    this.getWindow()?.webContents.send(channel, payload)
  }
}
