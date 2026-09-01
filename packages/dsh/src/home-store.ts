import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import {
  AgentHomeSchema,
  AssetMetadataSchema,
  type AgentHome,
  type AssetKind,
  type AssetMetadata,
  type AssetStatus,
  type ContextBudget,
  type EvidenceRef,
  type HomeAddress,
  type StoredAsset,
  homeTypeOf,
  nowIso,
  parseHomeAddress,
  safeHomeId,
} from './domain.js'

const DIRECTORY_SCHEMA = z.object({
  schemaVersion: z.literal(1),
  homes: z.array(z.object({
    id: z.string().min(1),
    address: z.string().min(1),
    path: z.string().min(1),
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
  description?: string
  body?: string
  tags?: string[]
  sourceRefs?: EvidenceRef[]
  status?: AssetStatus
  confidence?: number
  fitness?: number
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
  private readonly homes = new Map<HomeAddress, HomeCache>()
  private mutationTail: Promise<unknown> = Promise.resolve()

  constructor(root: string) {
    this.root = resolve(root)
    this.homesRoot = join(this.root, 'homes')
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
    this.homes.clear()
    const entries = await readdir(this.homesRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const directory = join(this.homesRoot, entry.name)
      let cache: HomeCache
      try {
        cache = await this.loadHome(directory)
      } catch (error) {
        throw new Error(`cannot load Agent Home at ${directory}: ${errorMessage(error)}`, { cause: error })
      }
      if (this.homes.has(cache.home.address)) {
        throw new Error(`duplicate Agent Home address: ${cache.home.address}`)
      }
      this.homes.set(cache.home.address, cache)
    }
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

  getIdentity(address: string): string {
    return this.requireHome(parseHomeAddress(address)).identity
  }

  async createHome(input: CreateHomeInput): Promise<AgentHome> {
    return this.mutate(async () => {
      const address = parseHomeAddress(input.address)
      const existing = this.homes.get(address)
      if (existing !== undefined) return structuredClone(existing.home)

      const id = safeHomeId(address)
      const directory = join(this.homesRoot, id)
      this.assertWithinRoot(directory)
      await mkdir(directory, { recursive: false })
      for (const child of Object.values(KIND_DIRECTORY)) {
        await mkdir(join(directory, child))
      }
      await mkdir(join(directory, 'worklogs'))
      await mkdir(join(directory, 'archive'))

      const createdAt = nowIso()
      const identity = normalizeBody(input.identity ?? defaultIdentity(address))
      const digest = contextDigest(identity, [])
      const home = AgentHomeSchema.parse({
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

      await atomicWrite(join(directory, 'identity.md'), `${identity}\n`)
      await atomicWrite(join(directory, 'home.yaml'), YAML.stringify(home, { lineWidth: 0 }))
      this.homes.set(address, { home, directory, identity, assets: new Map() })
      await this.writeDirectory()
      return structuredClone(home)
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
    const found = [...cache.assets.values()].find(asset => asset.proposalId === proposalId)
    return found === undefined ? undefined : structuredClone(found)
  }

  async createAsset(input: CreateAssetInput): Promise<StoredAsset> {
    return this.mutate(async () => {
      const cache = this.requireHome(input.ownerAddress)
      const existing = cache.assets.get(input.id)
      if (existing !== undefined) {
        if (existing.proposalId === input.proposalId
          || (existing.description === input.description && existing.body === normalizeBody(input.body))) {
          return structuredClone(existing)
        }
        throw new Error(`asset id collision in ${input.ownerAddress}: ${input.id}`)
      }

      const now = nowIso()
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
        createdAt: now,
        updatedAt: now,
      }) as AssetMetadata
      const body = normalizeBody(input.body)
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
      const updatedAt = nowIso()
      const metadata = AssetMetadataSchema.parse({
        ...stripStoredFields(current),
        ...(input.description !== undefined ? { description: input.description.trim() } : {}),
        ...(input.tags !== undefined ? { tags: normalizeTags(input.tags) } : {}),
        ...(input.sourceRefs !== undefined ? { sourceRefs: input.sourceRefs } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        ...(input.fitness !== undefined ? { fitness: input.fitness } : {}),
        revision: current.revision + 1,
        updatedAt,
      }) as AssetMetadata
      const body = input.body === undefined ? current.body : normalizeBody(input.body)
      const stored: StoredAsset = { ...metadata, body, bodyPath: current.bodyPath }
      await atomicWrite(current.bodyPath, renderAsset(stored))
      cache.assets.set(id, stored)
      await this.refreshHome(cache)
      return structuredClone(stored)
    })
  }

  contextFor(address: string, budget: ContextBudget, episodeCount = 0): string {
    const cache = this.requireHome(parseHomeAddress(address))
    const identity = truncateUtf8(cache.identity, budget.identityMaxBytes)
    const activeAssets = [...cache.assets.values()]
      .filter(asset => asset.status === 'active')
      .sort(compareAssets)
    const rows = activeAssets.map(asset => indexRow(asset))
    const { included, omitted } = takeWithinBudget(rows, budget.indexMaxBytes)
    const index = included.length === 0 ? '- (no active long-term assets)' : included.join('\n')
    return [
      '# BizAgent Home Context',
      '',
      `Home: ${cache.home.address}`,
      `Type: ${cache.home.type}`,
      `Revision: ${cache.home.revision}`,
      `Digest: ${cache.home.contextDigest}`,
      `Known DSH episodes: ${episodeCount}`,
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
      'Use bizagent_memory_search and bizagent_memory_read before relying on an indexed asset. '
        + 'Write reusable learning to this Home only. For another Home, create a proposal instead of writing it directly.',
    ].join('\n')
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
    return { ok: issues.length === 0, root: this.root, homeCount: this.homes.size, assetCount, issues }
  }

  private async loadHome(directory: string): Promise<HomeCache> {
    this.assertWithinRoot(directory)
    const homeRaw = YAML.parse(await readFile(join(directory, 'home.yaml'), 'utf8'))
    let home = AgentHomeSchema.parse(homeRaw) as AgentHome
    const identity = normalizeBody(await readFile(join(directory, 'identity.md'), 'utf8'))
    const assets = new Map<string, StoredAsset>()
    for (const [kind, child] of Object.entries(KIND_DIRECTORY) as [Exclude<AssetKind, 'identity'>, string][]) {
      const assetDirectory = join(directory, child)
      await mkdir(assetDirectory, { recursive: true })
      const entries = await readdir(assetDirectory, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue
        const bodyPath = join(assetDirectory, entry.name)
        const asset = parseAsset(await readFile(bodyPath, 'utf8'), bodyPath)
        if (asset.kind !== kind) throw new Error(`${bodyPath}: kind ${asset.kind} does not match directory ${kind}`)
        if (asset.ownerAddress !== home.address) throw new Error(`${bodyPath}: owner does not match ${home.address}`)
        if (assets.has(asset.id)) throw new Error(`${bodyPath}: duplicate asset id ${asset.id}`)
        assets.set(asset.id, asset)
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

function stripStoredFields(asset: StoredAsset): AssetMetadata {
  const { body: _body, bodyPath: _bodyPath, ...metadata } = asset
  return metadata
}

function renderAsset(asset: StoredAsset): string {
  const metadata = stripStoredFields(asset)
  return `---\n${YAML.stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n\n${asset.body}\n`
}

function parseAsset(input: string, bodyPath: string): StoredAsset {
  if (!input.startsWith('---\n')) throw new Error(`${bodyPath}: missing YAML frontmatter`)
  const end = input.indexOf('\n---\n', 4)
  if (end < 0) throw new Error(`${bodyPath}: unterminated YAML frontmatter`)
  const metadata = AssetMetadataSchema.parse(YAML.parse(input.slice(4, end))) as AssetMetadata
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
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
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
