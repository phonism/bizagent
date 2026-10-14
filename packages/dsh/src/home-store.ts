import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import {
  AgentHomeSchema,
  AssetMetadataSchema,
  OrganizationSchema,
  type AgentHome,
  type AssetKind,
  type AssetMetadata,
  type AssetStatus,
  type ContextBudget,
  type EvidenceRef,
  type HomeAddress,
  type Organization,
  type StoredAsset,
  homeTypeOf,
  nowIso,
  parseHomeAddress,
  safeHomeId,
} from './domain.js'
import { DEFAULT_INBOX_WAKE_POLICY, InboxWakePolicySchema, type InboxWakePolicy } from './inbox-wake-policy.js'
import { readRegularFileNoFollow, writeFileDurably } from './safe-file.js'
import { assertKnownFormat } from './known-format.js'

const DIRECTORY_SCHEMA = z.object({
  schemaVersion: z.literal(1),
  homes: z.array(z.object({
    id: z.string().min(1),
    address: z.string().min(1),
    path: z.string().min(1),
    /** Owner recorded by this store; null records "no owner". Absent in directories written before 1.0. */
    owner: z.string().min(1).nullable().optional(),
  })),
})

const KIND_DIRECTORY: Record<Exclude<AssetKind, 'identity'>, string> = {
  memory: 'memory',
  insight: 'insights',
  knowledge: 'knowledge',
  method: 'methods',
}

interface HomeCache {
  home: AgentHome
  directory: string
  identity: string
  assets: Map<string, StoredAsset>
}

export interface CreateHomeInput {
  address: string
  displayName?: string
  owner?: string
  identity?: string
}

export interface CreateOrganizationInput {
  id: string
  name: string
  mission: string
  /** Person who owns every Home in the organization. Defaults to each member id (members as people). */
  owner?: string
  members: Array<{
    id: string
    displayName: string
    roleId: string
    roleName: string
    responsibility: string
  }>
  capabilities: Array<{
    id: string
    displayName: string
    responsibility: string
  }>
}

export interface CreateAssetInput {
  id: string
  ownerAddress: HomeAddress
  kind: Exclude<AssetKind, 'identity'>
  title?: string
  description: string
  body: string
  tags?: string[]
  sourceRefs: EvidenceRef[]
  confidence?: number
  fitness?: number
  status?: AssetStatus
  proposalId?: string
}

export interface UpdateAssetInput {
  /** Checked inside the serialized mutation, before reading or writing a new revision. */
  expectedRevision?: number
  description?: string
  body?: string
  tags?: string[]
  sourceRefs?: EvidenceRef[]
  status?: AssetStatus
  confidence?: number
  fitness?: number
  /** Internal recovery marker, persisted in the same file revision as a proposal replacement. */
  appliedProposalId?: string
}

export interface AssetSearchInput {
  query?: string
  kind?: AssetKind
  status?: AssetStatus
  limit?: number
}

export interface DoctorReport {
  ok: boolean
  root: string
  homeCount: number
  assetCount: number
  issues: string[]
}

export class HomeStore {
  readonly root: string
  readonly homesRoot: string
  readonly organizationFile: string
  private readonly homes = new Map<HomeAddress, HomeCache>()
  private organization: Organization | undefined
  private organizationLoadError: string | undefined
  private integrityIssues: string[] = []
  private mutationTail: Promise<unknown> = Promise.resolve()

  constructor(root: string) {
    this.root = resolve(root)
    this.homesRoot = join(this.root, 'homes')
    this.organizationFile = join(this.root, 'organization.yaml')
  }

  async initialize(): Promise<void> {
    if (!isAbsolute(this.root)) throw new Error(`BizAgent home root must be absolute: ${this.root}`)
    await mkdir(this.homesRoot, { recursive: true })
    const actualRoot = await realpath(this.root)
    if (actualRoot !== this.root) {
      throw new Error(`BizAgent home root may not be a symlink: ${this.root} -> ${actualRoot}`)
    }
    await this.reload()
  }

