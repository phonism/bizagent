import { createHash } from 'node:crypto'
import { z } from 'zod'

export const HOME_TYPES = ['personal', 'business', 'role', 'capability'] as const
export type HomeType = typeof HOME_TYPES[number]

export const ORGANIZATION_RELATIONS = ['member-of', 'fulfills-role', 'serves'] as const
export type OrganizationRelation = typeof ORGANIZATION_RELATIONS[number]

export const ASSET_KINDS = ['memory', 'insight', 'knowledge', 'method', 'identity'] as const
export type AssetKind = typeof ASSET_KINDS[number]

export const ASSET_STATUSES = ['candidate', 'active', 'superseded', 'retired'] as const
export type AssetStatus = typeof ASSET_STATUSES[number]

export const HomeAddressSchema = z.string().refine((value) => {
  const separator = value.indexOf(':')
  if (separator <= 0 || separator === value.length - 1) return false
  return (HOME_TYPES as readonly string[]).includes(value.slice(0, separator))
    && /^[a-z0-9][a-z0-9._/-]*$/i.test(value.slice(separator + 1))
}, 'expected <personal|business|role|capability>:<id>')

export type HomeAddress = `${HomeType}:${string}`

export const EvidenceRefSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session-events'),
    sessionId: z.string().min(1),
    fromSeq: z.number().int().nonnegative(),
    toSeq: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('tool-result'),
    sessionId: z.string().min(1),
    eventSeq: z.number().int().nonnegative(),
    toolCallId: z.string().min(1),
  }),
  z.object({
    type: z.literal('artifact'),
    uri: z.string().min(1),
    digest: z.string().min(1),
  }),
  z.object({
    type: z.literal('document'),
    uri: z.string().min(1),
    digest: z.string().min(1),
    authority: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('asset'),
    ownerAddress: HomeAddressSchema,
    assetId: z.string().min(1),
    revision: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('user-confirmation'),
    sessionId: z.string().min(1),
    eventSeq: z.number().int().nonnegative(),
  }),
])

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>

export const AgentHomeSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  address: HomeAddressSchema,
  type: z.enum(HOME_TYPES),
  displayName: z.string().min(1),
  owner: z.string().min(1).optional(),
  revision: z.number().int().positive(),
  contextDigest: z.string(),
  status: z.enum(['active', 'archived']),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

export type AgentHome = z.infer<typeof AgentHomeSchema> & { address: HomeAddress }

export const OrganizationLinkSchema = z.object({
  from: HomeAddressSchema,
  to: HomeAddressSchema,
  relation: z.enum(ORGANIZATION_RELATIONS),
})

export const OrganizationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  name: z.string().min(1),
  mission: z.string().min(1),
  businessHome: HomeAddressSchema,
  members: z.array(z.object({
    personalHome: HomeAddressSchema,
    roleHome: HomeAddressSchema,
  })).min(1),
  capabilityHomes: z.array(HomeAddressSchema),
  links: z.array(OrganizationLinkSchema),
  revision: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).superRefine((organization, context) => {
  if (!organization.businessHome.startsWith('business:')) {
    context.addIssue({ code: 'custom', path: ['businessHome'], message: 'businessHome must be a Business Home' })
  }
  const declared = new Set<string>([organization.businessHome])
  const seenMembers = new Set<string>()
  organization.members.forEach((member, index) => {
    if (!member.personalHome.startsWith('personal:')) {
      context.addIssue({ code: 'custom', path: ['members', index, 'personalHome'], message: 'member must use a Personal Home' })
    }
    if (!member.roleHome.startsWith('role:')) {
      context.addIssue({ code: 'custom', path: ['members', index, 'roleHome'], message: 'member role must use a Role Home' })
    }
    if (seenMembers.has(member.personalHome)) {
      context.addIssue({ code: 'custom', path: ['members', index, 'personalHome'], message: 'duplicate organization member' })
    }
    seenMembers.add(member.personalHome)
    declared.add(member.personalHome)
    declared.add(member.roleHome)
  })
  organization.capabilityHomes.forEach((address, index) => {
    if (!address.startsWith('capability:')) {
      context.addIssue({ code: 'custom', path: ['capabilityHomes', index], message: 'capability must use a Capability Home' })
    }
    declared.add(address)
  })
  organization.links.forEach((link, index) => {
    if (!declared.has(link.from) || !declared.has(link.to)) {
      context.addIssue({ code: 'custom', path: ['links', index], message: 'link endpoints must belong to this organization' })
    }
    const validShape = link.relation === 'member-of'
      ? link.from.startsWith('personal:') && link.to === organization.businessHome
      : link.relation === 'fulfills-role'
        ? link.from.startsWith('personal:') && link.to.startsWith('role:')
        : (link.from.startsWith('role:') || link.from.startsWith('capability:'))
          && link.to === organization.businessHome
    if (!validShape) context.addIssue({ code: 'custom', path: ['links', index], message: 'relation has invalid Home types' })
  })
})

