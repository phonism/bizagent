import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import {
  FitnessReceiptSchema,
  LearningCheckpointSchema,
  MemoryProposalSchema,
  SessionBindingSchema,
  type FitnessReceipt,
  type LearningCheckpoint,
  type MemoryProposal,
  type SessionBinding,
} from './domain.js'

export const BIZAGENT_DOMAIN = defineDomain({
  name: 'bizagent_learning',
  version: 0,
  tables: {
    bindings: domainTable<string, z.infer<typeof SessionBindingSchema>>(SessionBindingSchema),
    proposals: domainTable<string, z.infer<typeof MemoryProposalSchema>>(MemoryProposalSchema),
    receipts: domainTable<string, z.infer<typeof FitnessReceiptSchema>>(FitnessReceiptSchema),
    metadata: domainTable<string, { key: string; value: string; updatedAt: string }>(z.object({
      key: z.string().min(1),
      value: z.string(),
      updatedAt: z.string().min(1),
    })),
  },
})

type BizAgentDomain = Domain<typeof BIZAGENT_DOMAIN>
const CHECKPOINT_PREFIX = 'learning-checkpoint:'

export class LearningLedger {
  private constructor(private readonly domain: BizAgentDomain) {}

  static async open(facility: DomainFacility): Promise<LearningLedger> {
    return new LearningLedger(await facility.open(BIZAGENT_DOMAIN))
  }

  getBinding(sessionId: string): SessionBinding | undefined {
    return this.domain.table('bindings').get(sessionId) as SessionBinding | undefined
  }

  async putBinding(binding: SessionBinding): Promise<void> {
    const existing = this.getBinding(binding.sessionId)
    if (existing !== undefined && existing.homeAddress !== binding.homeAddress) {
      throw new Error(
        `session ${binding.sessionId} is already bound to ${existing.homeAddress}; cannot rebind to ${binding.homeAddress}`,
      )
    }
    await this.domain.table('bindings').put(binding.sessionId, SessionBindingSchema.parse(binding))
  }

  listBindings(homeAddress?: string): SessionBinding[] {
    return [...this.domain.table('bindings').entries()]
      .map(([, binding]) => binding as SessionBinding)
      .filter(binding => homeAddress === undefined || binding.homeAddress === homeAddress)
      .sort((a, b) => a.boundAt.localeCompare(b.boundAt))
  }

  getProposal(id: string): MemoryProposal | undefined {
    return this.domain.table('proposals').get(id) as MemoryProposal | undefined
  }

  async putProposal(proposal: MemoryProposal): Promise<void> {
    await this.domain.table('proposals').put(proposal.id, MemoryProposalSchema.parse(proposal))
  }

  listProposals(options: {
    fromAddress?: string
    toAddress?: string
    status?: MemoryProposal['status']
  } = {}): MemoryProposal[] {
    return [...this.domain.table('proposals').entries()]
      .map(([, proposal]) => proposal as MemoryProposal)
      .filter(proposal => options.fromAddress === undefined || proposal.fromAddress === options.fromAddress)
      .filter(proposal => options.toAddress === undefined || proposal.toAddress === options.toAddress)
      .filter(proposal => options.status === undefined || proposal.status === options.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async putReceipt(receipt: FitnessReceipt): Promise<void> {
    await this.domain.table('receipts').put(receipt.id, FitnessReceiptSchema.parse(receipt))
  }

  listReceipts(assetId?: string): FitnessReceipt[] {
    return [...this.domain.table('receipts').entries()]
      .map(([, receipt]) => receipt as FitnessReceipt)
      .filter(receipt => assetId === undefined || receipt.assetId === assetId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  getCheckpoint(id: string): LearningCheckpoint | undefined {
    const record = this.domain.table('metadata').get(checkpointKey(id))
    if (record === undefined) return undefined
    return LearningCheckpointSchema.parse(JSON.parse(record.value)) as LearningCheckpoint
  }

  async putCheckpoint(checkpoint: LearningCheckpoint): Promise<void> {
    const parsed = LearningCheckpointSchema.parse(checkpoint) as LearningCheckpoint
    const key = checkpointKey(parsed.id)
    await this.domain.table('metadata').put(key, {
      key,
      value: JSON.stringify(parsed),
      updatedAt: parsed.settledAt ?? parsed.createdAt,
    })
  }

  listCheckpoints(options: {
    sessionId?: string
    homeAddress?: string
    status?: LearningCheckpoint['status']
  } = {}): LearningCheckpoint[] {
    return [...this.domain.table('metadata').entries()]
      .filter(([key]) => key.startsWith(CHECKPOINT_PREFIX))
      .map(([, record]) => LearningCheckpointSchema.parse(JSON.parse(record.value)) as LearningCheckpoint)
      .filter(item => options.sessionId === undefined || item.sessionId === options.sessionId)
      .filter(item => options.homeAddress === undefined || item.homeAddress === options.homeAddress)
      .filter(item => options.status === undefined || item.status === options.status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async close(): Promise<void> {
    await this.domain.close()
  }
}

function checkpointKey(id: string): string {
  return `${CHECKPOINT_PREFIX}${id}`
}
