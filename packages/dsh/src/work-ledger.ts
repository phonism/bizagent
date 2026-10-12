import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { HomeAddressSchema, type HomeAddress } from './domain.js'

export const FormalWorkSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  idempotencyKey: z.string().min(1).max(128),
  requester: HomeAddressSchema,
  assignee: HomeAddressSchema,
  returnToSessionId: z.string().min(1),
  goal: z.string().min(1).max(200),
  acceptanceCriteria: z.string().min(1).max(4000),
  projectId: z.string().min(1).max(128).optional(),
  status: z.enum(['open', 'accepted', 'completing', 'completed', 'cancelled']),
  requestMessageId: z.string().min(1),
  /** Frozen at dispatch. Old records have no automatic startup intent. */
  autoStart: z.boolean().optional(),
  workerSessionId: z.string().min(1).optional(),
  workerCwd: z.string().min(1).optional(),
  workerOptions: z.object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    maxTokens: z.number().int().positive().optional(),
  }).optional(),
  acceptedAt: z.string().min(1).optional(),
  resultMessageId: z.string().min(1).optional(),
  resultSubject: z.string().min(1).max(200).optional(),
  resultBody: z.string().min(1).max(16000).optional(),
  resultSessionId: z.string().min(1).optional(),
  resultArtifacts: z.array(z.object({
    path: z.string().max(500).refine(path => path.startsWith('artifacts/')
      && !path.includes('\\') && !path.includes('\0')
      && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
    'Work artifact path must be canonical under artifacts/'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative().max(8 * 1024 * 1024),
    snapshot: z.literal(true),
  })).max(10).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  completedAt: z.string().min(1).optional(),
  cancelledAt: z.string().min(1).optional(),
  cancelMessageId: z.string().min(1).optional(),
  cancelReason: z.string().min(1).max(2000).optional(),
  cancelledBySessionId: z.string().min(1).optional(),
}).superRefine((work, context) => {
  if (work.requester === work.assignee) {
    context.addIssue({ code: 'custom', path: ['assignee'], message: 'Work assignee must be another Agent Home' })
  }
  if (['accepted', 'completing', 'completed'].includes(work.status)
    && (!work.workerSessionId || !work.acceptedAt)) {
    context.addIssue({ code: 'custom', path: ['workerSessionId'], message: 'accepted Work requires one worker Session' })
  }
  if (work.status === 'completing' || work.status === 'completed') {
    if (!work.resultMessageId || !work.resultSubject || !work.resultBody || !work.resultSessionId) {
      context.addIssue({ code: 'custom', path: ['resultMessageId'], message: 'result reservation must be complete' })
    }
  }
  if (work.status === 'completed' && !work.completedAt) {
    context.addIssue({ code: 'custom', path: ['completedAt'], message: 'completed Work requires a completion time' })
  }
  if (new Set((work.resultArtifacts ?? []).map(item => item.path)).size !== (work.resultArtifacts?.length ?? 0)) {
    context.addIssue({ code: 'custom', path: ['resultArtifacts'], message: 'duplicate Work artifact path' })
  }
  if ((work.resultArtifacts?.length ?? 0) > 0 && !['completing', 'completed'].includes(work.status)) {
    context.addIssue({ code: 'custom', path: ['resultArtifacts'], message: 'Work artifacts require a reserved result' })
  }
  if (work.status === 'cancelled' && (!work.cancelledAt || !work.cancelMessageId || !work.cancelReason || !work.cancelledBySessionId)) {
    context.addIssue({ code: 'custom', path: ['cancelledAt'], message: 'cancelled Work requires a reason and Session' })
  }
})

export type FormalWork = Omit<z.infer<typeof FormalWorkSchema>, 'requester' | 'assignee'> & {
  requester: HomeAddress
  assignee: HomeAddress
}

export const BIZAGENT_WORK_DOMAIN = defineDomain({
  name: 'bizagent_work',
  version: 0,
  tables: { works: domainTable<string, z.infer<typeof FormalWorkSchema>>(FormalWorkSchema) },
})

type WorkDomain = Domain<typeof BIZAGENT_WORK_DOMAIN>

export class WorkLedger {
  private mutationTail: Promise<unknown> = Promise.resolve()
  private constructor(private readonly domain: WorkDomain) {}

  static async open(facility: DomainFacility): Promise<WorkLedger> {
    return new WorkLedger(await facility.open(BIZAGENT_WORK_DOMAIN))
  }

  async withWrite<T>(update: () => Promise<T>): Promise<T> {
    const task = this.mutationTail.catch(() => undefined).then(update)
    this.mutationTail = task
    return task
  }

  get(id: string): FormalWork | undefined {
    const record = this.domain.table('works').get(id)
    return record === undefined ? undefined : FormalWorkSchema.parse(record) as FormalWork
  }

  list(): FormalWork[] {
    return [...this.domain.table('works').entries()]
      .map(([, record]) => FormalWorkSchema.parse(record) as FormalWork)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  }

  async put(work: FormalWork): Promise<void> {
    const parsed = FormalWorkSchema.parse(work) as FormalWork
    await this.domain.table('works').put(parsed.id, parsed)
  }

  async close(): Promise<void> {
    await this.domain.close()
  }
}
