import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { parseHomeAddress, type MemoryProposal } from './domain.js'
import type { BizAgentService } from './service.js'
import { BizAgentUiFacade } from './ui-host.js'
import { BIZAGENT_UI_API } from './ui-contract.js'

export const BIZAGENT_PROPOSAL_REVIEW_API = `${BIZAGENT_UI_API}/proposals/decision`

const Decision = z.strictObject({
  ownerAddress: z.string().min(3).max(200),
  proposalId: z.string().min(1).max(200),
  action: z.enum(['accept', 'reject']),
  decision: z.string().trim().min(1).max(4000),
})

export interface ProposalReviewPrincipal { userId: string }
export interface ProposalReviewRouteOptions {
  /** Resolve identity from a host-verified human session, never from the request body. */
  authenticateHuman(request: IncomingMessage): ProposalReviewPrincipal | null
    | Promise<ProposalReviewPrincipal | null>
  /** Enforce host CSRF protection or a non-cookie credential. */
  authorizeMutation(request: IncomingMessage, principal: ProposalReviewPrincipal): boolean | Promise<boolean>
  /** Check this proposal, action, and target Home; return a durable authority reference on success. */
  authorizeProposal(request: IncomingMessage, principal: ProposalReviewPrincipal,
    proposal: MemoryProposal, action: 'accept' | 'reject'): string | null | Promise<string | null>
}

/** Register explicitly in an authenticated host; the local alpha UI does not install this route. */
export function createProposalReviewHttpHandler(service: BizAgentService, options: ProposalReviewRouteOptions) {
  const facade = new BizAgentUiFacade(service)
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST'); respond(res, 405, 'method-not-allowed'); return
    }
    try {
      const principal = await options.authenticateHuman(req)
      if (!principal?.userId.trim()) { respond(res, 401, 'authentication-required'); return }
      if (req.method === 'GET') {
        const query = new URL(req.url ?? '', 'http://bizagent.local').searchParams
        const ownerAddress = parseHomeAddress(query.get('ownerAddress') ?? '')
        const proposalId = query.get('proposalId') ?? ''
        const proposal = service.ledger.getProposal(proposalId)
        if (!proposal || proposal.toAddress !== ownerAddress) {
          respond(res, 404, 'proposal-not-found'); return
        }
        const accept = !!(await options.authorizeProposal(req, principal, proposal, 'accept'))?.trim()
        const reject = !!(await options.authorizeProposal(req, principal, proposal, 'reject'))?.trim()
        res.statusCode = 200
        res.end(JSON.stringify({ actions: { accept, reject } }))
        return
      }
      if (!await options.authorizeMutation(req, principal)) { respond(res, 403, 'mutation-forbidden'); return }
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        respond(res, 415, 'content-type'); return
      }
      const input = Decision.parse(await readJson(req))
      const ownerAddress = parseHomeAddress(input.ownerAddress)
      const proposal = service.ledger.getProposal(input.proposalId)
      if (!proposal || proposal.toAddress !== ownerAddress) { respond(res, 404, 'proposal-not-found'); return }
      const authorityRef = await options.authorizeProposal(req, principal, proposal, input.action)
      if (!authorityRef?.trim()) { respond(res, 403, 'proposal-forbidden'); return }
      await service.decideProposalAsHuman({ ...input, ownerAddress,
        reviewerId: principal.userId, authorityRef })
      res.statusCode = 200
      res.end(JSON.stringify(await facade.home(ownerAddress)))
    } catch (error) {
      respond(res, error instanceof z.ZodError || error instanceof RequestError ? 400 : 409,
        error instanceof z.ZodError || error instanceof RequestError ? 'invalid-request' : 'proposal-conflict')
    }
  }
}

export function registerProposalReviewRoute(webServer: { register: (route: { kind: 'exact'; path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => () => void },
service: BizAgentService, options: ProposalReviewRouteOptions): () => void {
  return webServer.register({ kind: 'exact', path: BIZAGENT_PROPOSAL_REVIEW_API,
    handler: createProposalReviewHttpHandler(service, options) })
}

class RequestError extends Error {}
async function readJson(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += part.length
    if (bytes > 16 * 1024) throw new RequestError('proposal decision exceeds 16 KiB')
    parts.push(part)
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown }
  catch { throw new RequestError('invalid JSON') }
}
function respond(res: ServerResponse, status: number, error: string): void {
  res.statusCode = status
  res.end(JSON.stringify({ error }))
}
