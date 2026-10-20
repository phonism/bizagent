export type DashboardView = 'organization' | 'learning' | 'projects' | 'humanInbox'
export interface DashboardTarget {
  view?: DashboardView
  homeAddress?: string
  projectId?: string
  sessionId?: string
  assetId?: string
}

export interface BizAgentUiSnapshot {
  readonly open: boolean
  readonly revision: number
  readonly target?: DashboardTarget
}

export class BizAgentUiController {
  private snapshot: BizAgentUiSnapshot = Object.freeze({ open: false, revision: 0 })
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): BizAgentUiSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  open(target?: DashboardTarget): void {
    this.snapshot = Object.freeze({ open: true, revision: this.snapshot.revision + 1,
      ...(target ? { target } : {}) })
    for (const listener of [...this.listeners]) listener()
  }

  close(): void {
    this.setOpen(false)
  }

  toggle(): void {
    this.setOpen(!this.snapshot.open)
  }

  private setOpen(open: boolean): void {
    if (this.snapshot.open === open) return
    this.snapshot = Object.freeze({ open, revision: this.snapshot.revision + 1 })
    for (const listener of [...this.listeners]) listener()
  }
}
