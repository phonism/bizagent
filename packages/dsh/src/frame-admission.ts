import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { BizAgentService } from './service.js'
import { selectedFrameAddresses, removeFrameReferences } from './frame-reference.js'
import './message-source.js'

/** Resolve selected references at DSH's admission boundary, before the model sees the step. */
export async function admitFrameReferences(service: BizAgentService, agent: Agent,
  decision: PreStepDecision, signal: AbortSignal): Promise<PreStepDecision> {
  if (decision.kind !== 'enter') return decision
  const messages = [] as typeof decision.messages
  for (const message of decision.messages) {
    if (message.source.kind !== 'user') { messages.push(message); continue }
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    // The marker belongs to transport, not the visible transcript. Preserve message identity,
    // user text and attachments while DSH logs the actual loaded context separately.
    messages.push(freezeMessage({ ...message, content: message.content.map(block => block.type === 'text'
      ? { ...block, text: removeFrameReferences(block.text) } : block) }))
    for (const address of selectedFrameAddresses(text)) {
      if (signal.aborted) return { kind: 'reject' }
      try {
        // Admission can be cancelled after updating the Frame ledger. Always send a complete
        // snapshot on retry, rather than assuming an earlier, uncommitted copy reached the log.
        const result = await service.openFrame(agent, { address, forceSnapshot: true })
        const context = String(result.context)
        messages.push(createUserMessage({ content: [{ type: 'text', text: context }],
          source: { kind: 'bizagent', form: 'snapshot', sections: [{ name: address, text: context }] } }))
      } catch (error) {
        service.recordRuntimeError(`Frame reference ${String(agent.id)} ${address}`, error)
        messages.push(createUserMessage({ content: [{ type: 'text', text:
          `The selected Home ${address} could not be loaded. Its context is unavailable; do not answer as if it was read.` }],
        source: { kind: 'bizagent', form: 'notice', summary: `Home unavailable: ${address}` } }))
      }
    }
  }
  return signal.aborted ? { kind: 'reject' } : { ...decision, messages }
}
