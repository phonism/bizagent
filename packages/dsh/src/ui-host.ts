import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import {
  HOME_TYPES,
  type HomeAddress,
  type MemoryProposal,
  nowIso,
  parseHomeAddress,
} from './domain.js'
import type { BizAgentService } from './service.js'
import {
  BIZAGENT_UI_API,
  BIZAGENT_AGENT_DIRECTORY_API,
  BIZAGENT_FRAME_STATUS_API,
  type UiAsset,
  type UiAssetCounts,
  type UiCreateHomeRequest,
  type UiCreateOrganizationRequest,
  type UiFrameParticipation,
  type UiHomeDetail,
  type UiHomeSummary,
  type UiOverview,
} from './ui-contract.js'

export const name = 'bizagent-ui-host'
export const inject = ['bizagent', 'agents', 'sessionQuery', 'bizagentLearningScheduler', 'webServer']

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

const MAX_BODY_BYTES = 64 * 1024

const CreateHomeSchema = z.object({
  address: z.string().min(3).max(200),
  displayName: z.string().trim().min(1).max(200).optional(),
  owner: z.string().trim().min(1).max(200).optional(),
  identity: z.string().trim().min(1).max(64 * 1024).optional(),
})

const SafeIdSchema = z.string().trim().min(1).max(64).regex(
  /^[a-z0-9][a-z0-9._-]*$/,
  'Use lowercase letters, numbers, dots, underscores, or hyphens.',
)

const CreateOrganizationSchema = z.object({
  workspacePath: z.string().trim().min(1).max(4096),
  id: SafeIdSchema,
  name: z.string().trim().min(1).max(200),
  mission: z.string().trim().min(1).max(2000),
  members: z.array(z.object({
    id: SafeIdSchema,
    displayName: z.string().trim().min(1).max(200),
    roleId: SafeIdSchema,
    roleName: z.string().trim().min(1).max(200),
    responsibility: z.string().trim().min(1).max(1000),
  })).min(1).max(24),
  capabilities: z.array(z.object({
    id: SafeIdSchema,
    displayName: z.string().trim().min(1).max(200),
    responsibility: z.string().trim().min(1).max(1000),
  })).max(24),
})

const LearningScheduleActionSchema = z.object({
  home: z.string().min(3).max(200),
  expectedRevision: z.number().int().nonnegative(),
  enabled: z.boolean(),
  cron: z.string().trim().min(1).max(100),
  dailyRuns: z.number().int().min(1).max(4),
})
const MemoryUseOutcomesQuerySchema = z.object({
  assetId: z.string().min(1).max(200),
  beforeWorkId: z.string().min(1).max(200).optional(),
})
const AgentDirectoryQuerySchema = z.object({
  sessionId: z.string().min(1).max(200),
  query: z.string().max(160).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  target: z.string().min(1).max(200).optional(),
})

export class BizAgentUiFacade {
  constructor(readonly service: BizAgentService) {}

  async frameParticipation(sessionId: string, cwd: string | undefined,
    events: readonly SessionEvent[]): Promise<UiFrameParticipation> {
    const status = await this.service.frameStatusForSession(sessionId, cwd, events)
    const names = new Map(this.service.store.listHomes().map(home => [home.address, home.displayName]))
    const stale = new Set(status.staleFrames)
    return {
      sessionId,
      primaryHome: { address: status.state.primaryHome,
        displayName: names.get(status.state.primaryHome) ?? status.state.primaryHome },
      frames: status.state.frames.map(frame => ({
        address: frame.address,
        displayName: names.get(frame.address) ?? frame.address,
        mode: frame.mode,
        focused: status.state.focusAddress === frame.address,
        refreshRequired: stale.has(frame.address),
      })),
    }
  }

