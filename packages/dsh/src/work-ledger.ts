import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { HomeAddressSchema, stableId, type HomeAddress } from './domain.js'

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
  requesterSeatAddress: z.string().min(1).max(200).optional(),
  assigneeSeatAddress: z.string().min(1).max(200).optional(),
  workflowNodeId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
  workflowAttempt: z.number().int().positive().optional(),
  workflowExecutionEpoch: z.number().int().nonnegative().optional(),
  /** Frozen when a Workflow result is reserved; later progression changes cannot bypass this review. */
  workflowReview: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('automatic'), progressionRevision: z.number().int().nonnegative() }),
    z.object({ mode: z.literal('reviewed'), progressionRevision: z.number().int().nonnegative(),
      reviewerHome: HomeAddressSchema, criteria: z.string().min(1).max(4000) }),
  ]).optional(),
  status: z.enum(['open', 'accepted', 'completing', 'completed', 'cancelled']),
  requestMessageId: z.string().min(1),
  /** Frozen at dispatch. Old records have no automatic startup intent. */
  autoStart: z.boolean().optional(),
  workerSessionId: z.string().min(1).optional(),
  workerCwd: z.string().min(1).optional(),
  supplements: z.array(z.object({
    id: z.string().min(1),
    requestId: z.string().min(1).max(128),
    epoch: z.number().int().nonnegative(),
    message: z.string().min(1).max(4000),
    bySessionId: z.string().min(1),
    createdAt: z.string().min(1),
  })).max(100).optional(),
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
  cancelledByProjectSessionId: z.string().min(1).optional(),
  cancelledByProjectPrincipal: z.string().min(1).max(200).optional(),
}).superRefine((work, context) => {
  if (work.requester === work.assignee && work.workflowNodeId === undefined) {
    context.addIssue({ code: 'custom', path: ['assignee'], message: 'same-Home Work requires a Project Workflow node' })
  }
  if (work.supplements !== undefined && (work.projectId === undefined
    || new Set(work.supplements.map(item => item.requestId)).size !== work.supplements.length
    || new Set(work.supplements.map(item => item.id)).size !== work.supplements.length)) {
    context.addIssue({ code: 'custom', path: ['supplements'],
      message: 'Project Work supplements require a Project and unique request IDs' })
  }
  if ((work.workflowNodeId === undefined) !== (work.workflowAttempt === undefined)
    || (work.workflowNodeId !== undefined && work.projectId === undefined)) {
    context.addIssue({ code: 'custom', path: ['workflowNodeId'], message: 'Workflow Work requires a Project, node, and attempt' })
  }
  if (work.workflowExecutionEpoch !== undefined && work.workflowNodeId === undefined) {
    context.addIssue({ code: 'custom', path: ['workflowExecutionEpoch'],
      message: 'Workflow execution epoch requires a Workflow Work node' })
  }
  if (work.workflowReview !== undefined && (work.workflowNodeId === undefined
    || !['completing', 'completed'].includes(work.status))) {
    context.addIssue({ code: 'custom', path: ['workflowReview'],
      message: 'Workflow review gate requires a reserved Workflow result' })
  }
  if ((work.requesterSeatAddress !== undefined || work.assigneeSeatAddress !== undefined)
    && work.projectId === undefined) {
    context.addIssue({ code: 'custom', path: ['projectId'], message: 'Project Seat Work requires a Project' })
  }
  if (work.requesterSeatAddress !== undefined && work.requesterSeatAddress
    !== `seat:${work.projectId}:${stableId('seat', work.requester)}`) {
    context.addIssue({ code: 'custom', path: ['requesterSeatAddress'], message: 'Work requester Seat does not match its Home' })
  }
  if (work.assigneeSeatAddress !== undefined && work.assigneeSeatAddress
    !== `seat:${work.projectId}:${stableId('seat', work.assignee)}`) {
    context.addIssue({ code: 'custom', path: ['assigneeSeatAddress'], message: 'Work assignee Seat does not match its Home' })
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
  if ((work.cancelledByProjectSessionId !== undefined || work.cancelledByProjectPrincipal !== undefined)
    && (work.projectId === undefined || work.status !== 'cancelled'
      || (work.cancelledByProjectSessionId !== undefined) === (work.cancelledByProjectPrincipal !== undefined))) {
    context.addIssue({ code: 'custom', path: ['cancelledByProjectSessionId'],
      message: 'Project pause cancellation requires a cancelled linked Work' })
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
