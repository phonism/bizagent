import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { registerHumanInboxRoute } from './human-inbox-transport.js'
import { isLocalUserId } from './local-owner.js'
import { LocalHumanCredential, readLocalHumanToken } from './local-human-token.js'
import { workspaceRegistry } from './organization-workspace.js'
import { registerProjectReviewRoute } from './project-review-transport.js'
import { registerProposalReviewRoute } from './proposal-review-transport.js'
import { dshOperatorAuthentication, guardLocalRoute } from './route-guard.js'
import { registerSharedKnowledgeReviewRoute } from './shared-knowledge-review-transport.js'
import { BIZAGENT_AGENT_SESSION_API, BIZAGENT_LOCAL_HUMAN_STATUS_API } from './ui-contract.js'

export const name = 'bizagent-local-human-host'
export const inject = ['bizagent', 'bizagentAgentSessions', 'webServer']

/**
 * Local single-user adapter: one person reviews Projects and proposals and answers their Inbox.
 * In DSH Web that person is whoever is signed in to DSH in the browser (DSH's own login), and
 * they act as the BizAgent owner (or $BIZAGENT_LOCAL_HUMAN_ID). Scripts can instead present a
 * Bearer token from $BIZAGENT_LOCAL_HUMAN_TOKEN_FILE. BIZAGENT_LOCAL_HUMAN=off turns this off.
 */
