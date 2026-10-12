import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { HomeAddressSchema, stableId, type HomeAddress } from './domain.js'

const ProjectWorkSnapshotSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['completed', 'cancelled']),
  resultMessageId: z.string().min(1).optional(),
})

const ProjectClaimSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1).max(200),
  body: z.string().min(1).max(15000),
  doneWhenAssessment: z.string().min(1).max(4000),
  work: z.array(ProjectWorkSnapshotSchema),
  artifacts: z.array(z.object({
    path: z.string().max(500).refine(path => path.startsWith('artifacts/')
      && !path.includes('\\') && !path.includes('\0')
      && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
    'Project artifact path must be canonical under artifacts/'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative().max(8 * 1024 * 1024),
    snapshot: z.literal(true),
  })).max(10).optional(),
  submittedBySessionId: z.string().min(1),
  submittedAt: z.string().min(1),
})

const ProjectReviewSchema = z.object({
  claimId: z.string().min(1),
  decision: z.enum(['accept', 'rework']),
  reason: z.string().min(1).max(4000),
  reviewedBySessionId: z.string().min(1).optional(),
  reviewedByPrincipal: z.string().trim().min(1).max(200).optional(),
  reviewedAt: z.string().min(1),
}).superRefine((review, context) => {
  if ((review.reviewedBySessionId === undefined) === (review.reviewedByPrincipal === undefined)) {
    context.addIssue({ code: 'custom', message: 'Project review needs exactly one Session or human principal' })
  }
})

export const ProjectSeatSchema = z.object({
  id: z.string().regex(/^seat-[a-f0-9]{20}$/),
  address: z.string().min(1).max(200),
  homeAddress: HomeAddressSchema,
  responsibility: z.string().min(1).max(1000),
  status: z.enum(['active', 'released']),
  joinedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  releasedAt: z.string().datetime().optional(),
}).superRefine((seat, context) => {
  if ((seat.status === 'released') !== (seat.releasedAt !== undefined)) {
    context.addIssue({ code: 'custom', path: ['releasedAt'], message: 'released Seat needs a release time' })
  }
})

export type ProjectSeat = Omit<z.infer<typeof ProjectSeatSchema>, 'homeAddress'> & {
  homeAddress: HomeAddress
}

const ProjectSeatEventSchema = z.object({
  seatAddress: z.string().min(1).max(200),
  homeAddress: HomeAddressSchema,
  action: z.enum(['joined', 'responsibility-updated', 'released', 'rejoined']),
  responsibility: z.string().min(1).max(1000),
  bySessionId: z.string().min(1),
  at: z.string().datetime(),
})

