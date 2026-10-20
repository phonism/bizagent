import type { UiSessionContext, UiSessionSummary, UiHumanInboxList } from '../ui-contract.js'
import type { BizAgentUiPort } from './api.js'

export interface ResourceState<T> {
  data?: T
  error?: string
  loading: boolean
}

/** One request and timer per resource, shared by every surface showing that Session. */
export class SessionResource<T> {
  private snapshot: ResourceState<T> = { loading: false }
  private listeners = new Set<() => void>()
  private request: AbortController | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly fetchValue: (signal: AbortSignal) => Promise<T>, private readonly interval = 8000) {}

  getSnapshot = (): ResourceState<T> => this.snapshot
  get active(): boolean { return this.listeners.size > 0 }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      void this.refresh()
      this.timer = setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void this.refresh()
      }, this.interval)
    }
    return () => {
      this.listeners.delete(listener)
      if (!this.active) this.stop()
    }
  }

  refresh = async (): Promise<void> => {
    if (this.request) return
    const abort = new AbortController()
    this.request = abort
    this.set({ ...this.snapshot, loading: true })
    try {
      const data = await this.fetchValue(abort.signal)
      if (!abort.signal.aborted) this.set({ data, loading: false })
    } catch (error) {
      if (!abort.signal.aborted) this.set({ ...this.snapshot, loading: false,
        error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (this.request === abort) this.request = undefined
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.request?.abort()
    this.request = undefined
  }
  private set(snapshot: ResourceState<T>): void {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) listener()
  }
}

export class SessionSurfaces {
  readonly catalog: SessionResource<{ sessions: UiSessionSummary[] }>
  readonly inbox: SessionResource<UiHumanInboxList | undefined>
  private contexts = new Map<string, SessionResource<UiSessionContext>>()
  constructor(private readonly api: BizAgentUiPort) {
    this.catalog = new SessionResource(signal => api.sessionCatalog(signal), 15000)
    this.inbox = new SessionResource(signal => api.humanInbox('incoming', true, undefined, signal), 20000)
  }
  context(sessionId: string): SessionResource<UiSessionContext> {
    let resource = this.contexts.get(sessionId)
    if (!resource) {
      // Keep active readers; discard old, unobserved Sessions after navigation.
      for (const [id, entry] of this.contexts) {
        if (this.contexts.size < 50) break
        if (!entry.active) { entry.stop(); this.contexts.delete(id) }
      }
      resource = new SessionResource(signal => this.api.sessionContext(sessionId, signal))
      this.contexts.set(sessionId, resource)
    }
    return resource
  }
  dispose(): void {
    this.catalog.stop()
    this.inbox.stop()
    for (const resource of this.contexts.values()) resource.stop()
  }
}
