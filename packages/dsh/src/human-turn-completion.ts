import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { SESSION_FORMAT_VERSION, type SessionEvent, type SessionHeader,
  type SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { HumanActionSchema, InboxMessageSchema, UserAddressSchema, stableId,
  type InboxDelivery, type InboxMessage, type SessionBinding, type UserAddress } from './domain.js'
import type { LearningLedger } from './ledger.js'

const CandidateSchema = z.strictObject({
  sessionId: z.string().min(1), turn: z.number().int().nonnegative(),
})
export type HumanTurnCandidate = z.infer<typeof CandidateSchema>
const DestinationSchema = z.strictObject({
  recipient: UserAddressSchema,
  authorityRef: z.string().min(1).max(500),
  pagePath: z.string().min(1).max(2000),
  summary: z.string().trim().min(1).max(160).regex(/^[^\r\n\u0000-\u001f]+$/u).optional(),
})
export type HumanTurnDestination = Omit<z.infer<typeof DestinationSchema>, 'recipient'> & {
  recipient: UserAddress
}

export interface HumanTurnCompletionSource {
  /** A durable, paginated list of turns with a host-verified person as asker. */
  listCandidates(after: string | undefined, limit: number): Promise<{
    candidates: HumanTurnCandidate[]; nextCursor?: string
  }>
  /** Recheck the exact turn's asker and access to its conversation on every attempt. */
  authorize(candidate: HumanTurnCandidate, binding: SessionBinding): HumanTurnDestination | undefined
    | Promise<HumanTurnDestination | undefined>
}

export interface HumanTurnPersistence {
  /** Read flushed Session events, including the completed turn. */
  inspect(id: SessionId): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }>
}

export interface HumanTurnCompletionPass {
  delivered: string[]
  existing: string[]
  held: string[]
  skipped: string[]
  failed: Array<{ sessionId: string; turn: number; error: unknown }>
  nextCursor?: string
}

/** Bridges one verified human turn into Inbox. External delivery remains a separate, opt-out-aware step. */
export class HumanTurnCompletionNotifier {
  constructor(private readonly inbox: LearningLedger, private readonly sessions: HumanTurnPersistence,
    private readonly source: HumanTurnCompletionSource) {}

  async recoverBatch(after?: string, limit = 20): Promise<HumanTurnCompletionPass> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('human turn completion pass limit must be between 1 and 100')
    }
    const page = await this.source.listCandidates(after, limit)
    if (!Array.isArray(page.candidates) || page.candidates.length > limit
      || (page.nextCursor !== undefined && (!page.nextCursor || page.nextCursor === after))) {
      throw new Error('human turn completion source returned an invalid page')
    }
    const result: HumanTurnCompletionPass = { delivered: [], existing: [], held: [], skipped: [], failed: [],
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) }
    const seen = new Set<string>()
    for (const raw of page.candidates) {
      const candidate = CandidateSchema.parse(raw)
      const key = `${candidate.sessionId}:${candidate.turn}`
      if (seen.has(key)) throw new Error('human turn completion source repeated a candidate')
      seen.add(key)
      try {
        const status = await this.notify(candidate)
        result[status].push(humanTurnInboxMessageId(candidate.sessionId, candidate.turn))
      } catch (error) { result.failed.push({ ...candidate, error }) }
    }
    return result
  }

  async notify(candidateInput: HumanTurnCandidate): Promise<'delivered' | 'existing' | 'held' | 'skipped'> {
    const candidate = CandidateSchema.parse(candidateInput)
    const binding = this.inbox.getBinding(candidate.sessionId)
    if (!binding) return 'held'
    const persisted = await this.sessions.inspect(candidate.sessionId as SessionId)
    if (persisted.meta.version !== SESSION_FORMAT_VERSION
      || String(persisted.meta.id) !== candidate.sessionId || persisted.meta.cwd !== binding.cwd) {
      throw new Error('human turn Session identity or Workspace changed')
    }
    const source = completedHumanTurn(persisted.events, candidate.turn)
    if (source === 'pending') return 'held'
    if (source === 'automated') return 'skipped'
    const destination = await this.source.authorize(candidate, binding)
    if (!destination) return 'held'
    const approved = DestinationSchema.parse(destination) as HumanTurnDestination
    const action = HumanActionSchema.parse({ request: 'View your answer',
      reason: 'Your question has finished processing.', href: approved.pagePath,
      label: 'Return to conversation' })
    const id = humanTurnInboxMessageId(candidate.sessionId, candidate.turn)
    const sentAt = new Date().toISOString()
    const message = InboxMessageSchema.parse({ schemaVersion: 1, id, idempotencyKey: id,
      fromAddress: binding.homeAddress, returnAddress: binding.homeAddress,
      returnToSessionId: candidate.sessionId,
      to: [approved.recipient], cc: [], subject: humanTurnSubject(approved.summary),
      body: humanTurnBody(approved.summary), kind: 'turn-complete', priority: 'normal',
      contextRefs: [], humanAction: action,
      humanTurn: { sessionId: candidate.sessionId, turn: candidate.turn,
        fromSeq: source.fromSeq, userMessageSeq: source.userMessageSeq, toSeq: source.toSeq,
        sourceSha256: source.sourceSha256, recipient: approved.recipient,
        authorityRef: approved.authorityRef,
        ...(approved.summary === undefined ? {} : { summary: approved.summary }) },
      rootId: id, chain: 0, topicId: id, hop: 0, sentAt,
    }) as InboxMessage
    return this.inbox.withInboxWrite(async () => {
      const prior = this.inbox.getInboxMessage(id)
      if (prior) {
        assertHumanTurnMessage(prior, message)
        await this.repairDelivery(prior)
        return 'existing'
      }
      await this.repairDelivery(message)
      await this.inbox.putInboxMessage(message)
      return 'delivered'
    })
  }

  private async repairDelivery(message: InboxMessage): Promise<void> {
    const recipient = message.humanTurn!.recipient as UserAddress
    const prior = this.inbox.getInboxDelivery(message.id, recipient)
    if (prior) {
      if (prior.status !== 'delivered' || prior.recipient !== recipient) {
        throw new Error('human turn Inbox delivery conflicts with its message')
      }
      return
    }
    const delivery: InboxDelivery = { schemaVersion: 1, messageId: message.id,
      recipient, status: 'delivered', updatedAt: message.sentAt }
    await this.inbox.putInboxDelivery(delivery)
  }
}

