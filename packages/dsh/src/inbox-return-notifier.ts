import type { Agent, AgentHandle, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { freezeMessage, type MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { isHomeAddress, isProjectSeatAddress, nowIso, stableId,
  type HomeAddress, type ProjectSeatAddress, type InboxMessage } from './domain.js'
import type { LearningLedger } from './ledger.js'

type AgentFactory = Pick<AgentRegistry, 'get' | 'resume'>
type SessionCatalog = Pick<SessionQueryEngine, 'listSessions' | 'readSession'>
type ReturnPass = { queued: string[]; fallback: string[]; failed: { messageId: string; error: unknown }[] }
type AgentInboxAddress = HomeAddress | ProjectSeatAddress
const MAX_PER_PASS = 4
const RETRY_DELAY_MS = 5 * 60_000

/** A reply to the original sender returns to that letter's exact DSH Session. */
export class InboxReturnNotifier {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly attaching = new Map<string, Promise<Agent>>()
  private readonly retryAfter = new Map<string, number>()
  private pass: Promise<ReturnPass> | undefined
  private closing = false

  constructor(private readonly agents: AgentFactory, private readonly sessions: SessionCatalog,
    private readonly ledger: LearningLedger,
    private readonly onError: (sessionId: string, error: unknown) => void = () => {},
    private readonly recipientHome: (address: AgentInboxAddress) => HomeAddress | undefined
      = address => isHomeAddress(address) ? address : undefined) {}

  async recoverBatch(limit = MAX_PER_PASS, now = Date.now()): Promise<ReturnPass> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PER_PASS) {
      throw new Error(`Inbox return pass limit must be between 1 and ${MAX_PER_PASS}`)
    }
    if (this.closing) return { queued: [], fallback: [], failed: [] }
    if (this.pass) return this.pass
    const task = this.runPass(limit, now)
    this.pass = task
    try { return await task } finally { if (this.pass === task) this.pass = undefined }
  }

  private async runPass(limit: number, now: number): Promise<ReturnPass> {
    const queued: string[] = []
    const fallback: string[] = []
    const failed: { messageId: string; error: unknown }[] = []
    let attempted = 0
    const messages = this.ledger.listInboxMessages().reverse()
    for (const message of messages) {
      if (this.closing || attempted >= limit) break
      const recipient = replyReturnRecipient(this.ledger, message)
      if (recipient === undefined) continue
      if (this.ledger.getInboxDelivery(message.id, recipient)?.handledAt !== undefined) continue
      const destination = inboxReturnDestination(this.ledger, message, recipient)
      if (destination === undefined) continue
      const route = this.ledger.getInboxReturnRoute(message.id, recipient)
      if (route?.status === 'fallback' || (this.retryAfter.get(message.id) ?? 0) > now) continue
      if (route?.status === 'queued' && await this.wasQueued(message, recipient, destination)) continue
      attempted++
      try {
        const result = await this.deliver(message, recipient, destination)
        if (result === 'queued') queued.push(message.id)
        else fallback.push(message.id)
        this.retryAfter.delete(message.id)
      } catch (error) {
        this.retryAfter.set(message.id, now + RETRY_DELAY_MS)
        failed.push({ messageId: message.id, error })
      }
    }
    return { queued, fallback, failed }
  }

  private async deliver(message: InboxMessage, recipient: AgentInboxAddress,
    destination: string): Promise<'queued' | 'fallback'> {
    let agent: Agent
    try {
      const home = this.recipientHome(recipient)
      if (home === undefined) throw new Error('return-to recipient Seat has no Home')
      agent = await this.attach(destination, home)
    }
    catch (error) {
      await this.ledger.putInboxReturnRoute({
        schemaVersion: 1, messageId: message.id, recipient, sessionId: destination,
        status: 'fallback', reason: error instanceof Error ? error.message : String(error), updatedAt: nowIso(),
      })
      return 'fallback'
    }
    try {
      if (!hasPrompt(agent, message, recipient)) {
        agent.followup(freezeMessage({
          id: returnPromptId(message, recipient), role: 'user',
          content: [{ type: 'text', text: renderReturnPrompt(message) }],
          source: { kind: 'plugin', plugin: 'bizagent', form: 'relay' },
        }))
      }
      await this.ledger.putInboxReturnRoute({
        schemaVersion: 1, messageId: message.id, recipient, sessionId: destination,
        status: 'queued', updatedAt: nowIso(),
      })
      return 'queued'
    } finally { this.releaseWhenIdle(destination) }
  }

  private async wasQueued(message: InboxMessage, recipient: AgentInboxAddress, destination: string): Promise<boolean> {
    const live = this.agents.get(destination as SessionId)
    const cwd = this.ledger.getBinding(destination)?.cwd
    if (live !== undefined) {
      return String(live.id) === destination && (cwd === undefined || live.session.header.cwd === cwd)
        && hasPrompt(live, message, recipient)
    }
    try {
      const snapshot = await this.sessions.readSession(destination as SessionId)
      return String(snapshot.session.id) === destination
        && (cwd === undefined || snapshot.session.cwd === cwd)
        && snapshot.events.some(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(item => item.id === returnPromptId(message, recipient)))
    } catch { return false }
  }

  private async attach(sessionId: string, recipient: HomeAddress): Promise<Agent> {
    const binding = this.ledger.getBinding(sessionId)
    if (binding?.homeAddress !== recipient) throw new Error('return-to Session binding is unavailable or changed')
    const owned = this.handles.get(sessionId)
    if (owned && this.agents.get(sessionId as SessionId) !== owned.agent) {
      this.handles.delete(sessionId)
      await owned.dispose()
    }
    const live = this.agents.get(sessionId as SessionId)
    if (live) {
      if (String(live.id) !== sessionId || (binding.cwd !== undefined && live.session.header.cwd !== binding.cwd)) {
        throw new Error('live return-to Session identity or Workspace differs from binding')
      }
      return live
    }
    const pending = this.attaching.get(sessionId)
    if (pending) return pending
    const task = this.resume(sessionId, binding.cwd)
    this.attaching.set(sessionId, task)
    try { return await task } finally { if (this.attaching.get(sessionId) === task) this.attaching.delete(sessionId) }
  }

  private async resume(sessionId: string, cwd: string | undefined): Promise<Agent> {
    const record = (await this.sessions.listSessions()).find(item => String(item.header.id) === sessionId)
    if (!record?.persisted) throw new Error('return-to Session is not available in persistence')
    if (cwd !== undefined && record.header.cwd !== cwd) throw new Error('persisted return-to Workspace differs from binding')
    const handle = await this.agents.resume({ resumeSessionId: sessionId as SessionId })
    if (String(handle.agent.id) !== sessionId || (cwd !== undefined && handle.agent.session.header.cwd !== cwd)) {
      await handle.dispose()
      throw new Error('resumed return-to Session identity or Workspace differs from binding')
    }
    this.handles.set(sessionId, handle)
    return handle.agent
  }

  private releaseWhenIdle(sessionId: string): void {
    const handle = this.handles.get(sessionId)
    if (!handle) return
    void handle.agent.whenIdle().then(async () => {
      if (this.handles.get(sessionId) !== handle) return
      this.handles.delete(sessionId)
      await handle.dispose()
    }).catch(error => this.onError(sessionId, error))
  }

  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...(this.pass ? [this.pass] : []), ...this.attaching.values()])
    const handles = [...this.handles.values()]
    this.handles.clear()
    for (const result of await Promise.allSettled(handles.map(handle => handle.dispose()))) {
      if (result.status === 'rejected') this.onError('close', result.reason)
    }
  }
}

