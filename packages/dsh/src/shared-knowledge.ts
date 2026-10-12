import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import { EvidenceRefSchema, HomeAddressSchema } from './domain.js'

const LineId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/i)
const KnowledgeId = z.string().regex(/^knowledge-[a-f0-9]{20}$/)
const DocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: KnowledgeId,
  scope: z.enum(['line', 'common']),
  line: LineId.optional(),
  description: z.string().trim().min(1).max(1000),
  proposalId: z.string().min(1),
  reviewerId: z.string().trim().min(1),
  authorityRef: z.string().trim().min(1),
  publishedAt: z.string().datetime(),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
}).superRefine((value, context) => {
  if ((value.scope === 'line') !== (value.line !== undefined)) {
    context.addIssue({ code: 'custom', path: ['line'], message: 'line scope requires one line ID' })
  }
})

export type SharedKnowledgeTarget = { scope: 'line'; line: string } | { scope: 'common' }
export type SharedKnowledgeDocument = z.infer<typeof DocumentSchema> & { body: string; path: string }
export type PublishSharedKnowledgeInput = SharedKnowledgeTarget & {
  id: string
  description: string
  body: string
  proposalId: string
  reviewerId: string
  authorityRef: string
  publishedAt: string
}

export const SharedKnowledgeProposalSchema = z.strictObject({
  id: z.string().regex(/^proposal-[a-f0-9]{20}$/),
  fromAddress: HomeAddressSchema,
  target: z.discriminatedUnion('scope', [
    z.strictObject({ scope: z.literal('line'), line: LineId }),
    z.strictObject({ scope: z.literal('common') }),
  ]),
  description: z.string().trim().min(1).max(1000),
  body: z.string().trim().min(1).max(128 * 1024),
  sourceRefs: z.array(EvidenceRefSchema).min(1),
  status: z.enum(['pending', 'accepted', 'rejected']),
  humanReview: z.strictObject({
    reviewerId: z.string().trim().min(1),
    authorityRef: z.string().trim().min(1),
    action: z.enum(['accept', 'reject']),
    decision: z.string().trim().min(1),
    reviewedAt: z.string().datetime(),
  }).optional(),
  targetDocumentId: KnowledgeId.optional(),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().optional(),
}).superRefine((proposal, context) => {
  if (proposal.status === 'accepted' && (!proposal.targetDocumentId || proposal.humanReview?.action !== 'accept')) {
    context.addIssue({ code: 'custom', message: 'accepted shared Knowledge needs a reviewed document' })
  }
  if (proposal.status === 'rejected' && (proposal.targetDocumentId || proposal.humanReview?.action !== 'reject')) {
    context.addIssue({ code: 'custom', message: 'rejected shared Knowledge needs a human rejection' })
  }
  if (proposal.humanReview && proposal.status === 'pending' && proposal.humanReview.action !== 'accept') {
    context.addIssue({ code: 'custom', message: 'pending shared Knowledge can only reserve acceptance' })
  }
  if (proposal.status !== 'pending' && proposal.decidedAt !== proposal.humanReview?.reviewedAt) {
    context.addIssue({ code: 'custom', message: 'shared Knowledge decision time must match human review' })
  }
})
export type SharedKnowledgeProposal = z.infer<typeof SharedKnowledgeProposalSchema>

/** File-backed shared sources. PMO Agent Home knowledge stays in its separate Home directory. */
export class SharedKnowledgeStore {
  readonly root: string

  constructor(root: string) { this.root = resolve(root) }

  pathFor(target: SharedKnowledgeTarget): string {
    return target.scope === 'common'
      ? join(this.root, 'knowledge', 'common')
      : join(this.root, 'lines', LineId.parse(target.line), 'knowledge')
  }

