import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import type { BizAgentService } from './service.js'

const JSON_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{
    type: 'text' as const,
    text: JSON.stringify(value, null, 2),
  }],
}

const TAGS = {
  type: 'array' as const,
  description: 'Optional short retrieval tags.',
  items: { type: 'string' as const },
}

export function registerTools(ctx: Context, service: BizAgentService): void {
  ctx.tools.register(defineTool({
    name: 'bizagent_home_status',
    description: 'Inspect the current session\'s immutable Agent Home binding, revision, memory counts, and proposal queue.',
    parameters: {},
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => jsonResult(service.homeStatus(requireAgent(exec.agent))),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_memory_search',
    description: 'Search the current Agent Home\'s long-term asset index. Read a useful hit before relying on its body.',
    parameters: {
      query: { type: 'string', description: 'Optional case-insensitive text query.' },
      kind: {
        type: 'string',
        enum: ['memory', 'insight', 'knowledge', 'method', 'identity'],
        description: 'Optional asset kind filter.',
      },
      status: {
        type: 'string',
        enum: ['candidate', 'active', 'superseded', 'retired'],
        description: 'Optional lifecycle filter. Defaults to active.',
      },
      limit: { type: 'integer', description: 'Maximum results, from 1 to 100. Defaults to 20.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.searchMemory(requireAgent(exec.agent), {
      ...(args.query !== undefined ? { query: args.query } : {}),
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_memory_read',
    description: 'Read one long-term asset body from the current Agent Home and record a retrieved receipt.',
    parameters: {
      asset_id: { type: 'string', required: true, description: 'Asset id returned by bizagent_memory_search.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.readMemory(
      requireAgent(exec.agent),
      String(exec.callId),
      args.asset_id,
    )),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_evidence_read',
    description: 'Read a bounded, validated DSH Session event range cited by one current-Home learning asset.',
    parameters: {
      asset_id: { type: 'string', required: true, description: 'Asset whose evidence should be inspected.' },
      source_index: { type: 'integer', description: 'Zero-based sourceRefs index. Defaults to 0.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.readEvidence(requireAgent(exec.agent), {
      assetId: args.asset_id,
      ...(args.source_index !== undefined ? { sourceIndex: args.source_index } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_memory_remember',
    description: 'Save a reusable observation to the current Agent Home with evidence from the current durable DSH turn.',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'One concise index line describing when this memory is useful.',
      },
      body: { type: 'string', required: true, description: 'The complete reusable observation.' },
      tags: TAGS,
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.remember(requireAgent(exec.agent), String(exec.callId), {
      description: args.description,
      body: args.body,
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_memory_update',
    description: 'Revise or retire an asset owned by the current Agent Home. This cannot modify another Home.',
    parameters: {
      asset_id: { type: 'string', required: true },
      action: { type: 'string', required: true, enum: ['revise', 'retire'] },
      description: { type: 'string', description: 'Replacement index description for revise.' },
      body: { type: 'string', description: 'Replacement body for revise.' },
      tags: TAGS,
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.updateMemory(requireAgent(exec.agent), {
      assetId: args.asset_id,
      action: args.action,
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.body !== undefined ? { body: args.body } : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_memory_propose',
    description: 'Propose evidence-backed learning to another Agent Home. Never writes the target Home directly.',
    parameters: {
      to_address: {
        type: 'string',
        required: true,
        description: 'Canonical target such as role:growth-strategy.',
      },
      proposed_kind: {
        type: 'string',
        enum: ['memory', 'insight', 'knowledge', 'method'],
        description: 'Suggested maturity. Defaults to memory.',
      },
      description: { type: 'string', required: true, description: 'One concise target index line.' },
      body: { type: 'string', required: true, description: 'Full proposed content.' },
      tags: TAGS,
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.proposeMemory(requireAgent(exec.agent), String(exec.callId), {
      toAddress: args.to_address,
      ...(args.proposed_kind !== undefined ? { proposedKind: args.proposed_kind } : {}),
      description: args.description,
      body: args.body,
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_proposals',
    description: 'List or inspect memory proposals visible to the current Agent Home.',
    parameters: {
      id: { type: 'string', description: 'Read one proposal by id.' },
      direction: { type: 'string', enum: ['incoming', 'outgoing', 'both'], description: 'Defaults to incoming.' },
      status: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'withdrawn'] },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.proposals(requireAgent(exec.agent), {
      ...(args.id !== undefined ? { id: args.id } : {}),
      ...(args.direction !== undefined ? { direction: args.direction } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_proposal_accept',
    description: 'Accept an incoming proposal owned by the current Home and publish a reviewed target asset.',
    parameters: {
      proposal_id: { type: 'string', required: true },
      kind: { type: 'string', enum: ['memory', 'insight', 'knowledge', 'method'] },
      description: { type: 'string', description: 'Reviewed replacement description.' },
      body: { type: 'string', description: 'Reviewed replacement body.' },
      tags: TAGS,
      decision: { type: 'string', description: 'Optional review rationale.' },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.acceptProposal(requireAgent(exec.agent), {
      proposalId: args.proposal_id,
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.body !== undefined ? { body: args.body } : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
      ...(args.decision !== undefined ? { decision: args.decision } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_proposal_reject',
    description: 'Reject an incoming proposal owned by the current Home and preserve the decision.',
    parameters: {
      proposal_id: { type: 'string', required: true },
      decision: { type: 'string', required: true, description: 'Why this proposal should not become target memory.' },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.rejectProposal(
      requireAgent(exec.agent),
      args.proposal_id,
      args.decision,
    )),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_learning_checkpoint',
    description: 'Settle one BizAgent-issued explicit-correction checkpoint. Use exactly once when prompted by BizAgent.',
    parameters: {
      checkpoint_id: { type: 'string', required: true },
      action: { type: 'string', required: true, enum: ['remember', 'skip'] },
      description: { type: 'string', description: 'Required concise retrieval description for remember.' },
      body: { type: 'string', description: 'Required reusable rule or preference for remember.' },
      tags: TAGS,
      decision: { type: 'string', description: 'Required reason for skip; optional rationale for remember.' },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => {
      const result = await service.settleLearningCheckpoint(requireAgent(exec.agent), {
        checkpointId: args.checkpoint_id,
        action: args.action,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.body !== undefined ? { body: args.body } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        ...(args.decision !== undefined ? { decision: args.decision } : {}),
      })
      exec.concludeTurn()
      return JSON.parse(JSON.stringify(result)) as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_memory_feedback',
    description: 'Record whether a recalled asset was applied, confirmed, contradicted, or failed in the current work.',
    parameters: {
      asset_id: { type: 'string', required: true },
      signal: {
        type: 'string',
        required: true,
        enum: ['applied', 'confirmed', 'contradicted', 'failed'],
      },
      outcome: { type: 'string', description: 'Short evidence-backed outcome note.' },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.feedback(requireAgent(exec.agent), String(exec.callId), {
      assetId: args.asset_id,
      signal: args.signal,
      ...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
    })),
  }))
}

function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('BizAgent tools require a live DSH Agent session')
  return agent
}

async function jsonResult(value: Promise<unknown>): Promise<JsonValue> {
  return JSON.parse(JSON.stringify(await value)) as JsonValue
}
