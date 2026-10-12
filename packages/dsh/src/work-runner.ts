import { realpath, stat } from 'node:fs/promises'
import type { Agent, AgentHandle, AgentOptions, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { freezeMessage, type MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { ResolvedConfig } from './config.js'
import { nowIso, stableId } from './domain.js'
import type { BizAgentService } from './service.js'
import type { FormalWork } from './work-ledger.js'
import { renderProjectSeatContext, type ProjectSeatContext } from './project-seat-context.js'

type AgentFactory = Pick<AgentRegistry, 'get' | 'create' | 'resume'>
type SessionCatalog = Pick<SessionQueryEngine, 'listSessions' | 'readSession'>
type RecoveryResult = { recovered: string[]; failed: { workId: string; error: unknown }[] }
const RECOVERY_BATCH_MAX = 4
const RECOVERY_RETRY_DELAY_MS = 5 * 60_000

export class WorkRunner {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly starting = new Map<string, Promise<Record<string, unknown>>>()
  private readonly recoveredInProcess = new Set<string>()
  private readonly recoveryRetryAfter = new Map<string, number>()
  private readonly supplementing = new Map<string, Promise<'queued' | 'already-queued' | 'pending'>>()
  private readonly supplementTails = new Map<string, Promise<unknown>>()
  private supplementRecoveryOffset = 0
  private reservedRecovery: Promise<RecoveryResult> | undefined
  private queuedRecovery: Promise<RecoveryResult> | undefined
  private recoveryBatch: Promise<{ reserved: RecoveryResult; queued: RecoveryResult }> | undefined
  private closing = false

  constructor(
    private readonly agents: AgentFactory,
    private readonly sessions: SessionCatalog,
    private readonly service: BizAgentService,
    private readonly config: ResolvedConfig,
    private readonly defaultModel?: () => AgentOptions,
  ) {}

  async start(requester: Agent, workId: string): Promise<Record<string, unknown>> {
    if (this.closing) throw new Error('Work runner is closing')
    await this.service.readWork(requester, workId)
    const binding = this.service.ledger.getBinding(String(requester.id))
    const work = this.service.workLedger?.get(workId)
    if (work === undefined || binding?.homeAddress !== work.requester) {
      throw new Error('only the Work requester may start its worker')
    }
    return this.activateOnce(work)
  }

  async deliverSupplement(workId: string, supplementId: string): Promise<'queued' | 'already-queued' | 'pending'> {
    if (this.closing) return 'pending'
    const existing = this.supplementing.get(supplementId)
    if (existing !== undefined) return existing
    const task = this.supplementTails.get(workId)?.catch(() => undefined)
      .then(() => this.queueSupplement(workId, supplementId))
      ?? this.queueSupplement(workId, supplementId)
    this.supplementing.set(supplementId, task)
    this.supplementTails.set(workId, task)
    try { return await task } finally {
      if (this.supplementing.get(supplementId) === task) this.supplementing.delete(supplementId)
      if (this.supplementTails.get(workId) === task) this.supplementTails.delete(workId)
    }
  }

  /** Retry retained supplements after worker reservation, including manually accepted Work. */
  async recoverSupplements(limit = RECOVERY_BATCH_MAX): Promise<RecoveryResult> {
    checkRecoveryLimit(limit)
    const recovered: string[] = []
    const failed: { workId: string; error: unknown }[] = []
    const candidates = (this.service.workLedger?.list() ?? [])
      .filter(work => ['open', 'accepted'].includes(work.status) && work.projectId !== undefined
        && !this.service.projectExecutionPaused(work.projectId) && work.workerSessionId !== undefined)
      .flatMap(work => (work.supplements ?? []).map(supplement => ({ workId: work.id, id: supplement.id })))
    const count = Math.min(limit, candidates.length)
    for (let i = 0; i < count && !this.closing; i++) {
      const candidate = candidates[(this.supplementRecoveryOffset + i) % candidates.length]!
      try {
        const result = await this.deliverSupplement(candidate.workId, candidate.id)
        if (result === 'queued') recovered.push(candidate.id)
      } catch (error) { failed.push({ workId: candidate.workId, error }) }
    }
    if (candidates.length > 0) this.supplementRecoveryOffset = (this.supplementRecoveryOffset + count) % candidates.length
    return { recovered, failed }
  }

  private async queueSupplement(workId: string, supplementId: string): Promise<'queued' | 'already-queued' | 'pending'> {
    const work = this.service.workLedger?.get(workId)
    const supplement = work?.supplements?.find(item => item.id === supplementId)
    if (work === undefined || supplement === undefined || work.projectId === undefined) {
      throw new Error('Project Work supplement is missing')
    }
    if (!['open', 'accepted'].includes(work.status) || this.service.projectExecutionPaused(work.projectId)
      || work.workerSessionId === undefined) return 'pending'
    const sessionId = work.workerSessionId as SessionId
    const binding = this.service.ledger.getBinding(sessionId)
    if (binding === undefined || binding.homeAddress !== work.assignee) {
      throw new Error('Project Work worker Session binding does not match its assignee')
    }
    const promptId = stableId('project-work-supplement-prompt', supplement.id) as MessageId
    let worker = this.agents.get(sessionId)
    if (worker === undefined) {
      const records = await this.sessions.listSessions()
      const record = records.find(item => item.header.id === sessionId)
      if (record === undefined || !record.persisted) return 'pending'
      const snapshot = await this.sessions.readSession(sessionId)
      if (String(snapshot.session.id) !== sessionId || (binding.cwd !== undefined
        && snapshot.session.cwd !== binding.cwd)) {
        throw new Error('Persisted Project Work worker Session differs from its binding')
      }
      if (snapshot.events.some(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === promptId))) return 'already-queued'
      const handle = await this.agents.resume({ resumeSessionId: sessionId })
      this.handles.set(work.id, handle)
      worker = handle.agent
    }
    if (String(worker.id) !== sessionId || (binding.cwd !== undefined
      && worker.session.header.cwd !== binding.cwd)) {
      throw new Error('Project Work worker Session identity or Workspace changed')
    }
    const wasSent = worker.session.events.some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.id === promptId))
      || worker.inbox.nextTurn.some(message => message.id === promptId)
      || worker.inbox.nextStep.some(message => message.id === promptId)
    if (wasSent) return 'already-queued'
    const current = this.service.workLedger?.get(workId)
    if (current === undefined || !['open', 'accepted'].includes(current.status)
      || current.workerSessionId !== sessionId || this.service.projectExecutionPaused(work.projectId)) {
      return 'pending'
    }
    worker.followup(freezeMessage({
      id: promptId, role: 'user',
      content: [{ type: 'text', text: [
        `Project ${work.projectId} supplement for existing Work ${work.id} (epoch ${supplement.epoch}):`,
        supplement.message,
        '',
        'Continue in this Work Session. This supplement does not replace the goal or acceptance criteria.',
        'If it changes direction or dependencies, ask the Project lead to pause and revise the plan.',
      ].join('\n') }],
      source: { kind: 'plugin', plugin: 'bizagent', form: 'relay' },
    }))
    return 'queued'
  }

  /** Bounded pass: restore reserved Sessions before starting queued Work. */
  async recoverBatch(limit = RECOVERY_BATCH_MAX): Promise<{ reserved: RecoveryResult; queued: RecoveryResult }> {
    checkRecoveryLimit(limit)
    if (this.recoveryBatch) return this.recoveryBatch
    const task = (async () => {
      const reserved = await this.recoverReserved(limit)
      const remaining = limit - reserved.recovered.length - reserved.failed.length
      const queued = remaining > 0 ? await this.recoverQueued(remaining) : { recovered: [], failed: [] }
      return { reserved, queued }
    })()
    this.recoveryBatch = task
    try {
      return await task
    } finally {
      if (this.recoveryBatch === task) this.recoveryBatch = undefined
    }
  }

  /** Restart only Work whose worker Session was already durably reserved. */
  async recoverReserved(limit = RECOVERY_BATCH_MAX): Promise<RecoveryResult> {
    checkRecoveryLimit(limit)
    if (this.reservedRecovery) return this.reservedRecovery
    const task = this.runReservedRecovery(limit)
    this.reservedRecovery = task
    try {
      return await task
    } finally {
      if (this.reservedRecovery === task) this.reservedRecovery = undefined
    }
  }

  private async runReservedRecovery(limit: number): Promise<RecoveryResult> {
    const recovered: string[] = []
    const failed: { workId: string; error: unknown }[] = []
    const now = Date.now()
    const candidates = this.service.workLedger?.list()
      .filter(work => (work.status === 'open' || work.status === 'accepted')
        && (work.projectId === undefined || !this.service.projectExecutionPaused(work.projectId))
        && work.workerCwd !== undefined
        && work.workerSessionId === stableId('work-session', work.id)
        && !this.recoveredInProcess.has(work.id)
        && (this.recoveryRetryAfter.get(work.id) ?? 0) <= now)
      .reverse() ?? []
    let attempted = 0
    for (const candidate of candidates) {
      if (this.closing || attempted >= limit) break
      const current = this.service.workLedger?.get(candidate.id)
      if (!current || (current.status !== 'open' && current.status !== 'accepted')) continue
      attempted++
      try {
        await this.activateOnce(current)
        this.recoveryRetryAfter.delete(candidate.id)
        recovered.push(candidate.id)
      } catch (error) {
        this.recoveryRetryAfter.set(candidate.id, Date.now() + RECOVERY_RETRY_DELAY_MS)
        failed.push({ workId: candidate.id, error })
      }
    }
    return { recovered, failed }
  }

  /** Fill the dispatch-to-reservation crash window for Work that froze automatic launch intent. */
  async recoverQueued(limit = RECOVERY_BATCH_MAX): Promise<RecoveryResult> {
    checkRecoveryLimit(limit)
    if (this.queuedRecovery) return this.queuedRecovery
    const task = this.runQueuedRecovery(limit)
    this.queuedRecovery = task
    try {
      return await task
    } finally {
      if (this.queuedRecovery === task) this.queuedRecovery = undefined
    }
  }

  private async runQueuedRecovery(limit: number): Promise<RecoveryResult> {
    const recovered: string[] = []
    const failed: { workId: string; error: unknown }[] = []
    const now = Date.now()
    const candidates = this.service.workLedger?.list()
      .filter(work => work.status === 'open' && work.autoStart === true
        && (work.projectId === undefined || !this.service.projectExecutionPaused(work.projectId))
        && work.workerSessionId === undefined && work.workerCwd === undefined
        && !this.recoveredInProcess.has(work.id)
        && (this.recoveryRetryAfter.get(work.id) ?? 0) <= now)
      .reverse() ?? []
    let attempted = 0
    for (const candidate of candidates) {
      if (this.closing || attempted >= limit) break
      const current = this.service.workLedger?.get(candidate.id)
      if (!current || current.status !== 'open' || current.workerSessionId !== undefined) continue
      attempted++
      try {
        await this.activateOnce(current)
        this.recoveryRetryAfter.delete(candidate.id)
        recovered.push(candidate.id)
      } catch (error) {
        this.recoveryRetryAfter.set(candidate.id, Date.now() + RECOVERY_RETRY_DELAY_MS)
        failed.push({ workId: candidate.id, error })
      }
    }
    return { recovered, failed }
  }

  private async activateOnce(work: FormalWork): Promise<Record<string, unknown>> {
    if (this.closing) throw new Error('Work runner is closing')
    const workId = work.id
    const pending = this.starting.get(workId)
    if (pending !== undefined) return pending
    const task = this.activate(work)
    this.starting.set(workId, task)
    try {
      const result = await task
      this.recoveredInProcess.add(workId)
      return result
    } finally {
      if (this.starting.get(workId) === task) this.starting.delete(workId)
    }
  }

  private async activate(work: FormalWork): Promise<Record<string, unknown>> {
    if (work.projectId !== undefined && this.service.projectExecutionPaused(work.projectId)) {
      throw new Error('Project is paused; Work worker cannot start')
    }
    const ledger = this.service.workLedger
    if (ledger === undefined) throw new Error('formal Work ledger is unavailable')
    const notice = this.service.ledger.getInboxMessage(work.requestMessageId)
    const receipt = this.service.ledger.getInboxDelivery(work.requestMessageId, work.assignee)
    if (notice?.kind !== 'work-request' || notice.fromAddress !== work.requester
      || notice.returnToSessionId !== work.returnToSessionId
      || !notice.to.includes(work.assignee) || receipt?.status !== 'delivered') {
      throw new Error('Work request notification is not delivered to its assignee')
    }
    if (this.service.store.getHome(work.assignee).status !== 'active') {
      throw new Error(`Work assignee Home is not active: ${work.assignee}`)
    }
    const seatContext = work.assigneeSeatAddress === undefined ? undefined
      : this.service.projectSeatContextForAddress(work.assigneeSeatAddress)
    if (work.assigneeSeatAddress !== undefined && (seatContext === undefined
      || seatContext.projectId !== work.projectId || seatContext.homeAddress !== work.assignee)) {
      throw new Error('Work Project Seat is no longer active for its assignee Home')
    }
    const mapping = this.config.workspaceHomes.find(item => item.address === work.assignee)
    if (mapping === undefined) throw new Error(`no DSH Workspace is mapped to Work assignee ${work.assignee}`)
    const info = await stat(mapping.root)
    if (!info.isDirectory() || await realpath(mapping.root) !== mapping.root) {
      throw new Error(`Work assignee Workspace is not a real directory: ${mapping.root}`)
    }
    const sessionId = stableId('work-session', work.id) as SessionId
    const reserved = await ledger.withWrite(async () => {
      const current = ledger.get(work.id)
      if (current === undefined) throw new Error(`Work not found: ${work.id}`)
      if (current.status !== 'open' && current.status !== 'accepted') {
        throw new Error(`Work cannot start from ${current.status}`)
      }
      if (current.workerSessionId !== undefined && current.workerSessionId !== sessionId) {
        throw new Error('Work belongs to another worker Session')
      }
      if (current.workerCwd !== undefined && current.workerCwd !== mapping.root) {
        throw new Error('Work worker Workspace changed after its first start')
      }
      if (current.workerSessionId !== undefined) return current
      const model = current.workerOptions ?? this.defaultModel?.()
      const next: FormalWork = {
        ...current, workerSessionId: sessionId, workerCwd: mapping.root,
        ...(model === undefined ? {} : { workerOptions: model }), updatedAt: nowIso(),
      }
      await ledger.put(next)
      return next
    })
    const existingBinding = this.service.ledger.getBinding(sessionId)
    if (existingBinding !== undefined && (existingBinding.homeAddress !== reserved.assignee
      || existingBinding.cwd !== mapping.root)) {
      throw new Error('Work worker Session binding conflicts with the reserved Home or Workspace')
    }
    await this.service.ledger.putBinding({
      sessionId, homeAddress: reserved.assignee, cwd: mapping.root, boundAt: existingBinding?.boundAt ?? nowIso(),
    })
    await this.service.ledger.putInboxWakeOrigin({
      schemaVersion: 1, sessionId, homeAddress: reserved.assignee,
      topicId: reserved.requestMessageId, hop: 0,
      wakePlanId: reserved.id, createdAt: reserved.createdAt,
    })

    let handle = this.handles.get(work.id)
    if (handle !== undefined && this.agents.get(sessionId) !== handle.agent) {
      this.handles.delete(work.id)
      handle = undefined
    }
    let worker = handle?.agent ?? this.agents.get(sessionId)
    let source = worker === undefined ? 'created' : 'live'
    if (worker === undefined) {
      const records = await this.sessions.listSessions()
      const record = records.find(item => item.header.id === sessionId)
      if (record !== undefined && !record.persisted) {
        throw new Error('Work worker Session is listed but cannot be resumed from persistence')
      }
      const agentOptions: AgentOptions | undefined = reserved.workerOptions === undefined ? undefined : {
        ...(reserved.workerOptions.provider !== undefined ? { provider: reserved.workerOptions.provider } : {}),
        ...(reserved.workerOptions.model !== undefined ? { model: reserved.workerOptions.model } : {}),
        ...(reserved.workerOptions.maxTokens !== undefined ? { maxTokens: reserved.workerOptions.maxTokens } : {}),
      }
      handle = record === undefined
        ? await this.agents.create({
          sessionId, meta: { cwd: mapping.root },
          ...(agentOptions !== undefined ? { agentOptions } : {}),
        })
        : await this.agents.resume({
          resumeSessionId: sessionId,
          ...(agentOptions !== undefined ? { agentOptions } : {}),
        })
      this.handles.set(work.id, handle)
      worker = handle.agent
      source = record === undefined ? 'created' : 'resumed'
    }
    try {
      if (worker.session.header.cwd !== mapping.root) {
        throw new Error('Work worker Session Workspace differs from its reserved mapping')
      }
      // Project participation is recorded from an active turn. A newly created
      // worker has no turn until the queued Work prompt starts, so it accepts
      // Project Work through the Agent tool in that turn.
      if (work.projectId === undefined) await this.service.acceptWork(worker, work.id)
    } catch (error) {
      if (handle !== undefined && this.handles.get(work.id) === handle) {
        this.handles.delete(work.id)
        await handle.dispose()
      }
      throw error
    }
    const promptId = stableId('work-prompt', work.id) as MessageId
    const wasSent = worker.session.events.some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.id === promptId))
      || worker.inbox.nextTurn.some(message => message.id === promptId)
      || worker.inbox.nextStep.some(message => message.id === promptId)
    if (work.projectId !== undefined && this.service.projectExecutionPaused(work.projectId)) {
      worker.cancel({ kind: 'hook', reason: `Project ${work.projectId} paused` })
      if (handle !== undefined) this.releaseWhenIdle(work.id)
      throw new Error('Project paused before its Work worker prompt was sent')
    }
    if (!wasSent) {
      worker.followup(freezeMessage({
        id: promptId,
        role: 'user',
        content: [{ type: 'text', text: renderWorkPrompt(work, seatContext) }],
        source: { kind: 'plugin', plugin: 'bizagent', form: 'relay' },
      }))
    }
    return {
      work: ledger.get(work.id), workerSessionId: sessionId,
      activation: source, promptMessageId: promptId, promptAlreadySent: wasSent,
    }
  }

  releaseWhenIdle(workId: string): void {
    const handle = this.handles.get(workId)
    if (handle === undefined) return
    void handle.agent.whenIdle().then(async () => {
      const status = this.service.workLedger?.get(workId)?.status
      if (status !== 'completed' && status !== 'cancelled') return
      if (this.handles.get(workId) !== handle) return
      this.handles.delete(workId)
      await handle.dispose()
    }).catch(error => this.service.recordRuntimeError(`Work worker ${workId}`, error))
  }

  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled([
      ...(this.recoveryBatch === undefined ? [] : [this.recoveryBatch]),
      ...(this.reservedRecovery === undefined ? [] : [this.reservedRecovery]),
      ...(this.queuedRecovery === undefined ? [] : [this.queuedRecovery]),
      ...this.starting.values(),
      ...this.supplementing.values(),
    ])
    const handles = [...this.handles.values()]
    this.handles.clear()
    const results = await Promise.allSettled(handles.map(handle => handle.dispose()))
    for (const result of results) {
      if (result.status === 'rejected') this.service.recordRuntimeError('Work worker dispose', result.reason)
    }
  }
}

function renderWorkPrompt(work: FormalWork, seatContext?: ProjectSeatContext): string {
  return [
    '# Formal Work assigned to this Agent Home',
    `Work ID: ${work.id}`,
    `Requester: ${work.requester}`,
    `Request message ID: ${work.requestMessageId}`,
    ...(seatContext === undefined ? [] : ['', renderProjectSeatContext(seatContext)]),
    '',
    `Goal: ${work.goal}`,
    'Acceptance criteria:',
    work.acceptanceCriteria,
    '',
    'Inspect the request with bizagent_inbox_read and the responsibility with bizagent_work_read.',
    ...(work.projectId === undefined ? [] : ['Accept this Project Work with bizagent_work_accept in this turn before completing it.']),
    'Do the work in this Session. Return one concrete result with bizagent_work_complete.',
    'An ordinary Inbox reply does not complete formal Work.',
  ].join('\n')
}

function checkRecoveryLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RECOVERY_BATCH_MAX) {
    throw new Error(`Work recovery limit must be between 1 and ${RECOVERY_BATCH_MAX}`)
  }
}
