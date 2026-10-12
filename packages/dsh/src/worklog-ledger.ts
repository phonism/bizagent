import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { HomeAddressSchema, type HomeAddress } from './domain.js'

export const WorklogRevisionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  sessionId: z.string().min(1),
  homeAddress: HomeAddressSchema,
  revision: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(128),
  description: z.string().min(1).max(240),
  body: z.string().min(1).max(16000),
  status: z.enum(['ongoing', 'completed', 'blocked', 'failed']),
  origin: z.enum(['agent', 'work-result', 'session-activity']).optional(),
  cwd: z.string().min(1).optional(),
  evidence: z.object({
    fromSeq: z.number().int().nonnegative(),
    toSeq: z.number().int().nonnegative(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  files: z.array(z.object({
    path: z.string().min(1).max(500),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative().max(8 * 1024 * 1024),
    snapshot: z.literal(true).optional(),
  })).max(10),
  projectId: z.string().min(1).optional(),
  workId: z.string().min(1).optional(),
  recordedAt: z.string().min(1),
}).superRefine((revision, context) => {
  if (revision.evidence.fromSeq > revision.evidence.toSeq) {
    context.addIssue({ code: 'custom', path: ['evidence'], message: 'Worklog evidence range is reversed' })
  }
  if (new Set(revision.files.map(file => file.path)).size !== revision.files.length) {
    context.addIssue({ code: 'custom', path: ['files'], message: 'duplicate Worklog file reference' })
  }
})

export type WorklogRevision = Omit<z.infer<typeof WorklogRevisionSchema>, 'homeAddress'> & {
  homeAddress: HomeAddress
}

export const BIZAGENT_WORKLOG_DOMAIN = defineDomain({
  name: 'bizagent_worklog',
  version: 0,
  tables: { revisions: domainTable<string, z.infer<typeof WorklogRevisionSchema>>(WorklogRevisionSchema) },
})

type WorklogDomain = Domain<typeof BIZAGENT_WORKLOG_DOMAIN>

export class WorklogLedger {
  private mutationTail: Promise<unknown> = Promise.resolve()
  private constructor(private readonly domain: WorklogDomain) {}

  static async open(facility: DomainFacility): Promise<WorklogLedger> {
    return new WorklogLedger(await facility.open(BIZAGENT_WORKLOG_DOMAIN))
  }

  async withWrite<T>(update: () => Promise<T>): Promise<T> {
    const task = this.mutationTail.catch(() => undefined).then(update)
    this.mutationTail = task
    return task
  }

  get(id: string): WorklogRevision | undefined {
    const record = this.domain.table('revisions').get(id)
    return record === undefined ? undefined : WorklogRevisionSchema.parse(record) as WorklogRevision
  }

  listVersions(sessionId: string): WorklogRevision[] {
    return this.all().filter(item => item.sessionId === sessionId)
      .sort((a, b) => a.revision - b.revision)
  }

  listLatest(homeAddress: HomeAddress): WorklogRevision[] {
    const latest = new Map<string, WorklogRevision>()
    for (const item of this.all()) {
      if (item.homeAddress !== homeAddress) continue
      const current = latest.get(item.sessionId)
      if (current === undefined || item.revision > current.revision) latest.set(item.sessionId, item)
    }
    return [...latest.values()]
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.sessionId.localeCompare(a.sessionId))
  }

  async put(revision: WorklogRevision): Promise<void> {
    const parsed = WorklogRevisionSchema.parse(revision) as WorklogRevision
    if (this.get(parsed.id) !== undefined) throw new Error(`Worklog revision already exists: ${parsed.id}`)
    await this.domain.table('revisions').put(parsed.id, parsed)
  }

  async close(): Promise<void> {
    await this.domain.close()
  }

  private all(): WorklogRevision[] {
    return [...this.domain.table('revisions').entries()]
      .map(([, record]) => WorklogRevisionSchema.parse(record) as WorklogRevision)
  }
}
