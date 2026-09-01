import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { z } from 'zod'
import {
  ASSET_KINDS,
  HOME_TYPES,
  type HomeAddress,
  type MemoryProposal,
  nowIso,
  parseHomeAddress,
} from './domain.js'
import type { BizAgentService } from './service.js'
import {
  BIZAGENT_UI_API,
  type UiAsset,
  type UiAssetCounts,
  type UiCreateHomeRequest,
  type UiHomeDetail,
  type UiHomeSummary,
  type UiOverview,
  type UiProposalDecisionRequest,
} from './ui-contract.js'

export const name = 'bizagent-ui-host'
export const inject = ['bizagent', 'webServer']

const MAX_BODY_BYTES = 64 * 1024
const MUTABLE_KINDS = ASSET_KINDS.filter(kind => kind !== 'identity')

const CreateHomeSchema = z.object({
  address: z.string().min(3).max(200),
  displayName: z.string().trim().min(1).max(200).optional(),
  owner: z.string().trim().min(1).max(200).optional(),
  identity: z.string().trim().min(1).max(64 * 1024).optional(),
})

const ProposalDecisionSchema = z.object({
  ownerAddress: z.string().min(3).max(200),
  proposalId: z.string().min(1).max(200),
  action: z.enum(['accept', 'reject']),
  decision: z.string().trim().min(1).max(4000),
  kind: z.enum(MUTABLE_KINDS).optional(),
})

export class BizAgentUiFacade {
  constructor(readonly service: BizAgentService) {}

  async overview(): Promise<UiOverview> {
    const proposals = this.service.ledger.listProposals()
    const homes = this.service.store.listHomes().map(home => this.homeSummary(home.address, proposals))
    const health = await this.service.store.doctor()
    return {
      generatedAt: nowIso(),
      homeRoot: this.service.store.root,
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
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt,
        receiptCount: assetReceipts.length,
        ...(lastSignal !== undefined ? { lastSignal } : {}),
      }
    })
    return {
      home,
      identity: this.service.store.getIdentity(address),
      assets,
      proposals: this.service.ledger.listProposals()
        .filter(proposal => proposal.fromAddress === address || proposal.toAddress === address),
      episodes: this.service.ledger.listBindings(address).length,
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

  async decideProposal(request: UiProposalDecisionRequest): Promise<UiHomeDetail> {
    const input = ProposalDecisionSchema.parse(request)
    const ownerAddress = parseHomeAddress(input.ownerAddress)
    if (input.action === 'accept') {
      await this.service.acceptProposalAsOwner(ownerAddress, {
        proposalId: input.proposalId,
        decision: input.decision,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
      })
    } else {
      await this.service.rejectProposalAsOwner(ownerAddress, input.proposalId, input.decision)
    }
    return this.home(ownerAddress)
  }

  private homeSummary(address: HomeAddress, proposals: MemoryProposal[]): UiHomeSummary {
    const home = this.service.store.getHome(address)
    const assets = this.service.store.listAssets(address)
    const counts: UiAssetCounts = { memory: 0, insight: 0, knowledge: 0, method: 0 }
    for (const asset of assets) {
      if (asset.kind !== 'identity') counts[asset.kind] += 1
    }
    return {
      address,
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

export function apply(ctx: Context): void {
  const facade = new BizAgentUiFacade(ctx.bizagent)
  const routes = [
    ctx.webServer.register({
      kind: 'exact',
      path: `${BIZAGENT_UI_API}/overview`,
      handler: (req, res) => route(req, res, 'GET', () => facade.overview()),
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
    ctx.webServer.register({
      kind: 'exact',
      path: `${BIZAGENT_UI_API}/proposals/decision`,
      handler: (req, res) => route(req, res, 'POST', async () => {
        const input = ProposalDecisionSchema.parse(await readJson(req))
        return facade.decideProposal({
          ownerAddress: input.ownerAddress,
          proposalId: input.proposalId,
          action: input.action,
          decision: input.decision,
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
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
