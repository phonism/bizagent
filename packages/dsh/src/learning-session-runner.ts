import { realpath, stat } from 'node:fs/promises'
import type { Agent, AgentHandle, AgentOptions, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { freezeMessage, type MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { ResolvedConfig } from './config.js'
import type { ResolvedLearningSchedule } from './config.js'
import { nowIso, stableId, type LearningLaunch } from './domain.js'
import { summarizeLearningUsage } from './learning-usage.js'
import type { BizAgentService } from './service.js'

type AgentFactory = Pick<AgentRegistry, 'get' | 'create' | 'resume'>
type SessionCatalog = Pick<SessionQueryEngine, 'listSessions' | 'readSession'>
const RECOVERY_MAX = 4
const RETRY_DELAY_MS = 5 * 60_000

/** Explicit, Home-bound launcher for dedicated learning Sessions. Unknown creation is never retried blindly. */
export class LearningSessionRunner {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly activating = new Map<string, Promise<Record<string, unknown>>>()
  private readonly watching = new Set<string>()
  private readonly recoveryRetryAfter = new Map<string, number>()
  private closing = false

  constructor(
    private readonly agents: AgentFactory,
    private readonly sessions: SessionCatalog,
    private readonly service: BizAgentService,
    private readonly config: ResolvedConfig,
  ) {}

  async request(agent: Agent, idempotencyKey: string, model?: string): Promise<Record<string, unknown>> {
    const selectedModel = model?.trim() || agent.options?.model
    const selectedProvider = agent.options?.provider
    const selectedMaxTokens = agent.options?.maxTokens
    const binding = this.service.bindSession(String(agent.id), agent.session.header.cwd)
    if (!binding) throw new Error('learning launch requires a bound Agent Home')
    await this.service.ledger.putBinding(binding)
    return this.requestFor(binding.homeAddress, String(agent.id), idempotencyKey,
      { ...(selectedProvider ? { provider: selectedProvider } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(selectedMaxTokens ? { maxTokens: selectedMaxTokens } : {}) }, 'explicit')
  }

  /** Trusted host scheduler entrypoint. The occurrence is part of the persistent launch identity. */
  async requestScheduled(schedule: ResolvedLearningSchedule, dueAt: number,
    scheduleFingerprint: string, requestedAt = Date.now(), policyRevision = 0): Promise<Record<string, unknown>> {
    if (!Number.isSafeInteger(dueAt) || dueAt < 0) throw new Error('invalid learning schedule due time')
    if (!Number.isSafeInteger(requestedAt) || requestedAt < dueAt) throw new Error('learning schedule is not due')
    const base = this.config.learningSchedules?.find(item => item.home === schedule.home)
    const policy = this.service.ledger.getLearningSchedulePolicy(schedule.home)
    const expected = base === undefined ? undefined : policy === undefined ? base
      : { ...base, cron: policy.cron, dailyRuns: policy.dailyRuns }
    if (!this.config.learningSchedulerEnabled || policy?.enabled === false
      || (policy?.revision ?? 0) !== policyRevision
      || expected === undefined || JSON.stringify(expected) !== JSON.stringify(schedule)
      || scheduleFingerprint !== stableId('learning-schedule', JSON.stringify({ schedule,
        revision: policyRevision }))) {
      throw new Error('learning schedule is not configured for this host')
    }
    return this.requestFor(schedule.home, `engine:learning-scheduler:${schedule.home}`,
      stableId('learning-period', `${scheduleFingerprint}:${dueAt}`),
      { ...(schedule.provider ? { provider: schedule.provider } : {}), model: schedule.model,
        ...(schedule.maxTokens ? { maxTokens: schedule.maxTokens } : {}) },
      'schedule', dueAt, requestedAt)
  }

  private async requestFor(homeAddress: LearningLaunch['homeAddress'], requestedBySessionId: string,
    idempotencyKey: string, route: { provider?: string; model?: string; maxTokens?: number },
    trigger: 'explicit' | 'schedule', scheduledFor?: number,
    requestedAt?: number): Promise<Record<string, unknown>> {
    if (this.closing) throw new Error('learning Session runner is closing')
    const key = idempotencyKey.trim()
    if (!key || key.length > 128) throw new Error('learning launch idempotency key must contain 1 to 128 characters')
    if (route.model && route.model.length > 200) throw new Error('learning launch model is too long')
    if (this.service.store.getHome(homeAddress).status !== 'active') throw new Error('learning launch Home is not active')
    const mapping = this.config.workspaceHomes.find(item => item.address === homeAddress)
    if (!mapping) throw new Error(`no DSH Workspace is mapped to learning Home ${homeAddress}`)
    await realDirectory(mapping.root)
    const id = stableId('learning-launch', `${homeAddress}:${key}`)
    const { launch, created } = await this.service.ledger.withLearningBatchWrite(async () => {
      const existing = this.service.ledger.getLearningLaunch(id)
      if (existing) {
        if (existing.requestedBySessionId !== requestedBySessionId || existing.model !== route.model
          || existing.provider !== route.provider || existing.maxTokens !== route.maxTokens
          || (existing.trigger ?? 'explicit') !== trigger || existing.scheduledFor !== scheduledFor) {
          throw new Error('learning launch idempotency key belongs to another request')
        }
        return { launch: existing, created: false }
      }
      if (this.service.ledger.listLearningLaunches(homeAddress)
        .some(item => ['reserved', 'active', 'needs_review'].includes(item.status))) {
        throw new Error('current Home has an unresolved learning Session launch')
      }
      if (this.service.ledger.listLearningBatches(homeAddress).some(run => run.status === 'open')) {
        throw new Error('current Home already has an open learning batch')
      }
      const now = requestedAt === undefined ? nowIso() : new Date(requestedAt).toISOString()
      const launch = await this.service.ledger.putLearningLaunch({
        schemaVersion: 1, id, homeAddress,
        requestedBySessionId,
        workerSessionId: stableId('learning-session', id),
        workspace: mapping.root, promptMessageId: stableId('learning-prompt', id),
        ...(route.provider ? { provider: route.provider } : {}),
        ...(route.model ? { model: route.model } : {}),
        ...(route.maxTokens ? { maxTokens: route.maxTokens } : {}),
        trigger,
        ...(scheduledFor !== undefined ? { scheduledFor } : {}),
        status: 'reserved', createdAt: now, updatedAt: now,
      })
      return { launch, created: true }
    })
    if (!created) return launch.status === 'reserved'
      ? this.activateOnce(launch, false) : this.view(launch)
    try { return await this.activateOnce(launch, true) }
    catch (error) {
      try {
        const live = this.agents.get(launch.workerSessionId as SessionId)
        const record = live ? undefined : (await this.sessions.listSessions())
          .find(item => String(item.header.id) === launch.workerSessionId)
        if (!live && !record) {
          await this.markNeedsReview(launch, `factory failed and no worker Session was found: ${message(error)}`)
        }
      } catch { /* An unavailable catalog leaves the reservation uncertain. */ }
      throw new Error(`learning launch ${id} has an uncertain start; inspect its status: ${message(error)}`, { cause: error })
    }
  }

  async read(agent: Agent, id: string): Promise<Record<string, unknown>> {
    const binding = this.service.bindSession(String(agent.id), agent.session.header.cwd)
    if (!binding) throw new Error('learning launch read requires a bound Agent Home')
    await this.service.ledger.putBinding(binding)
    const launch = this.service.ledger.getLearningLaunch(id)
    if (launch?.homeAddress !== binding.homeAddress) throw new Error('learning launch is not in current Home')
    const view = this.view(launch)
    const workerBinding = this.service.ledger.getBinding(launch.workerSessionId)
    if (workerBinding?.homeAddress !== launch.homeAddress || workerBinding.cwd !== launch.workspace) {
      return { ...view, usage: { status: 'unavailable', reason: 'worker Session is not bound to this Home' } }
    }
    try {
      const snapshot = await this.sessions.readSession(launch.workerSessionId as SessionId)
      if (String(snapshot.session.id) !== launch.workerSessionId || snapshot.session.cwd !== launch.workspace) {
        return { ...view, usage: { status: 'unavailable', reason: 'worker Session identity or Workspace mismatch' } }
      }
      return { ...view, usage: summarizeLearningUsage(snapshot.events) }
    } catch {
      return { ...view, usage: { status: 'unavailable', reason: 'worker Session is not readable' } }
    }
  }

  async abandon(agent: Agent, id: string, reason: string): Promise<Record<string, unknown>> {
    const binding = this.service.bindSession(String(agent.id), agent.session.header.cwd)
    if (!binding) throw new Error('learning launch resolution requires a bound Agent Home')
    await this.service.ledger.putBinding(binding)
    const explanation = reason.trim()
    if (!explanation || explanation.length > 2000) throw new Error('learning launch abandonment needs a reason')
    return this.service.ledger.withLearningBatchWrite(async () => {
      const launch = this.service.ledger.getLearningLaunch(id)
      if (launch?.homeAddress !== binding.homeAddress) throw new Error('learning launch is not in current Home')
      if (launch.status === 'abandoned') return this.view(launch)
      if (launch.status !== 'needs_review') throw new Error('only a launch needing review may be abandoned')
      if (this.agents.get(launch.workerSessionId as SessionId)) {
        throw new Error('learning worker Session is live; inspect it before abandoning the launch')
      }
      if (this.service.ledger.listLearningBatches(binding.homeAddress)
        .some(run => run.reviewerSessionId === launch.workerSessionId && run.status === 'open')) {
        throw new Error('learning worker has an open batch; settle or abandon that batch first')
      }
      const updated = await this.service.ledger.putLearningLaunch({ ...launch,
        status: 'abandoned', reason: explanation, updatedAt: nowIso() })
      return this.view(updated)
    })
  }

  /** On restart, only an already visible worker Session may be resumed. */
  async recoverBatch(limit = RECOVERY_MAX): Promise<{ recovered: string[]; needsReview: string[]; failed: Array<{ id: string; error: unknown }> }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > RECOVERY_MAX) {
      throw new Error(`learning Session recovery limit must be between 1 and ${RECOVERY_MAX}`)
    }
    const recovered: string[] = []
    const needsReview: string[] = []
    const failed: Array<{ id: string; error: unknown }> = []
    for (const launch of this.service.ledger.listLearningLaunches()
      .filter(item => (item.status === 'reserved' || item.status === 'active')
        && !this.watching.has(item.id)
        && (this.recoveryRetryAfter.get(item.id) ?? 0) <= Date.now())
      .reverse().slice(0, limit)) {
      if (this.closing) break
      if (this.activating.has(launch.id)) continue
      try {
        const result = await this.activateOnce(launch, false)
        this.recoveryRetryAfter.delete(launch.id)
        if ((result.launch as LearningLaunch).status === 'needs_review') needsReview.push(launch.id)
        else recovered.push(launch.id)
      } catch (error) {
        this.recoveryRetryAfter.set(launch.id, Date.now() + RETRY_DELAY_MS)
        failed.push({ id: launch.id, error })
      }
    }
    return { recovered, needsReview, failed }
  }

  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.activating.values()])
    const handles = [...this.handles.values()]
    this.handles.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
  }

  private activateOnce(launch: LearningLaunch, allowCreate: boolean): Promise<Record<string, unknown>> {
    const pending = this.activating.get(launch.id)
    if (pending) return pending
    const task = this.activate(launch, allowCreate)
    this.activating.set(launch.id, task)
    void task.finally(() => { if (this.activating.get(launch.id) === task) this.activating.delete(launch.id) }).catch(() => {})
    return task
  }

  private async activate(launch: LearningLaunch, allowCreate: boolean): Promise<Record<string, unknown>> {
    if (this.closing) throw new Error('learning Session runner is closing')
    const current = this.service.ledger.getLearningLaunch(launch.id)
    if (!current || !['reserved', 'active'].includes(current.status)) return this.view(current ?? launch)
    if (this.service.store.getHome(current.homeAddress).status !== 'active') {
      return this.markNeedsReview(current, 'learning Home is no longer active')
    }
    try { await realDirectory(current.workspace) }
    catch (error) { return this.markNeedsReview(current, `learning Workspace is unavailable: ${message(error)}`) }
    const mapping = this.config.workspaceHomes.find(item => item.address === current.homeAddress)
    if (mapping?.root !== current.workspace) {
      return this.markNeedsReview(current, 'learning Workspace mapping changed')
    }
    const sessionId = current.workerSessionId as SessionId
    const oldBinding = this.service.ledger.getBinding(sessionId)
    if (oldBinding && (oldBinding.homeAddress !== current.homeAddress || oldBinding.cwd !== current.workspace)) {
      throw new Error('learning worker Session binding conflicts with its reservation')
    }
    await this.service.ledger.putBinding({ sessionId, homeAddress: current.homeAddress,
      cwd: current.workspace, boundAt: oldBinding?.boundAt ?? nowIso() })
    let handle = this.handles.get(current.id)
    if (handle && this.agents.get(sessionId) !== handle.agent) {
      this.handles.delete(current.id)
      handle = undefined
    }
    let worker = handle?.agent ?? this.agents.get(sessionId)
    let resumedPersisted = false
    if (!worker) {
      const record = (await this.sessions.listSessions()).find(item => String(item.header.id) === sessionId)
      if (record && !record.persisted) return this.markNeedsReview(current, 'learning Session exists but is not persisted')
      if (!record && !allowCreate) return this.markNeedsReview(current, 'reserved learning Session is absent after restart')
      const agentOptions: AgentOptions | undefined = current.model || current.provider || current.maxTokens
        ? { ...(current.provider ? { provider: current.provider } : {}),
          ...(current.model ? { model: current.model } : {}),
          ...(current.maxTokens ? { maxTokens: current.maxTokens } : {}) }
        : undefined
      handle = record
        ? await this.agents.resume({ resumeSessionId: sessionId,
          ...(agentOptions ? { agentOptions } : {}) })
        : await this.agents.create({ sessionId, meta: { cwd: current.workspace },
          ...(agentOptions ? { agentOptions } : {}) })
      resumedPersisted = Boolean(record)
      this.handles.set(current.id, handle)
      worker = handle.agent
    }
    if (worker.session.header.cwd !== current.workspace) {
      if (handle) { this.handles.delete(current.id); await handle.dispose() }
      return this.markNeedsReview(current, 'learning Session Workspace differs from its reservation')
    }
    const batch = this.service.ledger.listLearningBatches(current.homeAddress)
      .find(run => run.reviewerSessionId === current.workerSessionId)
    if (batch?.status === 'completed') {
      const complete = await this.service.ledger.putLearningLaunch({ ...current,
        status: 'completed', updatedAt: nowIso() })
      this.releaseWhenIdle(current.id)
      return this.view(complete)
    }
    if (batch?.status === 'abandoned') return this.markNeedsReview(current, 'learning batch was abandoned')
    const promptId = current.promptMessageId as MessageId
    const wasSent = hasPrompt(worker, promptId)
    if (!wasSent) {
      worker.followup(freezeMessage({
        id: promptId, role: 'user',
        content: [{ type: 'text', text: renderPrompt(current) }],
        source: { kind: 'plugin', plugin: 'bizagent', form: 'relay' },
      }))
    }
    if (resumedPersisted && wasSent && batch?.status === 'open') {
      const resumeId = stableId('learning-resume-prompt', current.id) as MessageId
      if (!hasPrompt(worker, resumeId)) {
        worker.followup(freezeMessage({
          id: resumeId, role: 'user',
          content: [{ type: 'text', text: renderResumePrompt(current, batch.id) }],
          source: { kind: 'plugin', plugin: 'bizagent', form: 'relay' },
        }))
      }
    }
    const active = this.service.ledger.getLearningLaunch(current.id)
    const updated = active?.status === 'completed' ? active : await this.service.ledger.putLearningLaunch({
      ...current, status: 'active', updatedAt: nowIso(),
    })
    this.watch(updated, worker)
    return { ...this.view(updated), promptAlreadySent: wasSent, workerStatus: worker.status }
  }

  private watch(launch: LearningLaunch, worker: Agent): void {
    if (this.watching.has(launch.id)) return
    this.watching.add(launch.id)
    void worker.whenIdle().then(async () => {
      const current = this.service.ledger.getLearningLaunch(launch.id)
      if (!current || !['reserved', 'active'].includes(current.status)) return
      const batch = this.service.ledger.listLearningBatches(current.homeAddress)
        .find(run => run.reviewerSessionId === current.workerSessionId)
      if (batch?.status === 'completed') {
        await this.service.ledger.putLearningLaunch({ ...current, status: 'completed', updatedAt: nowIso() })
      } else {
        const recent = worker.session.events.slice(-6).map(event => event.type).join(', ')
        const pending = worker.inbox.nextTurn.length + worker.inbox.nextStep.length
        await this.markNeedsReview(current,
          `learning Session became idle without a completed batch (recent events: ${recent || 'none'}; pending messages: ${pending})`)
      }
    }).catch(async (error) => {
      this.service.recordRuntimeError(`learning worker ${launch.id}`, error)
      await this.markNeedsReview(launch, `learning Session idle status failed: ${message(error)}`)
    })
      .finally(async () => {
        this.watching.delete(launch.id)
        const handle = this.handles.get(launch.id)
        if (handle) { this.handles.delete(launch.id); await handle.dispose() }
      }).catch(error => this.service.recordRuntimeError(`learning worker cleanup ${launch.id}`, error))
  }

  private releaseWhenIdle(id: string): void {
    const handle = this.handles.get(id)
    if (!handle) return
    void handle.agent.whenIdle().then(async () => {
      if (this.handles.get(id) === handle) { this.handles.delete(id); await handle.dispose() }
    }).catch(error => this.service.recordRuntimeError(`learning worker dispose ${id}`, error))
  }

  private async markNeedsReview(launch: LearningLaunch, reason: string): Promise<Record<string, unknown>> {
    const current = this.service.ledger.getLearningLaunch(launch.id)
    if (!current || !['reserved', 'active'].includes(current.status)) return this.view(current ?? launch)
    const updated = await this.service.ledger.putLearningLaunch({ ...current,
      status: 'needs_review', reason, updatedAt: nowIso() })
    return this.view(updated)
  }

  private view(launch: LearningLaunch): Record<string, unknown> {
    const batch = this.service.ledger.listLearningBatches(launch.homeAddress)
      .find(run => run.reviewerSessionId === launch.workerSessionId)
    return { launch, batch }
  }
}