export function inboxReturnDestination(ledger: LearningLedger, message: InboxMessage,
  recipient: AgentInboxAddress): string | undefined {
  if (message.kind !== 'ordinary' || message.replyTo === undefined || !message.to.includes(recipient)) return undefined
  const parent = ledger.getInboxMessage(message.replyTo)
  if (parent === undefined || (parent.returnAddress ?? parent.fromAddress) !== recipient) return undefined
  if (ledger.getInboxDelivery(message.id, recipient)?.status !== 'delivered') return undefined
  return parent.returnToSessionId
}

function replyReturnRecipient(ledger: LearningLedger, message: InboxMessage): AgentInboxAddress | undefined {
  if (message.replyTo === undefined) return undefined
  const parent = ledger.getInboxMessage(message.replyTo)
  const recipient = parent?.returnAddress ?? parent?.fromAddress
  return recipient !== undefined && (isHomeAddress(recipient) || isProjectSeatAddress(recipient))
    && inboxReturnDestination(ledger, message, recipient) !== undefined
    ? recipient : undefined
}

function returnPromptId(message: InboxMessage, recipient: AgentInboxAddress): MessageId {
  return stableId('inbox-return', `${recipient}:${message.id}`) as MessageId
}

function hasPrompt(agent: Agent, message: InboxMessage, recipient: AgentInboxAddress): boolean {
  const id = returnPromptId(message, recipient)
  return agent.session.events.some(event => event.type === 'agent/inbox/spliced'
    && event.data.inserted.some(item => item.id === id))
    || agent.inbox.nextTurn.some(item => item.id === id)
    || agent.inbox.nextStep.some(item => item.id === id)
}

function renderReturnPrompt(message: InboxMessage): string {
  return [
    '# Inbox reply to this Session',
    `Message ID: ${message.id}`,
    `From: ${message.fromAddress}`,
    `Subject: ${message.subject}`,
    `Reply to: ${message.replyTo}`,
    '', message.body,
    '', 'Read the full letter with bizagent_inbox_read when context references matter.',
    'Mark it handled only after review; a reply does not complete formal Work.',
  ].join('\n')
}