  async reload(): Promise<void> {
    this.integrityIssues = []
    const recordedOwners = await this.readRecordedOwners()
    this.homes.clear()
    this.organization = undefined
    const entries = await readdir(this.homesRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.endsWith('.tmp')) continue
      const directory = join(this.homesRoot, entry.name)
      let cache: HomeCache
      try {
        cache = await this.loadHome(directory)
      } catch (error) {
        // A Home that fails to load or validate stays unavailable, but must not take the other
        // Homes down with it; doctor and health report why it was skipped.
        this.integrityIssues.push(`Agent Home skipped: ${this.relativePath(directory)}: ${this.relativeMessage(error)}`)
        continue
      }
      if (this.homes.has(cache.home.address)) {
        this.integrityIssues.push(`Agent Home skipped: duplicate address ${cache.home.address} at ${this.relativePath(directory)}`)
        continue
      }
      this.keepRecordedOwner(cache, recordedOwners)
      this.homes.set(cache.home.address, cache)
    }
    await this.loadOrganization()
    await this.writeDirectory()
  }

  listHomes(): AgentHome[] {
    return [...this.homes.values()]
      .map(cache => structuredClone(cache.home))
      .sort((a, b) => a.address.localeCompare(b.address))
  }

  hasHome(address: string): boolean {
    try {
      return this.homes.has(parseHomeAddress(address))
    } catch {
      return false
    }
  }

  getHome(address: string): AgentHome {
    return structuredClone(this.requireHome(parseHomeAddress(address)).home)
  }

  /** Any loaded Home, including an archived one, or undefined; never throws for an unknown address. */
  findHome(address: string): AgentHome | undefined {
    let parsed: HomeAddress
    try { parsed = parseHomeAddress(address) } catch { return undefined }
    const cache = this.homes.get(parsed)
    return cache === undefined ? undefined : structuredClone(cache.home)
  }

  /** The Home's fixed DSH Workspace, shared by Principal, Project Main and Seats. */
  homeWorkspacePath(address: string): string {
    return this.requireHome(parseHomeAddress(address)).directory
  }

  /** Home-local receipt policy. Missing or malformed files use the 15-minute batch default. */
  async readInboxWakePolicy(address: string): Promise<InboxWakePolicy> {
    const file = join(this.requireHome(parseHomeAddress(address)).directory, 'inbox.json')
    try {
      const bytes = await readRegularFileNoFollow(file, { maxBytes: 4096 })
      return InboxWakePolicySchema.parse(JSON.parse(bytes.toString('utf8')))
    } catch { return DEFAULT_INBOX_WAKE_POLICY }
  }

  getIdentity(address: string): string {
    return this.requireHome(parseHomeAddress(address)).identity
  }

  getOrganization(): Organization | undefined {
    return this.organization === undefined ? undefined : structuredClone(this.organization)
  }

  async createHome(input: CreateHomeInput): Promise<AgentHome> {
    return this.mutate(async () => this.createHomeUnlocked(input, true, false))
  }

  async createOrganization(input: CreateOrganizationInput): Promise<Organization> {
    return this.mutate(async () => {
      if (this.organization !== undefined) {
        if (this.organization.id === input.id) return structuredClone(this.organization)
        throw new Error(`organization already exists: ${this.organization.id}`)
      }
      if (this.organizationLoadError !== undefined) {
        throw new Error('organization.yaml exists but could not be loaded; fix or move it before creating an organization')
      }

      const id = normalizeId(input.id, 'organization')
      const name = normalizeLabel(input.name, 'organization name')
      const mission = normalizeBody(input.mission)
      if (input.members.length === 0) throw new Error('organization must have at least one member')

      const lineHome = parseHomeAddress(`line:${id}`)
      const businessHome = parseHomeAddress(`business:${id}`)
      const lineOwner = input.owner ?? normalizeId(input.members[0]!.id, 'line owner')
      const memberHomes: Organization['members'] = []
      const capabilityHomes: HomeAddress[] = []
      const links: Organization['links'] = []
      const homeInputs: CreateHomeInput[] = [{
        address: lineHome,
        displayName: `${name} PMO`,
        owner: lineOwner,
        identity: `${name} product line PMO. Coordinate its enduring organization and Projects.\n\nMission: ${mission}`,
      }, {
        address: businessHome,
        displayName: name,
        owner: lineOwner,
        identity: `${name} exists to ${mission}\n\nThis Business Home owns shared goals, decisions, and organizational learning.`,
      }]
      const addresses = new Set<string>([lineHome, businessHome])
      links.push({ from: businessHome, to: lineHome, relation: 'belongs-to-line' })
      const roles = new Map<string, { name: string; responsibility: string }>()

      for (const member of input.members) {
        const memberId = normalizeId(member.id, 'member')
        const roleId = normalizeId(member.roleId, 'role')
        const displayName = normalizeLabel(member.displayName, 'member name')
        const roleName = normalizeLabel(member.roleName, 'role name')
        const responsibility = normalizeBody(member.responsibility)
        const personalHome = parseHomeAddress(`personal:${memberId}`)
        const roleHome = parseHomeAddress(`role:${roleId}`)
        if (addresses.has(personalHome)) throw new Error(`duplicate member id: ${memberId}`)
        addresses.add(personalHome)

        const existingRole = roles.get(roleId)
        if (existingRole !== undefined
          && (existingRole.name !== roleName || existingRole.responsibility !== responsibility)) {
          throw new Error(`role ${roleId} has conflicting definitions`)
        }
        if (existingRole === undefined) {
          roles.set(roleId, { name: roleName, responsibility })
          addresses.add(roleHome)
          homeInputs.push({
            address: roleHome,
            displayName: roleName,
            owner: lineOwner,
            identity: `${roleName} serves ${name}.\n\nEnduring responsibility: ${responsibility}`,
          })
          links.push({ from: roleHome, to: businessHome, relation: 'serves' })
          links.push({ from: roleHome, to: lineHome, relation: 'belongs-to-line' })
        }

        homeInputs.push({
          address: personalHome,
          displayName,
          owner: input.owner ?? memberId,
          identity: `${displayName} is a member of ${name} and fulfills the ${roleName} role.\n\nResponsibility: ${responsibility}`,
        })
        memberHomes.push({ personalHome, roleHome })
        links.push(
          { from: personalHome, to: businessHome, relation: 'member-of' },
          { from: personalHome, to: roleHome, relation: 'fulfills-role' },
        )
      }

      for (const capability of input.capabilities) {
        const capabilityId = normalizeId(capability.id, 'capability')
        const displayName = normalizeLabel(capability.displayName, 'capability name')
        const responsibility = normalizeBody(capability.responsibility)
        const capabilityHome = parseHomeAddress(`capability:${capabilityId}`)
        if (addresses.has(capabilityHome)) throw new Error(`duplicate capability id: ${capabilityId}`)
        addresses.add(capabilityHome)
        capabilityHomes.push(capabilityHome)
        homeInputs.push({
          address: capabilityHome,
          displayName,
          owner: lineOwner,
          identity: `${displayName} is a reusable organizational capability of ${name}.\n\nIt owns: ${responsibility}`,
        })
        links.push({ from: capabilityHome, to: businessHome, relation: 'serves' })
        links.push({ from: capabilityHome, to: lineHome, relation: 'belongs-to-line' })
      }

      // Homes are idempotent, so a failed setup can be retried safely before the
      // manifest is committed. The organization becomes visible only after every
      // referenced Home exists.
      for (const homeInput of homeInputs) await this.createHomeUnlocked(homeInput, false, true)

      const createdAt = nowIso()
      const organization = OrganizationSchema.parse({
        schemaVersion: 1,
        id,
        name,
        mission,
        lineHome,
        businessHome,
        members: memberHomes,
        capabilityHomes,
        links,
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      }) as Organization
      await atomicWrite(this.organizationFile, YAML.stringify(organization, { lineWidth: 0 }))
      this.organization = organization
      await this.writeDirectory()
      return structuredClone(organization)
    })
  }

  listAssets(address: string, status?: AssetStatus): StoredAsset[] {
    const cache = this.requireHome(parseHomeAddress(address))
    return [...cache.assets.values()]
      .filter(asset => status === undefined || asset.status === status)
      .map(asset => structuredClone(asset))
      .sort(compareAssets)
  }

  searchAssets(address: string, input: AssetSearchInput = {}): StoredAsset[] {
    const cache = this.requireHome(parseHomeAddress(address))
    const query = input.query?.trim().toLocaleLowerCase()
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
    return [...cache.assets.values()]
      .filter(asset => input.kind === undefined || asset.kind === input.kind)
      .filter(asset => input.status === undefined ? asset.status === 'active' : asset.status === input.status)
      .filter((asset) => {
        if (!query) return true
        const haystack = [asset.id, asset.title, asset.description, asset.tags.join(' '), asset.body]
          .filter((value): value is string => typeof value === 'string')
          .join('\n')
          .toLocaleLowerCase()
        return haystack.includes(query)
      })
      .sort(compareAssets)
      .slice(0, limit)
      .map(asset => structuredClone(asset))
  }

  readAsset(address: string, id: string): StoredAsset {
    const asset = this.requireHome(parseHomeAddress(address)).assets.get(id)
    if (asset === undefined) throw new Error(`asset not found in ${address}: ${id}`)
    return structuredClone(asset)
  }

  findAssetByProposalId(address: string, proposalId: string): StoredAsset | undefined {
    const cache = this.requireHome(parseHomeAddress(address))
    const found = [...cache.assets.values()].find(asset => asset.proposalId === proposalId
      || asset.proposalApplications?.some(application => application.proposalId === proposalId))
    return found === undefined ? undefined : structuredClone(found)
  }

  async createAsset(input: CreateAssetInput): Promise<StoredAsset> {
    return this.mutate(async () => {
      const cache = this.requireHome(input.ownerAddress)
      const existing = cache.assets.get(input.id)
      if (existing !== undefined) {
        if ((input.proposalId !== undefined && existing.proposalId === input.proposalId)
          || (existing.kind === input.kind
            && existing.description === input.description.trim()
            && existing.body === normalizeBody(input.body)
            && JSON.stringify(existing.tags) === JSON.stringify(normalizeTags(input.tags ?? [])))) {
          return structuredClone(existing)
        }
        throw new Error(`asset id collision in ${input.ownerAddress}: ${input.id}`)
      }

      const now = nowIso()
      const body = normalizeBody(input.body)
      const metadata = AssetMetadataSchema.parse({
        schemaVersion: 1,
        id: input.id,
        ownerAddress: input.ownerAddress,
        kind: input.kind,
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        description: input.description.trim(),
        tags: normalizeTags(input.tags ?? []),
        sourceRefs: input.sourceRefs,
        confidence: input.confidence ?? 0.7,
        fitness: input.fitness ?? 0,
        status: input.status ?? 'active',
        revision: 1,
        ...(input.proposalId !== undefined ? { proposalId: input.proposalId } : {}),
        ...(input.proposalId !== undefined ? { proposalApplications: [{ proposalId: input.proposalId,
          revision: 1, bodySha256: createHash('sha256').update(body).digest('hex') }] } : {}),
        createdAt: now,
        updatedAt: now,
      }) as AssetMetadata
      const bodyPath = this.assetPath(cache, input.kind, metadata.id)
      const stored: StoredAsset = { ...metadata, body, bodyPath }
      await atomicWrite(bodyPath, renderAsset(stored))
      cache.assets.set(stored.id, stored)
      await this.refreshHome(cache)
      return structuredClone(stored)
    })
  }

  async updateAsset(address: string, id: string, input: UpdateAssetInput): Promise<StoredAsset> {
    return this.mutate(async () => {
      const cache = this.requireHome(parseHomeAddress(address))
      const current = cache.assets.get(id)
      if (current === undefined) throw new Error(`asset not found in ${address}: ${id}`)
      if (input.expectedRevision !== undefined
        && (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1
          || current.revision !== input.expectedRevision)) {
        throw new Error(`asset revision conflict in ${address}: ${id}; expected ${input.expectedRevision}, current ${current.revision}. Read the asset again before updating it.`)
      }
      if (input.appliedProposalId !== undefined && (!input.appliedProposalId.trim()
        || current.proposalId === input.appliedProposalId
        || current.proposalApplications?.some(item => item.proposalId === input.appliedProposalId))) {
        throw new Error(`asset proposal application already exists or is invalid: ${input.appliedProposalId}`)
      }
      const body = input.body === undefined ? current.body : normalizeBody(input.body)
      const updatedAt = nowIso()
      const metadata = AssetMetadataSchema.parse({
        ...stripStoredFields(current),
        ...(input.description !== undefined ? { description: input.description.trim() } : {}),
        ...(input.tags !== undefined ? { tags: normalizeTags(input.tags) } : {}),
        ...(input.sourceRefs !== undefined ? { sourceRefs: input.sourceRefs } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        ...(input.fitness !== undefined ? { fitness: input.fitness } : {}),
        ...(input.appliedProposalId === undefined ? {} : { proposalApplications: [
          ...(current.proposalApplications ?? []), { proposalId: input.appliedProposalId,
            revision: current.revision + 1,
            bodySha256: createHash('sha256').update(body).digest('hex') },
        ] }),
        revision: current.revision + 1,
        updatedAt,
      }) as AssetMetadata
      const stored: StoredAsset = { ...metadata, body, bodyPath: current.bodyPath }
      await atomicWrite(current.bodyPath, renderAsset(stored))
      cache.assets.set(id, stored)
      await this.refreshHome(cache)
      return structuredClone(stored)
    })
  }

  contextFor(address: string, budget: ContextBudget, episodeCount = 0): string {
    return this.renderContext(address, budget, episodeCount, false)
  }

  contextForFrame(address: string, budget: ContextBudget): string {
    return this.renderContext(address, budget, 0, true)
  }

  private renderContext(address: string, budget: ContextBudget, episodeCount: number, frame: boolean): string {
    const cache = this.requireHome(parseHomeAddress(address))
    const identity = truncateUtf8(cache.identity, budget.identityMaxBytes)
    const activeAssets = [...cache.assets.values()]
      .filter(asset => asset.status === 'active')
      .sort(compareAssets)
    const rows = activeAssets.map(asset => indexRow(asset))
    const { included, omitted } = takeWithinBudget(rows, budget.indexMaxBytes)
    const index = included.length === 0 ? '- (no active long-term assets)' : included.join('\n')
    return [
      frame ? '# BizAgent Read-only Agent Frame' : '# BizAgent Home Context',
      '',
      `Home: ${cache.home.address}`,
      `Type: ${cache.home.type}`,
      `Revision: ${cache.home.revision}`,
      `Digest: ${cache.home.contextDigest}`,
      ...(!frame ? [`Known DSH episodes: ${episodeCount}`] : []),
      '',
      '## Identity',
      '',
      identity,
      '',
      '## Long-term asset index',
      '',
      index,
      ...(omitted > 0 ? ['', `(${omitted} additional active assets omitted by the context budget.)`] : []),
      '',
      frame
        ? 'This is attributed read-only context from another Home. Use bizagent_frame_search and bizagent_frame_read for exact content. '
          + 'It does not change the current Session owner or tool authority. Send reusable learning to this Home through a proposal.'
        : 'Use bizagent_episodes to find earlier DSH Sessions; use bizagent_memory_search and bizagent_memory_read before relying on an indexed asset. '
          + 'Write reusable learning to this Home only. For another Home, create a proposal instead of writing it directly.',
    ].join('\n')
  }

  private relativePath(path: string): string {
    const rel = relative(this.root, path)
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path
  }

  /** Error text for issues, with absolute paths under the root shown relative to it. */
  private relativeMessage(error: unknown): string {
    return errorMessage(error).split(`${this.root}/`).join('')
  }

  async doctor(): Promise<DoctorReport> {
    const issues: string[] = []
    let assetCount = 0
    const seenIds = new Set<string>()
    for (const cache of this.homes.values()) {
      if (seenIds.has(cache.home.id)) issues.push(`duplicate home id: ${cache.home.id}`)
      seenIds.add(cache.home.id)
      assetCount += cache.assets.size
      const digest = contextDigest(cache.identity, [...cache.assets.values()])
      if (digest !== cache.home.contextDigest) {
        issues.push(`context digest mismatch: ${cache.home.address}`)
      }
      const rel = relative(this.root, cache.directory)
      if (rel.startsWith('..') || isAbsolute(rel)) issues.push(`home escapes root: ${cache.home.address}`)
      for (const asset of cache.assets.values()) {
        if (asset.ownerAddress !== cache.home.address) {
          issues.push(`asset ${asset.id} owner mismatch in ${cache.home.address}`)
        }
      }
    }
    issues.push(...this.integrityIssues)
    return { ok: issues.length === 0, root: this.root, homeCount: this.homes.size, assetCount, issues }
  }

  /**
   * Owners recorded in directory.yaml when this store last wrote it. The file sits at the store
   * root, outside each Home's own Workspace directory, so an Agent working in its Home cannot
   * change its owner by editing home.yaml alone.
   */
  private async readRecordedOwners(): Promise<Map<string, string | null>> {
    const owners = new Map<string, string | null>()
    let raw: string
    try {
      raw = (await readRegularFileNoFollow(join(this.root, 'directory.yaml'))).toString('utf8')
    } catch (error) {
      if (!isNotFound(error)) {
        this.integrityIssues.push('directory.yaml could not be read; Agent Home owners were not verified')
      }
      return owners
    }
    const document: unknown = YAML.parse(raw)
    // This store rewrites directory.yaml; never downgrade one written by a newer BizAgent.
    assertKnownFormat(document, 1, 'directory.yaml')
    const parsed = DIRECTORY_SCHEMA.safeParse(document)
    if (!parsed.success) {
      this.integrityIssues.push('directory.yaml is malformed; Agent Home owners were not verified')
      return owners
    }
    for (const entry of parsed.data.homes) {
      if (entry.owner !== undefined) owners.set(entry.address, entry.owner)
    }
    return owners
  }

  /** Refuse an owner change made in agent-writable home.yaml; keep the recorded owner and report it. */
  private keepRecordedOwner(cache: HomeCache, recordedOwners: ReadonlyMap<string, string | null>): void {
    if (!recordedOwners.has(cache.home.address)) return
    const recorded = recordedOwners.get(cache.home.address) ?? undefined
    if (cache.home.owner === recorded) return
    this.integrityIssues.push(`Agent Home ${cache.home.address}: home.yaml owner differs from the recorded owner; `
      + 'the change was refused and the recorded owner is kept')
    const { owner: _ignored, ...rest } = cache.home
    cache.home = AgentHomeSchema.parse(recorded === undefined ? rest : { ...rest, owner: recorded }) as AgentHome
  }

  private async loadHome(directory: string): Promise<HomeCache> {
    this.assertWithinRoot(directory)
    const homeRaw = YAML.parse(await readManagedText(join(directory, 'home.yaml')))
    assertKnownFormat(homeRaw, 1, 'home.yaml')
    let home = AgentHomeSchema.parse(homeRaw) as AgentHome
    // home.yaml lives in the Home's writable Workspace: its identity fields must match the address.
    if (home.id !== safeHomeId(home.address)) {
      throw new Error(`home.yaml id does not match its address ${home.address}`)
    }
    if (basename(directory) !== home.id) {
      throw new Error(`Home directory name does not match home.yaml id ${home.id}`)
    }
    if (home.type !== homeTypeOf(home.address)) {
      throw new Error(`home.yaml type ${home.type} does not match its address ${home.address}`)
    }
    const identity = normalizeBody(await readManagedText(join(directory, 'identity.md')))
    const assets = new Map<string, StoredAsset>()
    for (const [kind, child] of Object.entries(KIND_DIRECTORY) as [Exclude<AssetKind, 'identity'>, string][]) {
      const assetDirectory = join(directory, child)
      await mkdir(assetDirectory, { recursive: true })
      const entries = await readdir(assetDirectory, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue
        const bodyPath = join(assetDirectory, entry.name)
        try {
          const asset = parseAsset(await readManagedText(bodyPath), bodyPath)
          if (asset.kind !== kind) throw new Error(`${bodyPath}: kind ${asset.kind} does not match directory ${kind}`)
          if (asset.ownerAddress !== home.address) throw new Error(`${bodyPath}: owner does not match ${home.address}`)
          if (assets.has(asset.id)) throw new Error(`${bodyPath}: duplicate asset id ${asset.id}`)
          assets.set(asset.id, asset)
        } catch (error) {
          // One unreadable or invalid asset is left out instead of hiding the whole Home.
          this.integrityIssues.push(`asset skipped: ${this.relativeMessage(error)}`)
        }
      }
    }
    const digest = contextDigest(identity, [...assets.values()])
    if (digest !== home.contextDigest) {
      home = AgentHomeSchema.parse({
        ...home,
        revision: home.revision + 1,
        contextDigest: digest,
        updatedAt: nowIso(),
      }) as AgentHome
      await atomicWrite(join(directory, 'home.yaml'), YAML.stringify(home, { lineWidth: 0 }))
    }
    return { home, directory, identity, assets }
  }

  private async loadOrganization(): Promise<void> {
    this.organizationLoadError = undefined
    try {
      await this.loadOrganizationFile()
    } catch (error) {
      // The Homes stay usable; organization features wait until organization.yaml is fixed.
      this.organization = undefined
      this.organizationLoadError = this.relativeMessage(error)
      this.integrityIssues.push(`organization unavailable: ${this.organizationLoadError}`)
    }
  }

  private async loadOrganizationFile(): Promise<void> {
    let raw: unknown
    try {
      raw = YAML.parse(await readManagedText(this.organizationFile))
    } catch (error) {
      if (isNotFound(error)) return
      throw error
    }
    assertKnownFormat(raw, 1, 'organization.yaml')
    const organization = OrganizationSchema.parse(raw) as Organization
    const referenced = new Set<HomeAddress>([
      ...(organization.lineHome === undefined ? [] : [organization.lineHome]),
      organization.businessHome,
      ...organization.members.flatMap(member => [member.personalHome, member.roleHome]),
      ...organization.capabilityHomes,
      ...organization.links.flatMap(link => [link.from, link.to]),
    ])
    for (const address of referenced) {
      if (!this.homes.has(address)) throw new Error(`organization references missing Agent Home: ${address}`)
    }
    this.organization = organization
  }

  private async createHomeUnlocked(
    input: CreateHomeInput,
    writeDirectory: boolean,
    requireMatchingExisting: boolean,
  ): Promise<AgentHome> {
    const address = parseHomeAddress(input.address)
    const existing = this.homes.get(address)
    if (existing !== undefined) {
      if (requireMatchingExisting) {
        const expectedName = input.displayName?.trim() || address
        const expectedOwner = input.owner?.trim()
        const expectedIdentity = normalizeBody(input.identity ?? defaultIdentity(address))
        if (existing.home.displayName !== expectedName
          || existing.home.owner !== expectedOwner
          || existing.identity !== expectedIdentity) {
          throw new Error(`Agent Home already exists with a different definition: ${address}`)
        }
      }
      return structuredClone(existing.home)
    }

    const id = safeHomeId(address)
    const directory = join(this.homesRoot, id)
    this.assertWithinRoot(directory)
    if (await lstat(directory).then(() => true, () => false)) {
      // A folder that did not load (damaged, or written by a newer BizAgent) is never replaced.
      throw new Error(`a folder for Agent Home ${address} already exists but could not be loaded; `
        + 'run bizagent doctor for the reason')
    }
    const temporaryDirectory = `${directory}.${process.pid}.${randomUUID()}.tmp`
    this.assertWithinRoot(temporaryDirectory)
    await mkdir(temporaryDirectory, { recursive: false })

    let home: AgentHome
    let identity: string
    try {
      for (const child of Object.values(KIND_DIRECTORY)) await mkdir(join(temporaryDirectory, child))
      await mkdir(join(temporaryDirectory, 'worklogs'))
      await mkdir(join(temporaryDirectory, 'archive'))

      const createdAt = nowIso()
      identity = normalizeBody(input.identity ?? defaultIdentity(address))
      const digest = contextDigest(identity, [])
      home = AgentHomeSchema.parse({
        schemaVersion: 1,
        id,
        address,
        type: homeTypeOf(address),
        displayName: input.displayName?.trim() || address,
        ...(input.owner?.trim() ? { owner: input.owner.trim() } : {}),
        revision: 1,
        contextDigest: digest,
        status: 'active',
        createdAt,
        updatedAt: createdAt,
      }) as AgentHome

      await atomicWrite(join(temporaryDirectory, 'identity.md'), `${identity}\n`)
      await atomicWrite(join(temporaryDirectory, 'home.yaml'), YAML.stringify(home, { lineWidth: 0 }))
      await rename(temporaryDirectory, directory)
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true })
      throw error
    }
    this.homes.set(address, { home, directory, identity, assets: new Map() })
    if (writeDirectory) await this.writeDirectory()
    return structuredClone(home)
  }

  private async refreshHome(cache: HomeCache): Promise<void> {
    const digest = contextDigest(cache.identity, [...cache.assets.values()])
    if (digest === cache.home.contextDigest) return
    cache.home = AgentHomeSchema.parse({
      ...cache.home,
      revision: cache.home.revision + 1,
      contextDigest: digest,
      updatedAt: nowIso(),
    }) as AgentHome
    await atomicWrite(join(cache.directory, 'home.yaml'), YAML.stringify(cache.home, { lineWidth: 0 }))
    await this.writeDirectory()
  }

  private assetPath(cache: HomeCache, kind: Exclude<AssetKind, 'identity'>, id: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error(`unsafe asset id: ${id}`)
    const path = join(cache.directory, KIND_DIRECTORY[kind], `${id}.md`)
    this.assertWithinRoot(path)
    return path
  }

  private requireHome(address: HomeAddress): HomeCache {
    const cache = this.homes.get(address)
    if (cache === undefined) throw new Error(`Agent Home not found: ${address}`)
    if (cache.home.status !== 'active') throw new Error(`Agent Home is not active: ${address}`)
    return cache
  }

  private assertWithinRoot(path: string): void {
    const rel = relative(this.root, resolve(path))
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return
    throw new Error(`path escapes BizAgent root: ${path}`)
  }

  private async writeDirectory(): Promise<void> {
    const directory = DIRECTORY_SCHEMA.parse({
      schemaVersion: 1,
      homes: [...this.homes.values()]
        .map(cache => ({
          id: cache.home.id,
          address: cache.home.address,
          path: relative(this.root, cache.directory),
          owner: cache.home.owner ?? null,
        }))
        .sort((a, b) => a.address.localeCompare(b.address)),
    })
    await atomicWrite(join(this.root, 'directory.yaml'), YAML.stringify(directory, { lineWidth: 0 }))
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationTail.then(operation, operation)
    this.mutationTail = next.then(() => undefined, () => undefined)
    return next
  }
}