export type Organization = Omit<z.infer<typeof OrganizationSchema>, 'businessHome' | 'members' | 'capabilityHomes' | 'links'> & {
  businessHome: HomeAddress
  members: Array<{ personalHome: HomeAddress; roleHome: HomeAddress }>
  capabilityHomes: HomeAddress[]
  links: Array<{ from: HomeAddress; to: HomeAddress; relation: OrganizationRelation }>
}

export const AssetMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  ownerAddress: HomeAddressSchema,
  kind: z.enum(ASSET_KINDS),
  title: z.string().min(1).optional(),
  description: z.string().min(1).max(1000),
  tags: z.array(z.string().min(1).max(80)).default([]),
  sourceRefs: z.array(EvidenceRefSchema).min(1),
  confidence: z.number().min(0).max(1),
  fitness: z.number().min(-1).max(1),
  status: z.enum(ASSET_STATUSES),
  revision: z.number().int().positive(),
  proposalId: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

export type AssetMetadata = z.infer<typeof AssetMetadataSchema> & { ownerAddress: HomeAddress }

export interface StoredAsset extends AssetMetadata {
  body: string
  bodyPath: string
}

export const SessionBindingSchema = z.object({
  sessionId: z.string().min(1),
  homeAddress: HomeAddressSchema,
  cwd: z.string().optional(),
  boundAt: z.string().min(1),
})

export type SessionBinding = z.infer<typeof SessionBindingSchema> & { homeAddress: HomeAddress }

export const MemoryProposalSchema = z.object({
  id: z.string().min(1),
  fromAddress: HomeAddressSchema,
  toAddress: HomeAddressSchema,
  proposedKind: z.enum(ASSET_KINDS),
  description: z.string().min(1).max(1000),
  body: z.string().min(1),
  tags: z.array(z.string().min(1).max(80)).default([]),
  sourceRefs: z.array(EvidenceRefSchema).min(1),
  status: z.enum(['pending', 'accepted', 'rejected', 'withdrawn']),
  targetAssetId: z.string().min(1).optional(),
  decision: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  decidedAt: z.string().min(1).optional(),
})

export type MemoryProposal = z.infer<typeof MemoryProposalSchema> & {
  fromAddress: HomeAddress
  toAddress: HomeAddress
}

export const FITNESS_SIGNALS = ['retrieved', 'applied', 'confirmed', 'contradicted', 'failed'] as const
export type FitnessSignal = typeof FITNESS_SIGNALS[number]

export const FitnessReceiptSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  ownerAddress: HomeAddressSchema,
  sessionId: z.string().min(1),
  eventSeq: z.number().int().nonnegative().optional(),
  signal: z.enum(FITNESS_SIGNALS),
  outcome: z.string().min(1).optional(),
  createdAt: z.string().min(1),
})

export type FitnessReceipt = z.infer<typeof FitnessReceiptSchema> & { ownerAddress: HomeAddress }

export const LEARNING_CHECKPOINT_STATUSES = ['pending', 'remembered', 'skipped', 'failed'] as const
export type LearningCheckpointStatus = typeof LEARNING_CHECKPOINT_STATUSES[number]

export const LearningCheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  sessionId: z.string().min(1),
  turn: z.number().int().nonnegative(),
  homeAddress: HomeAddressSchema,
  reason: z.literal('explicit-correction'),
  status: z.enum(LEARNING_CHECKPOINT_STATUSES),
  evidenceRef: EvidenceRefSchema,
  excerpt: z.string().min(1).max(4000),
  assetId: z.string().min(1).optional(),
  decision: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  settledAt: z.string().min(1).optional(),
})

export type LearningCheckpoint = z.infer<typeof LearningCheckpointSchema> & { homeAddress: HomeAddress }

export interface ContextBudget {
  identityMaxBytes: number
  indexMaxBytes: number
}

export function parseHomeAddress(value: string): HomeAddress {
  return HomeAddressSchema.parse(value) as HomeAddress
}

export function homeTypeOf(address: HomeAddress): HomeType {
  return address.slice(0, address.indexOf(':')) as HomeType
}

export function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 20)}`
}

export function safeHomeId(address: HomeAddress): string {
  const readable = address
    .toLowerCase()
    .replace(':', '--')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return `${readable}-${createHash('sha256').update(address).digest('hex').slice(0, 8)}`
}

export function nowIso(): string {
  return new Date().toISOString()
}
