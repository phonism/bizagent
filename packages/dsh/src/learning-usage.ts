import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** A projection of the dedicated worker's durable model-call evidence. No price is inferred. */
export interface LearningUsage {
  status: 'reported' | 'partial' | 'unavailable'
  reported?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
  }
  reportedSteps: number
  unreportedSteps: number
  lastEventSeq: number | null
  costUsd: null
}

export function summarizeLearningUsage(events: readonly SessionEvent[]): LearningUsage {
  const steps = new Map<string, { started: boolean; usages: TokenUsage[] }>()
  for (const event of events) {
    if (event.type !== 'step/start' && event.type !== 'assistant/attempt'
      && event.type !== 'assistant/message') continue
    const key = `${event.data.turn}:${event.data.step}`
    const step = steps.get(key) ?? { started: false, usages: [] }
    if (event.type === 'step/start') step.started = true
    else {
      // Each model attempt (failed retries included) counts once: its streamed usage reports,
      // or the message's own total when the adapter reported no usage chunk.
      const streamed = (event.data.stream ?? []).flatMap(record =>
        record.type === 'chunk' && record.chunk.type === 'usage' ? [record.chunk.usage] : [])
      if (streamed.length > 0) step.usages.push(...streamed)
      else if (event.type === 'assistant/message' && event.data.usage !== undefined) step.usages.push(event.data.usage)
    }
    steps.set(key, step)
  }
  const reported = { inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  let reportedSteps = 0
  let unreportedSteps = 0
  for (const step of steps.values()) {
    const usages = step.usages
    if (usages.length === 0) {
      if (step.started) unreportedSteps += 1
      continue
    }
    reportedSteps += 1
    for (const usage of usages) {
      reported.inputTokens += usage.inputTokens
      reported.outputTokens += usage.outputTokens
      reported.cacheReadTokens += usage.cacheReadTokens ?? 0
      reported.cacheWriteTokens += usage.cacheWriteTokens ?? 0
      reported.reasoningTokens += usage.reasoningTokens ?? 0
    }
  }
  return {
    status: reportedSteps === 0 ? 'unavailable' : unreportedSteps > 0 ? 'partial' : 'reported',
    ...(reportedSteps > 0 ? { reported } : {}),
    reportedSteps, unreportedSteps,
    lastEventSeq: events.at(-1)?.seq ?? null, costUsd: null,
  }
}