function defaultIdentity(address: HomeAddress): string {
  return `You are the long-term agent for ${address}. Learn from real work, keep evidence, and respect Home ownership.`
}

function normalizeBody(body: string): string {
  const normalized = body.replace(/\r\n/g, '\n').trim()
  if (normalized.length === 0) throw new Error('body must not be empty')
  return normalized
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map(tag => tag.trim()).filter(Boolean))].sort()
}

function normalizeId(value: string, label: string): string {
  const normalized = value.trim().toLocaleLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error(`${label} id must use 1-64 lowercase letters, numbers, dots, underscores, or hyphens`)
  }
  return normalized
}

function normalizeLabel(value: string, label: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`${label} must not be empty`)
  if (normalized.length > 200) throw new Error(`${label} must be at most 200 characters`)
  return normalized
}

/** Managed files are read without following a final symlink. */
async function readManagedText(path: string): Promise<string> {
  return (await readRegularFileNoFollow(path)).toString('utf8')
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function stripStoredFields(asset: StoredAsset): AssetMetadata {
  const { body: _body, bodyPath: _bodyPath, ...metadata } = asset
  return metadata
}

function renderAsset(asset: StoredAsset): string {
  const metadata = stripStoredFields(asset)
  return `---\n${YAML.stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n\n${asset.body}\n`
}

function parseAsset(raw: string, bodyPath: string): StoredAsset {
  // A git checkout with autocrlf turns frontmatter delimiters into CRLF; parse those the same way.
  const input = raw.replace(/\r\n/g, '\n')
  if (!input.startsWith('---\n')) throw new Error(`${bodyPath}: missing YAML frontmatter`)
  const end = input.indexOf('\n---\n', 4)
  if (end < 0) throw new Error(`${bodyPath}: unterminated YAML frontmatter`)
  const frontmatter: unknown = YAML.parse(input.slice(4, end))
  assertKnownFormat(frontmatter, 1, bodyPath)
  const metadata = AssetMetadataSchema.parse(frontmatter) as AssetMetadata
  const body = normalizeBody(input.slice(end + 5))
  return { ...metadata, body, bodyPath }
}

function contextDigest(identity: string, assets: StoredAsset[]): string {
  const activeIndex = assets
    .filter(asset => asset.status === 'active')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(asset => ({
      id: asset.id,
      kind: asset.kind,
      description: asset.description,
      tags: asset.tags,
      revision: asset.revision,
      bodyDigest: createHash('sha256').update(asset.body).digest('hex'),
    }))
  return createHash('sha256')
    .update(JSON.stringify({ identity, activeIndex }))
    .digest('hex')
}

function compareAssets(a: StoredAsset, b: StoredAsset): number {
  const status = statusRank(a.status) - statusRank(b.status)
  if (status !== 0) return status
  const kind = kindRank(a.kind) - kindRank(b.kind)
  if (kind !== 0) return kind
  if (a.fitness !== b.fitness) return b.fitness - a.fitness
  if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt)
  return a.id.localeCompare(b.id)
}