  async overview(): Promise<UiOverview> {
    const proposals = this.service.ledger.listProposals()
    const homes = this.service.store.listHomes().map(home => this.homeSummary(home.address, proposals))
    const health = await this.service.store.doctor()
    const organization = this.service.store.getOrganization()
    const organizationLocation = this.service.getActiveOrganizationLocation()
    return {
      generatedAt: nowIso(),
      homeRoot: this.service.store.root,
      ...(organizationLocation === undefined ? {} : {
        organizationLocation: {
          workspacePath: organizationLocation.workspacePath,
          organizationId: organizationLocation.organizationId,
          organizationRoot: organizationLocation.organizationRoot,
        },
      }),
      ...(organization === undefined ? {} : { organization }),
      homes,
      proposals,
      totals: {
        homes: homes.length,
        assets: homes.reduce((sum, home) => sum + home.assetCount, 0),
        activeAssets: homes.reduce((sum, home) => sum + home.activeAssetCount, 0),
        pendingProposals: proposals.filter(proposal => proposal.status === 'pending').length,
        episodes: homes.reduce((sum, home) => sum + home.episodes, 0),
      },
      health: { ok: health.ok, issues: health.issues },
    }
  }

  home(addressInput: string): UiHomeDetail {
    const address = parseHomeAddress(addressInput)
    const home = this.service.store.getHome(address)
    const receipts = this.service.ledger.listReceipts()
    const assets = this.service.store.listAssets(address).map((asset): UiAsset => {
      if (asset.kind === 'identity') throw new Error(`Identity must not be stored as a learning asset: ${asset.id}`)
      const assetReceipts = receipts.filter(receipt => receipt.assetId === asset.id)
      const lastSignal = assetReceipts.at(-1)?.signal
      return {
        id: asset.id,
        ownerAddress: asset.ownerAddress,
        kind: asset.kind,
        ...(asset.title !== undefined ? { title: asset.title } : {}),
        description: asset.description,
        body: asset.body,
        tags: asset.tags,
        sourceRefs: asset.sourceRefs,
        confidence: asset.confidence,
        fitness: asset.fitness,
        status: asset.status,
        revision: asset.revision,
        ...(asset.proposalId !== undefined ? { proposalId: asset.proposalId } : {}),
        ...(asset.proposalApplications === undefined ? {} : {
          proposalApplications: asset.proposalApplications }),
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt,
        receiptCount: assetReceipts.length,
        ...(lastSignal !== undefined ? { lastSignal } : {}),
      }
    })
    const worklogs = this.service.worklogLedger?.listLatest(address) ?? []
    return {
      home,
      identity: this.service.store.getIdentity(address),
      assets,
      proposals: this.service.ledger.listProposals()
        .filter(proposal => proposal.fromAddress === address || proposal.toAddress === address),
      episodes: this.service.ledger.listBindings(address).length,
      worklogCount: worklogs.length,
      worklogs: worklogs.slice(0, 20).map(item => ({
        id: item.id, sessionId: item.sessionId, revision: item.revision,
        description: item.description, body: item.body, status: item.status,
        ...(item.origin === undefined ? {} : { origin: item.origin }),
        recordedAt: item.recordedAt, files: item.files.map(file => file.path),
        ...(item.workId !== undefined ? { workId: item.workId } : {}),
        ...(item.projectId !== undefined ? { projectId: item.projectId } : {}),
      })),
    }
  }

  async createHome(request: UiCreateHomeRequest): Promise<UiHomeDetail> {
    const input = CreateHomeSchema.parse(request)
    const home = await this.service.store.createHome({
      address: input.address,
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      ...(input.identity !== undefined ? { identity: input.identity } : {}),
    })
    return this.home(home.address)
  }

  async createOrganization(request: UiCreateOrganizationRequest): Promise<UiOverview> {
    const input = CreateOrganizationSchema.parse(request)
    await this.service.createOrganizationInWorkspace(input)
    return this.overview()
  }

  private homeSummary(address: HomeAddress, proposals: MemoryProposal[]): UiHomeSummary {
    const home = this.service.store.getHome(address)
    const chatWorkspacePath = home.type === 'business' ? this.service.chatWorkspacePath(address) : undefined
    const assets = this.service.store.listAssets(address)
    const counts: UiAssetCounts = { memory: 0, insight: 0, knowledge: 0, method: 0 }
    for (const asset of assets) {
      if (asset.kind !== 'identity') counts[asset.kind] += 1
    }
    return {
      address,
      ...(chatWorkspacePath ? { chatWorkspacePath } : {}),
      type: home.type,
      displayName: home.displayName,
      revision: home.revision,
      status: home.status,
      updatedAt: home.updatedAt,
      assetCount: assets.length,
      activeAssetCount: assets.filter(asset => asset.status === 'active').length,
      counts,
      incomingPending: proposals.filter(proposal => proposal.toAddress === address && proposal.status === 'pending').length,
      outgoingPending: proposals.filter(proposal => proposal.fromAddress === address && proposal.status === 'pending').length,
      episodes: this.service.ledger.listBindings(address).length,
    }
  }
}

