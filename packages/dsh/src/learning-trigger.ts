import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { EvidenceRef } from './domain.js'

export interface LearningTriggerMatch {
  reason: 'explicit-correction'
  evidenceRef: Extract<EvidenceRef, { type: 'session-events' }>
  excerpt: string
}

export interface LearningTrigger {
  readonly name: string
  detect(events: readonly SessionEvent[], turn: number): LearningTriggerMatch | undefined
}

const EXPLICIT_CORRECTION_PATTERNS = [
  /(?:请)?记住(?:这(?:一点|一条|件事)?|[\s：:,，。]|$)/u,
  /(?:从现在起|以后|下次).{0,40}(?:必须|应该|要|请|不要|不能|别)/u,
  /(?:不要|别)再/u,
  /(?:刚才|前面|上次).{0,50}(?:错了|不对|错误)/u,
  /(?:正确的?(?:做法|方式|规则)|应该改成)/u,
  /\b(?:please\s+)?remember\b/i,
  /\bfrom now on\b/i,
  /\bnext time\b.{0,80}\b(?:must|should|please|do not|don't|never)\b/i,
  /\b(?:do not|don't|never)\b.{0,80}\bagain\b/i,
  /\b(?:that|this|your previous).{0,40}\b(?:was|is)\s+(?:wrong|incorrect)\b/i,
]

export class ExplicitCorrectionTrigger implements LearningTrigger {
  readonly name = 'explicit-correction'

  detect(events: readonly SessionEvent[], turn: number): LearningTriggerMatch | undefined {
    const startIndex = findTurnStart(events, turn)
    if (startIndex < 0) return undefined
    const turnEvents = events.slice(startIndex)
    if (turnEvents.some((event) => {
      if (event.type !== 'tool/call'
        && event.type !== 'tool/code-dispatch'
        && event.type !== 'tool/code-dispatch-start') return false
      return event.data.name === 'bizagent_memory_remember'
        || event.data.name === 'bizagent_learning_checkpoint'
    })) return undefined

    for (let index = turnEvents.length - 1; index >= 0; index -= 1) {
      const event = turnEvents[index]
      if (event?.type !== 'user/message' || event.data.source.kind !== 'user') continue
      const text = textContent(event.data.content).trim()
      if (text.length === 0 || !EXPLICIT_CORRECTION_PATTERNS.some(pattern => pattern.test(text))) continue
      return {
        reason: 'explicit-correction',
        evidenceRef: {
          type: 'session-events',
          sessionId: '',
          fromSeq: event.seq,
          toSeq: event.seq,
        },
        excerpt: boundText(text, 4000),
      }
    }
    return undefined
  }
}

function findTurnStart(events: readonly SessionEvent[], turn: number): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start' && event.data.turn === turn) return index
  }
  return -1
}

function textContent(content: readonly unknown[]): string {
  return content.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const candidate = block as { type?: unknown; text?: unknown }
    return candidate.type === 'text' && typeof candidate.text === 'string' ? [candidate.text] : []
  }).join('\n')
}

function boundText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`
}