export function humanTurnInboxMessageId(sessionId: string, turn: number): string {
  return stableId('human-turn-inbox', JSON.stringify([sessionId, turn]))
}

export function humanTurnSubject(summary?: string): string {
  return summary === undefined ? 'Answer ready' : `Answer ready: ${summary}`.slice(0, 200)
}

export function humanTurnBody(summary?: string): string {
  return summary === undefined ? 'Your answer is ready. Open the conversation to read it.'
    : `Your answer is ready for: ${summary}\nOpen the conversation to read it.`
}

function assertHumanTurnMessage(prior: InboxMessage, expected: InboxMessage): void {
  if (prior.id !== expected.id || prior.kind !== 'turn-complete'
    || prior.fromAddress !== expected.fromAddress
    || prior.returnAddress !== expected.returnAddress
    || prior.returnToSessionId !== expected.returnToSessionId
    || !isDeepStrictEqual(prior.to, expected.to) || !isDeepStrictEqual(prior.cc, expected.cc)
    || !isDeepStrictEqual(prior.humanTurn, expected.humanTurn)
    || !isDeepStrictEqual(prior.humanAction, expected.humanAction)
    || prior.subject !== expected.subject || prior.body !== expected.body) {
    throw new Error('human turn Inbox message conflicts with its verified Session source')
  }
}

function completedHumanTurn(events: readonly SessionEvent[], turn: number): 'pending' | 'automated' | {
  fromSeq: number; userMessageSeq: number; toSeq: number; sourceSha256: string
} {
  const startIndex = events.findIndex(event => event.type === 'turn/start' && event.data.turn === turn)
  const endIndex = events.findIndex((event, index) => index > startIndex
    && event.type === 'turn/end' && event.data.turn === turn)
  if (startIndex < 0 || endIndex < 0) return 'pending'
  const source = events.slice(startIndex, endIndex + 1)
  if (source.some((event, index) => event.seq !== source[0]!.seq + index)) {
    throw new Error('human turn Session source is not contiguous')
  }
  const end = source.at(-1)!
  if (end.type !== 'turn/end' || end.data.reason.kind !== 'completed') return 'pending'
  const user = source.find((event): event is Extract<SessionEvent, { type: 'user/message' }> =>
    event.type === 'user/message' && event.data.source?.kind === 'user')
  if (!user) return 'automated'
  return { fromSeq: source[0]!.seq, userMessageSeq: user.seq, toSeq: end.seq,
    sourceSha256: createHash('sha256').update(JSON.stringify(source)).digest('hex') }
}