async function realDirectory(path: string): Promise<void> {
  const info = await stat(path)
  if (!info.isDirectory() || await realpath(path) !== path) throw new Error(`learning Workspace is not a real directory: ${path}`)
}

function renderPrompt(launch: LearningLaunch): string {
  return [
    '# Dedicated learning review for this Agent Home',
    `Launch ID: ${launch.id}`,
    `Home: ${launch.homeAddress}`,
    'Call bizagent_learning_batch_start in this Session. If no material is pending, report that and stop.',
    'For each frozen material, inspect Session events with bizagent_episode_read or the exact authored Worklog revision with bizagent_worklog_read.',
    'Use bizagent_learning_batch_settle to record a reasoned no-change review or evidence-backed candidates.',
    'Session candidates cite original event sequence fields; Worklog candidates omit those fields and cite their frozen revision. All remain candidates until later review and publication.',
    'When all materials are settled, call bizagent_learning_batch_finish with action complete.',
    'A conversation ending without the completion receipt leaves this launch needing review.',
  ].join('\n')
}

function renderResumePrompt(launch: LearningLaunch, batchId: string): string {
  return [
    '# Continue the interrupted learning review in this same Session',
    `Launch ID: ${launch.id}`,
    `Open batch ID: ${batchId}`,
    'First call bizagent_learning_batch_status for this batch. If it is completed, stop.',
    'For each pending material, read its Session evidence with bizagent_episode_read or exact Worklog with bizagent_worklog_read,',
    'then call bizagent_learning_batch_settle with a reasoned no-change review or evidence-backed candidates.',
    'Do not start a new batch or repeat materials already settled in this batch.',
    'When all frozen materials are settled, call bizagent_learning_batch_finish with action complete.',
  ].join('\n')
}

function hasPrompt(worker: Agent, id: MessageId): boolean {
  return worker.session.events.some(event => event.type === 'agent/inbox/spliced'
    && event.data.inserted.some(item => item.id === id))
    || worker.inbox.nextTurn.some(item => item.id === id)
    || worker.inbox.nextStep.some(item => item.id === id)
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
