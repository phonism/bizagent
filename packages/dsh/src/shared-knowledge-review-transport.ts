import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { BizAgentService } from './service.js'
import type { SharedKnowledgeProposal } from './shared-knowledge.js'

export const SHARED_KNOWLEDGE_REVIEW_API = '/api/bizagent/shared-knowledge/decision'

const Decision = z.strictObject({
  proposalId: z.string().min(1).max(200),
  action: z.enum(['accept', 'reject']),
  decision: z.string().trim().min(1).max(4000),
})

export interface SharedKnowledgeReviewOptions {
  authenticateHuman(request: IncomingMessage): { userId: string } | null
    | Promise<{ userId: string } | null>
  authorizeMutation(request: IncomingMessage, principal: { userId: string }): boolean | Promise<boolean>
  /** The host must check line.admin or platform.admin for this exact proposal. */
  authorizeProposal(request: IncomingMessage, principal: { userId: string },
    proposal: SharedKnowledgeProposal, action: 'accept' | 'reject'): string | null | Promise<string | null>
}

export function createSharedKnowledgeReviewHttpHandler(service: BizAgentService,
  options: SharedKnowledgeReviewOptions) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    const reply = (code: number, value: unknown) => {
      response.statusCode = code; response.end(JSON.stringify(value))
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      response.setHeader('Allow', 'GET, POST')
      reply(405, { error: 'method-not-allowed' }); return
    }
    try {
      const principal = await options.authenticateHuman(request)
      if (!principal?.userId.trim()) { reply(401, { error: 'authentication-required' }); return }
      if (request.method === 'GET') {
        const proposals = service.ledger.listSharedKnowledgeProposals()
        const visible: Array<{ proposal: SharedKnowledgeProposal; actions: { accept: boolean; reject: boolean } }> = []
        for (const proposal of proposals) {
          const accept = !!(await options.authorizeProposal(request, principal, proposal, 'accept'))?.trim()
          const reject = !!(await options.authorizeProposal(request, principal, proposal, 'reject'))?.trim()
          if (accept || reject) visible.push({ proposal, actions: { accept, reject } })
        }
        reply(200, { count: visible.length, proposals: visible }); return
      }
      if (!await options.authorizeMutation(request, principal)) {
        reply(403, { error: 'mutation-forbidden' }); return
      }
      if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        reply(415, { error: 'content-type' }); return
      }
      const parts: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += part.length
        if (bytes > 16 * 1024) { reply(413, { error: 'body-too-large' }); return }
        parts.push(part)
      }
      const input = Decision.parse(JSON.parse(Buffer.concat(parts).toString('utf8')))
      const proposal = service.ledger.getSharedKnowledgeProposal(input.proposalId)
      if (!proposal) { reply(404, { error: 'proposal-not-found' }); return }
      const authorityRef = await options.authorizeProposal(request, principal, proposal, input.action)
      if (!authorityRef?.trim()) { reply(403, { error: 'proposal-forbidden' }); return }
      reply(200, await service.decideSharedKnowledgeAsHuman({ ...input,
        reviewerId: principal.userId, authorityRef }))
    } catch (error) {
      reply(error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 409,
        { error: error instanceof z.ZodError || error instanceof SyntaxError
          ? 'invalid-request' : 'shared-knowledge-conflict' })
    }
  }
}

export function registerSharedKnowledgeReviewRoute(webServer: { register: (route: { kind: 'exact';
  path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) => () => void },
service: BizAgentService, options: SharedKnowledgeReviewOptions): () => void {
  return webServer.register({ kind: 'exact', path: SHARED_KNOWLEDGE_REVIEW_API,
    handler: createSharedKnowledgeReviewHttpHandler(service, options) })
}