export function apply(ctx: Context, _config: Config = {}): void {
  const facade = new BizAgentUiFacade(ctx.bizagent)
  const directorySession = async (req: IncomingMessage) => {
    const url = new URL(req.url ?? '', 'http://bizagent.local')
    const input = AgentDirectoryQuerySchema.parse({
      sessionId: url.searchParams.get('sessionId'),
      ...(url.searchParams.has('query') ? { query: url.searchParams.get('query') } : {}),
      ...(url.searchParams.has('limit') ? { limit: url.searchParams.get('limit') } : {}),
      ...(url.searchParams.has('target') ? { target: url.searchParams.get('target') } : {}),
    })
    const live = ctx.agents?.get(input.sessionId as SessionId)
    if (live !== undefined) {
      if (String(live.id) !== input.sessionId) {
        throw new UiRequestError('session-unavailable', 'Session is unavailable for Agent directory lookup.')
      }
      return { input, cwd: live.session.header.cwd, events: live.session.events }
    }
    let snapshot: Awaited<ReturnType<typeof ctx.sessionQuery.readSession>>
    try { snapshot = await ctx.sessionQuery.readSession(input.sessionId as SessionId) }
    catch { throw new UiRequestError('session-unavailable', 'Session is unavailable for Agent directory lookup.') }
    if (String(snapshot.session.id) !== input.sessionId) {
      throw new UiRequestError('session-unavailable', 'Session is unavailable for Agent directory lookup.')
    }
    return { input, cwd: snapshot.session.cwd, events: snapshot.events }
  }
  const routes = [
    ctx.webServer.register({
      kind: 'exact', path: BIZAGENT_AGENT_DIRECTORY_API,
      handler: (req, res) => route(req, res, 'GET', async () => {
        const { input, cwd } = await directorySession(req)
        return ctx.bizagent.searchHomesForSession(input.sessionId, cwd, {
          ...(input.query !== undefined ? { query: input.query } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
      }),
    }),
    ctx.webServer.register({
      kind: 'exact', path: `${BIZAGENT_AGENT_DIRECTORY_API}/resolve`,
      handler: (req, res) => route(req, res, 'GET', async () => {
        const { input, cwd } = await directorySession(req)
        if (input.target === undefined) throw new UiRequestError('missing-target', 'Agent target is required.')
        return ctx.bizagent.resolveHomeForSession(input.sessionId, cwd, input.target)
      }),
    }),
    ctx.webServer.register({
      kind: 'exact', path: BIZAGENT_FRAME_STATUS_API,
      handler: (req, res) => route(req, res, 'GET', async () => {
        const { input, cwd, events } = await directorySession(req)
        return facade.frameParticipation(input.sessionId, cwd, events)
      }),
    }),
    ctx.webServer.register({
      kind: 'exact', path: `${BIZAGENT_UI_API}/projects`,
      handler: (req, res) => route(req, res, 'GET', async () => {
        const { input, cwd } = await directorySession(req)
        const beforeProjectId = new URL(req.url ?? '', 'http://bizagent.local')
          .searchParams.get('beforeProjectId')
        return ctx.bizagent.listProjectsForSession(input.sessionId, cwd, {
          limit: 50,
          ...(beforeProjectId === null ? {} : { beforeProjectId: z.string().min(1).max(200).parse(beforeProjectId) }),
        })
      }),
    }),
    ctx.webServer.register({
      kind: 'exact', path: `${BIZAGENT_UI_API}/projects/detail`,
      handler: (req, res) => route(req, res, 'GET', async () => {
        const { input, cwd } = await directorySession(req)
        const projectId = z.string().min(1).max(200).parse(new URL(req.url ?? '', 'http://bizagent.local')
          .searchParams.get('projectId'))
        return ctx.bizagent.readProjectForSession(input.sessionId, cwd, projectId)
      }),
    }),
    ctx.webServer.register({
      kind: 'exact', path: `${BIZAGENT_UI_API}/learning/use-outcomes`,
      handler: (req, res) => route(req, res, 'GET', async () => {
        const { input, cwd } = await directorySession(req)
        const url = new URL(req.url ?? '', 'http://bizagent.local')
        const query = MemoryUseOutcomesQuerySchema.parse({
          assetId: url.searchParams.get('assetId'),
          ...(url.searchParams.has('beforeWorkId') ? { beforeWorkId: url.searchParams.get('beforeWorkId') } : {}),
        })
        return ctx.bizagent.memoryUseOutcomesForSession(input.sessionId, cwd, {
          assetId: query.assetId,
          ...(query.beforeWorkId === undefined ? {} : { beforeWorkId: query.beforeWorkId }),
        })
      }),
    }),
    ctx.webServer.register({
      kind: 'exact', path: `${BIZAGENT_UI_API}/learning/schedule`,
      handler: (req, res) => route(req, res, 'GET', () => {
        const home = new URL(req.url ?? '', 'http://bizagent.local').searchParams.get('home')
        if (!home) throw new UiRequestError('missing-home', 'An Agent Home address is required.')
        return ctx.bizagentLearningScheduler.status(home)
      }),
    }),
    ctx.webServer.register({
      kind: 'exact', path: `${BIZAGENT_UI_API}/learning/schedule/configure`,
      handler: (req, res) => route(req, res, 'POST', async () => {
        const input = LearningScheduleActionSchema.parse(await readJson(req))
        return ctx.bizagentLearningScheduler.configure(input.home, input)
      }),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${BIZAGENT_UI_API}/overview`,
      handler: (req, res) => route(req, res, 'GET', () => facade.overview()),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${BIZAGENT_UI_API}/organization`,
      handler: (req, res) => route(req, res, 'POST', async () => {
        const input = CreateOrganizationSchema.parse(await readJson(req))
        return facade.createOrganization(input)
      }),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${BIZAGENT_UI_API}/home`,
      handler: (req, res) => route(req, res, 'GET', () => {
        const address = new URL(req.url ?? '', 'http://bizagent.local').searchParams.get('address')
        if (!address) throw new UiRequestError('missing-address', 'The address query parameter is required.')
        return facade.home(address)
      }),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${BIZAGENT_UI_API}/homes`,
      handler: (req, res) => route(req, res, 'POST', async () => {
        const input = CreateHomeSchema.parse(await readJson(req))
        return facade.createHome({
          address: input.address,
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.owner !== undefined ? { owner: input.owner } : {}),
          ...(input.identity !== undefined ? { identity: input.identity } : {}),
        })
      }),
    }),
  ]
  ctx.effect(() => () => { for (const dispose of routes.reverse()) dispose() })
}

class UiRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  method: 'GET' | 'POST',
  execute: () => unknown | Promise<unknown>,
): Promise<void> {
  setCommonHeaders(res)
  if (req.method !== method) {
    res.setHeader('Allow', method)
    writeJson(res, 405, { error: { code: 'method-not-allowed', message: `Use ${method} for this endpoint.` } })
    return
  }
  if (method === 'POST' && !sameOrigin(req)) {
    writeJson(res, 403, { error: { code: 'origin-rejected', message: 'Mutation requests must come from this DSH origin.' } })
    return
  }
  try {
    writeJson(res, 200, await execute())
  } catch (error) {
    const known = error instanceof UiRequestError
    const validation = error instanceof z.ZodError
    writeJson(res, known || validation ? 400 : 409, {
      error: {
        code: known ? error.code : validation ? 'invalid-request' : 'operation-rejected',
        message: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new UiRequestError('content-type', 'Expected Content-Type: application/json.')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new UiRequestError('body-too-large', 'Request body exceeds 64 KiB.')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new UiRequestError('invalid-json', 'Request body is not valid JSON.')
  }
}

function setCommonHeaders(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('X-Content-Type-Options', 'nosniff')
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.end(JSON.stringify(value))
}

export const UI_HOME_TYPES = HOME_TYPES