  async publish(input: PublishSharedKnowledgeInput): Promise<SharedKnowledgeDocument> {
    const id = KnowledgeId.parse(input.id)
    const body = input.body.trim()
    if (!body || Buffer.byteLength(body) > 128 * 1024) {
      throw new Error('shared Knowledge body must contain 1 to 131072 bytes')
    }
    const metadata = DocumentSchema.parse({
      schemaVersion: 1, id, scope: input.scope,
      ...(input.scope === 'line' ? { line: input.line } : {}),
      description: input.description, proposalId: input.proposalId,
      reviewerId: input.reviewerId, authorityRef: input.authorityRef,
      publishedAt: input.publishedAt,
      bodySha256: createHash('sha256').update(body).digest('hex'),
    })
    const directory = await this.ensureDirectory(input)
    const path = join(directory, `${id}.md`)
    const existing = await this.read(input, id)
    if (existing !== undefined) {
      if (existing.proposalId !== metadata.proposalId || existing.bodySha256 !== metadata.bodySha256
        || existing.description !== metadata.description || existing.reviewerId !== metadata.reviewerId
        || existing.authorityRef !== metadata.authorityRef) {
        throw new Error(`shared Knowledge document conflicts with existing publication: ${id}`)
      }
      return existing
    }
    const content = `---\n${YAML.stringify(metadata, { lineWidth: 0 })}---\n${body}\n`
    const temporary = join(directory, `.${id}.${process.pid}.${randomUUID()}.tmp`)
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
    try {
      await link(temporary, path)
    } catch (error) {
      if (!isExists(error)) throw error
      const raced = await this.read(input, id)
      if (raced?.proposalId !== metadata.proposalId || raced.bodySha256 !== metadata.bodySha256) {
        throw new Error(`shared Knowledge document conflicts with existing publication: ${id}`)
      }
      return raced
    } finally {
      await rm(temporary, { force: true })
    }
    return { ...metadata, body, path }
  }

  async read(target: SharedKnowledgeTarget, idInput: string): Promise<SharedKnowledgeDocument | undefined> {
    const id = KnowledgeId.parse(idInput)
    if (!await this.safeExistingDirectory(target)) return undefined
    const path = join(this.pathFor(target), `${id}.md`)
    let info
    try { info = await lstat(path) }
    catch (error) { if (isMissing(error)) return undefined; throw error }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 160 * 1024) {
      throw new Error(`unsafe shared Knowledge document: ${path}`)
    }
    const content = await readFile(path, 'utf8')
    const end = content.indexOf('\n---\n', 4)
    if (!content.startsWith('---\n') || end < 0) throw new Error(`malformed shared Knowledge document: ${path}`)
    const metadata = DocumentSchema.parse(YAML.parse(content.slice(4, end)))
    const body = content.slice(end + 5).trim()
    if (metadata.id !== id || metadata.scope !== target.scope
      || (target.scope === 'line' && metadata.line !== LineId.parse(target.line))
      || createHash('sha256').update(body).digest('hex') !== metadata.bodySha256) {
      throw new Error(`shared Knowledge document integrity mismatch: ${path}`)
    }
    return { ...metadata, body, path }
  }

  async search(targets: readonly SharedKnowledgeTarget[], query = ''): Promise<SharedKnowledgeDocument[]> {
    const terms = query.trim().toLowerCase()
    const results: SharedKnowledgeDocument[] = []
    for (const target of targets) {
      if (!await this.safeExistingDirectory(target)) continue
      const directory = this.pathFor(target)
      let entries
      try { entries = await readdir(directory, { withFileTypes: true }) }
      catch (error) { if (isMissing(error)) continue; throw error }
      for (const entry of entries) {
        if (!entry.isFile() || !/^knowledge-[a-f0-9]{20}\.md$/.test(entry.name)) continue
        const document = await this.read(target, entry.name.slice(0, -3))
        if (document && (!terms || `${document.description}\n${document.body}`.toLowerCase().includes(terms))) {
          results.push(document)
        }
      }
    }
    return results.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id))
  }

  private async ensureDirectory(target: SharedKnowledgeTarget): Promise<string> {
    if (!isAbsolute(this.root) || await realpath(this.root) !== this.root) {
      throw new Error('shared Knowledge root must be a real absolute directory')
    }
    const segments = target.scope === 'common'
      ? ['knowledge', 'common'] : ['lines', LineId.parse(target.line), 'knowledge']
    let current = this.root
    for (const segment of segments) {
      current = join(current, segment)
      try { await mkdir(current) }
      catch (error) { if (!isExists(error)) throw error }
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`shared Knowledge path must be a real directory: ${current}`)
      }
      const canonical = await realpath(current)
      const rel = relative(this.root, canonical)
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('shared Knowledge path escapes its root')
    }
    return current
  }

  private async safeExistingDirectory(target: SharedKnowledgeTarget): Promise<boolean> {
    if (await realpath(this.root) !== this.root) {
      throw new Error('shared Knowledge root must be a real directory')
    }
    const segments = target.scope === 'common'
      ? ['knowledge', 'common'] : ['lines', LineId.parse(target.line), 'knowledge']
    let current = this.root
    for (const segment of segments) {
      current = join(current, segment)
      let info
      try { info = await lstat(current) }
      catch (error) { if (isMissing(error)) return false; throw error }
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`shared Knowledge path must be a real directory: ${current}`)
      }
    }
    return true
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
function isExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}
