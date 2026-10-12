import { isUserAddress, type HumanAction, type InboxSenderAddress, type InboxHumanNotification,
  type InboxMessage, type UserAddress } from './domain.js'
import type { LearningLedger } from './ledger.js'

export interface HumanNotificationRequest {
  notificationId: string
  messageId: string
  recipient: UserAddress
  role: 'to' | 'cc'
  fromAddress: InboxSenderAddress
  subject: string
  body: string
  priority: 'normal' | 'urgent'
  due?: string
  humanAction?: HumanAction
}

export type HumanNotificationOutcome =
  | { status: 'sent'; providerReceipt: string }
  | { status: 'rejected'; reason: string }
  | { status: 'unknown' }

export interface HumanNotificationProvider {
  /** Return sent only after verifying an actual channel success receipt. */
  notify(request: HumanNotificationRequest): Promise<HumanNotificationOutcome>
}

export type HumanNotificationPolicyDecision = { action: 'send' } | { action: 'defer' }
  | { action: 'suppress'; reason: string }
export interface HumanNotificationRunnerOptions {
  /** Host attention policy runs before reservation; defer leaves the Inbox item pending. */
  decide?(message: InboxMessage, recipient: UserAddress): HumanNotificationPolicyDecision
    | Promise<HumanNotificationPolicyDecision>
}

export interface HumanNotificationPass {
  sent: Array<{ messageId: string; recipient: UserAddress }>
  rejected: Array<{ messageId: string; recipient: UserAddress }>
  unknown: Array<{ messageId: string; recipient: UserAddress }>
  deferred: Array<{ messageId: string; recipient: UserAddress }>
  suppressed: Array<{ messageId: string; recipient: UserAddress }>
  failed: Array<{ messageId: string; recipient: UserAddress; error: unknown }>
}

/** At most one external attempt per message and user. A reserved but unresolved attempt remains unknown. */
export class HumanNotificationRunner {
  private pass: Promise<HumanNotificationPass> | undefined
  private closing = false

  constructor(private readonly ledger: LearningLedger, private readonly provider: HumanNotificationProvider,
    private readonly options: HumanNotificationRunnerOptions = {}) {}

  recoverBatch(limit = 4): Promise<HumanNotificationPass> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('human notification pass limit must be between 1 and 100')
    }
    if (this.closing) return Promise.resolve({ sent: [], rejected: [], unknown: [],
      deferred: [], suppressed: [], failed: [] })
    if (this.pass) return this.pass
    const task = this.runPass(limit)
    this.pass = task
    void task.finally(() => { if (this.pass === task) this.pass = undefined }).catch(() => undefined)
    return task
  }

  /** Only a definite provider rejection can be retried, by an explicit host call. */
  async retryRejected(messageId: string, recipient: UserAddress): Promise<'sent' | 'rejected' | 'unknown'> {
    if (this.closing) throw new Error('human notification runner is closed')
    const message = this.ledger.getInboxMessage(messageId)
    if (message === undefined || ![...message.to, ...message.cc].includes(recipient)) {
      throw new Error('human notification message is unavailable to this recipient')
    }
    const decision = await this.decision(message, recipient)
    if (decision.action !== 'send') throw new Error('human notification policy does not permit retry')
    const notification = await this.ledger.retryRejectedInboxHumanNotification(messageId, recipient)
    return this.notify(message, recipient, notification)
  }

  private async runPass(limit: number): Promise<HumanNotificationPass> {
    const result: HumanNotificationPass = { sent: [], rejected: [], unknown: [],
      deferred: [], suppressed: [], failed: [] }
    let attempts = 0
    for (const message of this.ledger.listInboxMessages().reverse()) {
      if (this.closing || attempts >= limit) break
      const recipients = [...new Set([...message.to, ...message.cc])]
      for (const recipient of recipients) {
        if (this.closing || attempts >= limit) break
        if (!isUserAddress(recipient)) continue
        const delivery = this.ledger.getInboxDelivery(message.id, recipient)
        if (delivery?.status !== 'delivered' || delivery.handledAt !== undefined
          || this.ledger.getInboxHumanNotification(message.id, recipient) !== undefined) continue
        try {
          const optOut = await this.ledger.suppressInboxHumanNotificationIfOptedOut(message.id, recipient)
          if (optOut) {
            result.suppressed.push({ messageId: message.id, recipient }); continue
          }
          const decision = await this.decision(message, recipient)
          if (decision.action === 'defer') {
            result.deferred.push({ messageId: message.id, recipient }); continue
          }
          if (decision.action === 'suppress') {
            await this.ledger.suppressInboxHumanNotification(message.id, recipient, decision.reason)
            result.suppressed.push({ messageId: message.id, recipient }); continue
          }
        } catch (error) {
          result.failed.push({ messageId: message.id, recipient, error }); continue
        }
        let reserved: Awaited<ReturnType<LearningLedger['reserveInboxHumanNotification']>>
        try { reserved = await this.ledger.reserveInboxHumanNotification(message.id, recipient) }
        catch (error) { result.failed.push({ messageId: message.id, recipient, error }); continue }
        if (!reserved.reserved) {
          if (reserved.notification.status === 'suppressed') {
            result.suppressed.push({ messageId: message.id, recipient })
          }
          continue
        }
        attempts++
        try {
          const status = await this.notify(message, recipient, reserved.notification)
          result[status].push({ messageId: message.id, recipient })
        } catch (error) {
          // The channel may have accepted the request. Leave the durable reservation unknown.
          result.failed.push({ messageId: message.id, recipient, error })
        }
      }
    }
    return result
  }

  private async decision(message: InboxMessage,
    recipient: UserAddress): Promise<HumanNotificationPolicyDecision> {
    const result = await this.options.decide?.(message, recipient) ?? { action: 'send' as const }
    if (result.action !== 'send' && result.action !== 'defer'
      && (result.action !== 'suppress' || !result.reason?.trim())) {
      throw new Error('human notification policy returned an invalid decision')
    }
    return result
  }

  private async notify(message: InboxMessage, recipient: UserAddress,
    notification: InboxHumanNotification): Promise<'sent' | 'rejected' | 'unknown'> {
    const outcome = await this.provider.notify({
      notificationId: notification.id, messageId: message.id,
      recipient, role: message.to.includes(recipient) ? 'to' : 'cc',
      fromAddress: message.fromAddress, subject: message.subject, body: message.body,
      priority: message.priority,
      ...(message.due !== undefined ? { due: message.due } : {}),
      ...(message.humanAction !== undefined ? { humanAction: message.humanAction } : {}),
    })
    if (outcome.status === 'unknown') return 'unknown'
    const settled = await this.ledger.settleInboxHumanNotification(message.id, recipient, outcome)
    if (settled.status === 'suppressed') throw new Error('suppressed human notification cannot settle')
    return settled.status
  }

  async close(): Promise<void> {
    this.closing = true
    if (this.pass) await this.pass
  }
}