export async function apply(ctx: Context): Promise<void> {
  if (process.env.BIZAGENT_LOCAL_HUMAN === 'off') return
  const tokenFile = process.env.BIZAGENT_LOCAL_HUMAN_TOKEN_FILE?.trim()
  const userId = process.env.BIZAGENT_LOCAL_HUMAN_ID?.trim() || ctx.bizagent.config.owner
  if (!isLocalUserId(userId)) {
    throw new Error('BIZAGENT_LOCAL_HUMAN_ID must use 1-100 letters, numbers, dots, underscores, or hyphens')
  }
  if (ctx.webServer.host !== '127.0.0.1') {
    // A configured token is a promise to protect review routes, so a public bind is an error.
    if (tokenFile) throw new Error('Local human review requires DSH Web to bind 127.0.0.1')
    return
  }
  const credential = tokenFile ? new LocalHumanCredential(await readLocalHumanToken(tokenFile)) : undefined
  const authenticate = (request: IncomingMessage): { userId: string } | null => {
    const header = request.headers.authorization
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return credential?.matchesToken(header.slice('Bearer '.length)) ? { userId } : null
    }
    const operator = dshOperatorAuthentication(ctx)
    return operator !== undefined && operator.requestRejection(request) === undefined ? { userId } : null
  }
  // DSH Web lists only Sessions attached to a Workspace. Sessions this plugin opens are created on
  // the host, so attach them to a Workspace named after their Home, as DSH does for its own.
  const showInSidebar = async (homeAddress: string, sessionId: string): Promise<string> => {
    const path = ctx.bizagent.store.homeWorkspacePath(homeAddress)
    const registry = workspaceRegistry(ctx)
    if (registry !== undefined) {
      const workspace = await registry.create(path, ctx.bizagent.store.getHome(homeAddress).displayName)
      await workspace.attachSession(sessionId)
    }
    return path
  }
  const ownsHome = (address: string): boolean => {
    try { return ctx.bizagent.store.getHome(address).owner === userId }
    catch { return false }
  }
  const authorizeMutation = (_request: IncomingMessage, principal: { userId: string }) =>
    principal.userId === userId
  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: BIZAGENT_LOCAL_HUMAN_STATUS_API,
      handler: guardLocalRoute(async (request, response) => {
        response.setHeader('Cache-Control', 'no-store')
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        response.setHeader('X-Content-Type-Options', 'nosniff')
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' }); response.end(JSON.stringify({ error: 'method-not-allowed' })); return
        }
        const principal = authenticate(request)
        response.statusCode = principal ? 200 : 401
        response.end(JSON.stringify(principal ? { userId: principal.userId } : { error: 'authentication-required' }))
      }) }),
    ctx.webServer.register({ kind: 'exact', path: BIZAGENT_AGENT_SESSION_API,
      handler: guardLocalRoute(async (request, response) => {
        response.setHeader('Cache-Control', 'no-store')
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        response.setHeader('X-Content-Type-Options', 'nosniff')
        const reply = (status: number, body: unknown) => {
          response.statusCode = status; response.end(JSON.stringify(body))
        }
        if (request.method !== 'POST') { reply(405, { error: 'method-not-allowed' }); return }
        if (!authenticate(request)) { reply(401, { error: 'authentication-required' }); return }
        if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          reply(415, { error: 'content-type' }); return
        }
        try {
          const parts: Buffer[] = []
          let total = 0
          for await (const chunk of request) {
            const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            total += part.byteLength
            if (total > 4096) { reply(413, { error: 'body-too-large' }); return }
            parts.push(part)
          }
          const body: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'))
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            reply(400, { error: 'invalid-request' }); return
          }
          const input = body as Record<string, unknown>
          const principal = typeof input.homeAddress === 'string' && input.projectId === undefined
            && Object.keys(input).length === 1
          const main = typeof input.projectId === 'string' && input.homeAddress === undefined
            && Object.keys(input).length === 1
          const existing = typeof input.sessionId === 'string' && input.sessionId.length > 0
            && Object.keys(input).length === 1
          if (!principal && !main && !existing) { reply(400, { error: 'invalid-request' }); return }
          if (existing) {
            const binding = ctx.bizagent.ledger.getBinding(input.sessionId as string)
            if (!binding || !ownsHome(binding.homeAddress)) { reply(403, { error: 'session-forbidden' }); return }
            // Reveal a host-created worker without resuming its Agent or changing an ordinary
            // conversation's existing Workspace. Runtime ownership remains with its runner.
            const homePath = ctx.bizagent.store.homeWorkspacePath(binding.homeAddress)
            const workspacePath = binding.cwd === homePath
              ? await showInSidebar(binding.homeAddress, input.sessionId as string) : undefined
            reply(200, { sessionId: input.sessionId, ...(workspacePath ? { workspacePath } : {}) })
          } else if (principal) {
            if (!ownsHome(input.homeAddress as string)) { reply(403, { error: 'home-forbidden' }); return }
            const result = await ctx.bizagentAgentSessions.openPrincipal(input.homeAddress as string)
            reply(200, { ...result, workspacePath: await showInSidebar(result.homeAddress, result.sessionId) })
          } else {
            const project = ctx.bizagent.projectLedger?.get(input.projectId as string)
            if (!project || !ownsHome(project.lead)) { reply(403, { error: 'project-forbidden' }); return }
            const result = await ctx.bizagentAgentSessions.openProjectMain(input.projectId as string)
            reply(200, { ...result, workspacePath: await showInSidebar(result.homeAddress, result.sessionId) })
          }
        } catch { reply(409, { error: 'agent-session-unavailable' }) }
      }) }),
    registerProjectReviewRoute(ctx.webServer, ctx.bizagent, {
      authenticateUser: authenticate,
      authorizeMutation,
      authorizeReview: (principal, project) => principal.userId === userId && ownsHome(project.lead),
    }),
    registerProposalReviewRoute(ctx.webServer, ctx.bizagent, {
      authenticateHuman: authenticate,
      authorizeMutation,
      authorizeProposal: (_request, principal, proposal, action) =>
        principal.userId === userId && ownsHome(proposal.toAddress)
          ? `local-human:${userId}:${proposal.id}:${action}` : null,
    }),
    registerSharedKnowledgeReviewRoute(ctx.webServer, ctx.bizagent, {
      authenticateHuman: authenticate,
      authorizeMutation,
      authorizeProposal: (_request, principal, proposal, action) => {
        if (principal.userId !== userId) return null
        const authorized = proposal.target.scope === 'line'
          ? ownsHome(`line:${proposal.target.line}`)
          : process.env.BIZAGENT_LOCAL_PLATFORM_ADMIN === '1'
        return authorized ? `local-human:${userId}:${proposal.target.scope}:${proposal.id}:${action}` : null
      },
    }),
    registerHumanInboxRoute(ctx.webServer, ctx.bizagent, {
      authenticateUser: authenticate,
      authorizeMutation,
    }),
  ]
  ctx.effect(() => () => { for (const dispose of disposers.reverse()) dispose() })
}