function statusRank(status: AssetStatus): number {
  return ({ active: 0, candidate: 1, superseded: 2, retired: 3 } as const)[status]
}

function kindRank(kind: AssetKind): number {
  return ({ identity: 0, knowledge: 1, method: 2, insight: 3, memory: 4 } as const)[kind]
}

function indexRow(asset: StoredAsset): string {
  const tags = asset.tags.length === 0 ? '' : ` tags=${asset.tags.map(escapeIndexText).join(',')}`
  return `- [${escapeIndexText(asset.id)}] ${asset.kind}: ${escapeIndexText(asset.description)}${tags}`
}

function escapeIndexText(value: string): string {
  return value.replace(/[<>\r\n]/g, character => ({ '<': '&lt;', '>': '&gt;', '\r': ' ', '\n': ' ' })[character] ?? ' ')
}

function takeWithinBudget(rows: string[], maxBytes: number): { included: string[]; omitted: number } {
  const included: string[] = []
  let used = 0
  for (const row of rows) {
    const bytes = Buffer.byteLength(row) + (included.length === 0 ? 0 : 1)
    if (used + bytes > maxBytes) continue
    included.push(row)
    used += bytes
  }
  return { included, omitted: rows.length - included.length }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value
  let result = ''
  let bytes = 0
  for (const character of value) {
    const next = Buffer.byteLength(character)
    if (bytes + next > Math.max(maxBytes - 32, 0)) break
    result += character
    bytes += next
  }
  return `${result}\n\n[Identity truncated by byte budget.]`
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await writeFileDurably(path, contents)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}
