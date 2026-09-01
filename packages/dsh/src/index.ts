import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { foldSurface, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { Config, type Config as BizAgentConfig, resolveConfig } from './config.js'
import { HomeStore } from './home-store.js'
import { LearningLedger } from './ledger.js'
import { BizAgentService } from './service.js'
import { registerTools } from './tools.js'

export const name = 'bizagent'
export const inject = ['tools', 'systemPrompt', 'storageDomain', 'sessionQuery']
export { Config }
export type { BizAgentConfig as ConfigInput }
export { HomeStore } from './home-store.js'
export { LearningLedger, BIZAGENT_DOMAIN } from './ledger.js'
export { BizAgentService } from './service.js'
export * from './domain.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    bizagent: BizAgentService
  }
}

const LEARNING_POLICY = `BizAgent provides the long-term Home bound to this session.

- Treat Working Context and DSH transcript as evidence, not automatically as long-term truth.
- Save a Memory only when an observation is likely to help future work; keep the description concise and the body specific.
- Search and read indexed assets before relying on them. Do not infer an asset body from its one-line description.
- Write only to the current Home. When learning belongs to another Personal, Business, Role, or Capability Home, create a proposal.
- Record confirmation, contradiction, or failure when later work tests a recalled asset.
- Never rewrite Identity automatically.`

const HOME_SNAPSHOT_MARKER = 'BizAgent Home Snapshot v1'

export async function apply(ctx: Context, input: BizAgentConfig = {}): Promise<void> {
  const config = resolveConfig(input)
  const store = new HomeStore(config.homeRoot)
  await store.initialize()
  const ledger = await LearningLedger.open(ctx.storageDomain)
  const service = new BizAgentService(store, ledger, config, ctx.sessionQuery)
  try {
    await service.initialize()
  } catch (error) {
    await ledger.close()
    throw error
  }

  ctx.effect(() => async () => service.close())
  ctx.provide('bizagent', service)

  ctx.systemPrompt.section({
    name: 'bizagent:learning-policy',
    order: 80,
    text: LEARNING_POLICY,
  })
  ctx.on('agent/session-start', ({ agent }) => {
    const snapshot = service.contextSnapshotForSession(String(agent.id), agent.session.header.cwd)
    if (snapshot === undefined || hasCurrentSnapshot(agent.session.events, snapshot)) return
    const text = renderHomeSnapshot(snapshot)
    agent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: 'bizagent',
        form: 'snapshot',
        sections: [{ name: 'home-context', text }],
      },
    }))
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    try {
      const checkpoint = await service.prepareLearningCheckpoint(agent, turn)
      if (checkpoint === undefined) return
      try {
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: renderCheckpointPrompt(checkpoint) }],
          source: {
            kind: 'plugin',
            plugin: 'bizagent',
            form: 'notice',
            summary: 'Review an explicit correction for durable memory.',
          },
        }))
      } catch (error) {
        await service.failPendingCheckpoint(String(agent.id), turn, `Checkpoint steering failed: ${errorMessage(error)}`)
        service.recordRuntimeError(`checkpoint ${checkpoint.id}`, error)
      }
    } catch (error) {
      service.recordRuntimeError(`checkpoint ${String(agent.id)}:${turn}`, error)
    }
  })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    void service.failPendingCheckpoint(
      String(session.id),
      event.data.turn,
      'The learning checkpoint did not settle before the turn ended.',
    ).catch(error => service.recordRuntimeError(`checkpoint ${String(session.id)}:${event.data.turn}`, error))
  })

  registerTools(ctx, service)
}

interface HomeSnapshot {
  homeAddress: string
  revision: number
  digest: string
  text: string
}

function renderHomeSnapshot(snapshot: HomeSnapshot): string {
  return [
    HOME_SNAPSHOT_MARKER,
    `Address: ${snapshot.homeAddress}`,
    `Revision: ${snapshot.revision}`,
    `Digest: ${snapshot.digest}`,
    '',
    snapshot.text,
  ].join('\n')
}

function hasCurrentSnapshot(events: readonly SessionEvent[], snapshot: HomeSnapshot): boolean {
  let visible = events
  try {
    const nodes = new Set(foldSurface(events).nodes)
    if (nodes.size > 0) visible = events.filter(event => nodes.has(event.seq))
  } catch {
    // Tests and imported legacy logs may omit surface markers; scanning them is fail-safe for duplicate prevention.
  }
  const identity = [
    HOME_SNAPSHOT_MARKER,
    `Address: ${snapshot.homeAddress}`,
    `Revision: ${snapshot.revision}`,
    `Digest: ${snapshot.digest}`,
  ]
  return visible.some((event) => {
    if (event.type !== 'user/message') return false
    if (event.data.source.kind !== 'plugin' || event.data.source.plugin !== 'bizagent') return false
    const text = event.data.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n')
    return identity.every(line => text.includes(line))
  })
}

function renderCheckpointPrompt(checkpoint: {
  id: string
  excerpt: string
  evidenceRef: { type: string; fromSeq?: number; toSeq?: number }
}): string {
  return [
    '# BizAgent Learning Checkpoint',
    '',
    'The direct user message below may contain an explicit long-term correction or instruction.',
    'Decide whether it is specific and reusable for future work in the current Home.',
    'Call bizagent_learning_checkpoint exactly once and do not send prose:',
    `- checkpoint_id: ${checkpoint.id}`,
    '- action=remember with a concise description and complete reusable body; or',
    '- action=skip with a concrete decision when this should remain working context only.',
    '- Never infer an Identity change or write another Home.',
    '',
    `Evidence seq: ${checkpoint.evidenceRef.fromSeq ?? '?'}-${checkpoint.evidenceRef.toSeq ?? '?'}`,
    'Direct user message:',
    checkpoint.excerpt,
  ].join('\n')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