export const FormalProjectSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  idempotencyKey: z.string().min(1).max(128),
  lead: HomeAddressSchema,
  driver: z.string().regex(/^project:project-[a-f0-9]{20}$/).optional(),
  createdBySessionId: z.string().min(1),
  title: z.string().min(1).max(120),
  goal: z.string().min(1).max(4000),
  doneWhen: z.string().min(1).max(2000),
  status: z.enum(['open', 'awaiting_acceptance', 'accepted']),
  revision: z.number().int().positive(),
  claims: z.array(ProjectClaimSchema),
  reviews: z.array(ProjectReviewSchema),
  seats: z.array(ProjectSeatSchema).max(32).optional(),
  seatEvents: z.array(ProjectSeatEventSchema).optional(),
  currentClaimId: z.string().min(1).optional(),
  acceptedClaimId: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).superRefine((project, context) => {
  if (project.driver !== undefined && project.driver !== `project:${project.id}`) {
    context.addIssue({ code: 'custom', path: ['driver'], message: 'Project driver must be its own Main address' })
  }
  const claimIds = new Set(project.claims.map(claim => claim.id))
  const reviewedIds = new Set(project.reviews.map(review => review.claimId))
  const seats = project.seats ?? []
  if (new Set(seats.map(seat => seat.homeAddress)).size !== seats.length
    || new Set(seats.map(seat => seat.address)).size !== seats.length) {
    context.addIssue({ code: 'custom', path: ['seats'], message: 'Project Seat Home and address must be unique' })
  }
  for (const [index, seat] of seats.entries()) {
    if (seat.id !== stableId('seat', seat.homeAddress)
      || seat.address !== `seat:${project.id}:${seat.id}`
      || seat.homeAddress === project.lead || seat.homeAddress.startsWith('personal:')) {
      context.addIssue({ code: 'custom', path: ['seats', index], message: 'Project Seat identity is invalid' })
    }
  }
  for (const [index, event] of (project.seatEvents ?? []).entries()) {
    if (!seats.some(seat => seat.address === event.seatAddress && seat.homeAddress === event.homeAddress)) {
      context.addIssue({ code: 'custom', path: ['seatEvents', index], message: 'Project Seat event has no matching Seat' })
    }
  }
  if (claimIds.size !== project.claims.length) {
    context.addIssue({ code: 'custom', path: ['claims'], message: 'duplicate Project claim' })
  }
  for (const [index, claim] of project.claims.entries()) {
    const paths = (claim.artifacts ?? []).map(artifact => artifact.path)
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: 'custom', path: ['claims', index, 'artifacts'], message: 'duplicate Project artifact' })
    }
  }
  if (reviewedIds.size !== project.reviews.length) {
    context.addIssue({ code: 'custom', path: ['reviews'], message: 'duplicate Project review' })
  }
  if (project.revision !== 1 + project.claims.length + project.reviews.length
    + (project.seatEvents?.length ?? 0)) {
    context.addIssue({ code: 'custom', path: ['revision'], message: 'Project revision does not match its history' })
  }
  if (project.currentClaimId !== undefined && !claimIds.has(project.currentClaimId)) {
    context.addIssue({ code: 'custom', path: ['currentClaimId'], message: 'current claim is missing' })
  }
  if (project.currentClaimId !== project.claims.at(-1)?.id) {
    context.addIssue({ code: 'custom', path: ['currentClaimId'], message: 'current claim must be the latest version' })
  }
  if (project.acceptedClaimId !== undefined && !claimIds.has(project.acceptedClaimId)) {
    context.addIssue({ code: 'custom', path: ['acceptedClaimId'], message: 'accepted claim is missing' })
  }
  if (project.status === 'awaiting_acceptance' && project.currentClaimId === undefined) {
    context.addIssue({ code: 'custom', path: ['currentClaimId'], message: 'submission is required' })
  }
  if (project.status === 'accepted' && project.acceptedClaimId === undefined) {
    context.addIssue({ code: 'custom', path: ['acceptedClaimId'], message: 'acceptance is required' })
  }
  if (project.status === 'accepted' && (project.acceptedClaimId !== project.currentClaimId
    || project.reviews.at(-1)?.decision !== 'accept'
    || project.reviews.at(-1)?.claimId !== project.currentClaimId)) {
    context.addIssue({ code: 'custom', path: ['acceptedClaimId'], message: 'accepted Project requires a review of the current claim' })
  }
  if (project.status === 'awaiting_acceptance' && reviewedIds.has(project.currentClaimId ?? '')) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'pending claim is already reviewed' })
  }
  if (project.status === 'open' && project.claims.length > 0
    && (project.reviews.at(-1)?.decision !== 'rework'
      || project.reviews.at(-1)?.claimId !== project.currentClaimId)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'open Project with a claim requires rework' })
  }
  for (const [index, review] of project.reviews.entries()) {
    if (!claimIds.has(review.claimId)) {
      context.addIssue({ code: 'custom', path: ['reviews', index], message: 'reviewed claim is missing' })
    }
  }
})

export type FormalProject = Omit<z.infer<typeof FormalProjectSchema>, 'lead' | 'seats'> & {
  lead: HomeAddress
  seats?: ProjectSeat[]
}

export const BIZAGENT_PROJECT_DOMAIN = defineDomain({
  name: 'bizagent_project',
  version: 0,
  tables: { projects: domainTable<string, z.infer<typeof FormalProjectSchema>>(FormalProjectSchema) },
})

type ProjectDomain = Domain<typeof BIZAGENT_PROJECT_DOMAIN>

export class ProjectLedger {
  private mutationTail: Promise<unknown> = Promise.resolve()
  private constructor(private readonly domain: ProjectDomain) {}

  static async open(facility: DomainFacility): Promise<ProjectLedger> {
    return new ProjectLedger(await facility.open(BIZAGENT_PROJECT_DOMAIN))
  }

  async withWrite<T>(update: () => Promise<T>): Promise<T> {
    const task = this.mutationTail.catch(() => undefined).then(update)
    this.mutationTail = task
    return task
  }

  get(id: string): FormalProject | undefined {
    const record = this.domain.table('projects').get(id)
    return record === undefined ? undefined : FormalProjectSchema.parse(record) as FormalProject
  }

  list(): FormalProject[] {
    return [...this.domain.table('projects').entries()]
      .map(([, record]) => FormalProjectSchema.parse(record) as FormalProject)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  }

  async put(project: FormalProject): Promise<void> {
    const parsed = FormalProjectSchema.parse(project) as FormalProject
    await this.domain.table('projects').put(parsed.id, parsed)
  }

  async close(): Promise<void> {
    await this.domain.close()
  }
}
