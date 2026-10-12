import { isHomeAddress, isProjectSeatAddress,
  type HomeAddress, type ProjectSeatAddress, type InboxMessage } from './domain.js'

export const INBOX_STALE_ESCALATE_MS = 24 * 60 * 60_000

export interface StalledInboxTopic {
  topicId: string
  ordinaryCount: number
  maxHop: number
  lastSentAt: string
  subject: string
  sourceMessageId: string
  returnAddress: HomeAddress | ProjectSeatAddress
  returnToSessionId?: string
  projectId?: string
}

/** Scan immutable letters; Work notifications and closed topics do not consume the ordinary relay budget. */
export function stalledInboxTopics(messages: readonly InboxMessage[], now: number): StalledInboxTopic[] {
  const closed = new Set(messages.filter(message => message.kind === 'conclusion' || message.kind === 'escalation')
    .map(message => message.topicId ?? message.rootId))
  const groups = new Map<string, InboxMessage[]>()
  for (const message of messages) {
    if (message.kind !== 'ordinary') continue
    const topicId = message.topicId ?? message.rootId
    const group = groups.get(topicId) ?? []
    group.push(message)
    groups.set(topicId, group)
  }
  const stalled: StalledInboxTopic[] = []
  for (const [topicId, group] of groups) {
    if (closed.has(topicId)) continue
    group.sort((a, b) => a.sentAt.localeCompare(b.sentAt)
      || (a.hop ?? a.chain) - (b.hop ?? b.chain) || a.id.localeCompare(b.id))
    const latest = group.at(-1)!
    const last = Date.parse(latest.sentAt)
    const maxHop = Math.max(...group.map(message => message.hop ?? message.chain))
    if (!Number.isFinite(last) || (group.length < 12 && maxHop < 6)
      || last > now - INBOX_STALE_ESCALATE_MS) continue
    const lastAgent = group.findLast(message => isHomeAddress(message.fromAddress)
      || isProjectSeatAddress(message.fromAddress))
    if (lastAgent === undefined || (!isHomeAddress(lastAgent.fromAddress)
      && !isProjectSeatAddress(lastAgent.fromAddress))) continue
    stalled.push({
      topicId, ordinaryCount: group.length, maxHop, lastSentAt: latest.sentAt,
      subject: group[0]!.subject, sourceMessageId: group[0]!.id,
      returnAddress: lastAgent.fromAddress,
      ...(lastAgent.projectId !== undefined ? { projectId: lastAgent.projectId } : {}),
      ...(lastAgent.returnToSessionId !== undefined
        ? { returnToSessionId: lastAgent.returnToSessionId } : {}),
    })
  }
  return stalled.sort((a, b) => a.lastSentAt.localeCompare(b.lastSentAt) || a.topicId.localeCompare(b.topicId))
}
