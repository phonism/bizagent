import { stalledInboxTopics, type StalledInboxTopic } from './inbox-stalled-topic.js'
import type { BizAgentService } from './service.js'

export interface EscalationOwnerDecision {
  userId: string
  /** Durable pointer to the host's verified responsibility or execution grant. */
  authorityRef: string
}

export interface StalledEscalationPass {
  escalated: Array<{ topicId: string; messageId: string }>
  skipped: string[]
  failed: Array<{ topicId: string; error: unknown }>
}

/** Host-owned single writer. No Home.owner string is accepted as authenticated identity by default. */
export class InboxStalledEscalationRunner {
  private pass: Promise<StalledEscalationPass> | undefined
  private closing = false
  private cursorKey: string | undefined

  constructor(private readonly service: BizAgentService,
    private readonly resolveOwner: (topic: StalledInboxTopic) => EscalationOwnerDecision | null
      | Promise<EscalationOwnerDecision | null>) {}

  recoverBatch(limit = 4, now = Date.now()): Promise<StalledEscalationPass> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isFinite(now) || now < 0) {
      throw new Error('invalid stalled Inbox escalation scan limit or time')
    }
    if (this.closing) return Promise.resolve({ escalated: [], skipped: [], failed: [] })
    if (this.pass) return this.pass
    const task = this.runPass(limit, now)
    this.pass = task
    void task.finally(() => { if (this.pass === task) this.pass = undefined }).catch(() => undefined)
    return task
  }

  private async runPass(limit: number, now: number): Promise<StalledEscalationPass> {
    const result: StalledEscalationPass = { escalated: [], skipped: [], failed: [] }
    const candidates = stalledInboxTopics(this.service.ledger.listInboxMessages(), now)
    const key = (candidate: StalledInboxTopic): string => `${candidate.lastSentAt}\0${candidate.topicId}`
    const next = this.cursorKey === undefined ? 0
      : candidates.findIndex(candidate => key(candidate) > this.cursorKey!)
    const start = next < 0 ? 0 : next
    for (let offset = 0; offset < Math.min(limit, candidates.length); offset++) {
      if (this.closing) break
      const candidate = candidates[(start + offset) % candidates.length]!
      this.cursorKey = key(candidate)
      try {
        const owner = await this.resolveOwner(candidate)
        if (this.closing) break
        if (owner === null) { result.skipped.push(candidate.topicId); continue }
        const sent = await this.service.createAutomaticTopicEscalation({
          topicId: candidate.topicId, userId: owner.userId,
          authorityRef: owner.authorityRef, now,
        })
        if (sent === undefined) result.skipped.push(candidate.topicId)
        else result.escalated.push({ topicId: candidate.topicId, messageId: sent.message.id })
      } catch (error) {
        result.failed.push({ topicId: candidate.topicId, error })
      }
    }
    return result
  }

  async close(): Promise<void> {
    this.closing = true
    if (this.pass) await this.pass
  }
}
