import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { registerHumanInboxRoute } from './human-inbox-transport.js'
import { isLocalUserId } from './local-owner.js'
import { LocalHumanCredential, clearLocalHumanCookieHeader, defaultLocalHumanTokenFile,
  ensureLocalHumanToken, readLocalHumanToken } from './local-human-token.js'
import { registerProjectReviewRoute } from './project-review-transport.js'
import { registerProposalReviewRoute } from './proposal-review-transport.js'
import { guardLocalRoute } from './route-guard.js'
import { registerSharedKnowledgeReviewRoute } from './shared-knowledge-review-transport.js'
import { BIZAGENT_AGENT_SESSION_API, BIZAGENT_LOCAL_HUMAN_STATUS_API } from './ui-contract.js'

export const name = 'bizagent-local-human-host'
export const inject = ['bizagent', 'bizagentAgentSessions', 'webServer']

const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

/**
 * Local single-user adapter: one person, identified by a private token file, reviews Projects and
 * proposals and answers their Inbox from the browser. The token stays outside DSH config and Agent
 * context. Without configuration it uses the BizAgent owner and creates
 * `<homeRoot>/local-human.token`; BIZAGENT_LOCAL_HUMAN=off turns it off.
 */
export async function apply(ctx: Context): Promise<void> {
  if (process.env.BIZAGENT_LOCAL_HUMAN === 'off') return
  const configuredFile = process.env.BIZAGENT_LOCAL_HUMAN_TOKEN_FILE?.trim()
  const userId = process.env.BIZAGENT_LOCAL_HUMAN_ID?.trim() || ctx.bizagent.config.owner
  if (!isLocalUserId(userId)) {
    throw new Error('BIZAGENT_LOCAL_HUMAN_ID must use 1-100 letters, numbers, dots, underscores, or hyphens')
  }
  if (ctx.webServer.host !== '127.0.0.1') {
    // An explicit setup is a promise to protect review routes, so a public bind is an error.
    // The automatic setup simply stays off.
    if (configuredFile) throw new Error('Local human review requires DSH Web to bind 127.0.0.1')
    return
  }
  const tokenFile = configuredFile || defaultLocalHumanTokenFile(ctx.bizagent.config.homeRoot)
  if (!configuredFile) await ensureLocalHumanToken(tokenFile)
  const credential = new LocalHumanCredential(await readLocalHumanToken(tokenFile))
  const bearer = (request: IncomingMessage): string | undefined => {
    const header = request.headers.authorization
    return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
  }
  const authenticate = (request: IncomingMessage): { userId: string } | null => {
    const token = bearer(request)
    if (token !== undefined) return credential.matchesToken(token) ? { userId } : null
    const cookie = request.headers.cookie
    return credential.matchesCookie(typeof cookie === 'string' ? cookie : undefined) ? { userId } : null
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
        const reply = (status: number, body: unknown) => {
          response.statusCode = status; response.end(JSON.stringify(body))
        }
        const method = request.method ?? 'GET'
        if (method === 'GET') {
          const principal = authenticate(request)
          // The token file path is not secret; it tells the person where to find the token.
          reply(principal ? 200 : 401, principal ? { userId: principal.userId }
            : { error: 'authentication-required', tokenFile })
          return
        }
        if (method === 'POST') {
          // Sign this browser in: a valid Bearer token sets an HttpOnly cookie.
          const token = bearer(request)
          if (token === undefined || !credential.matchesToken(token)) {
            reply(401, { error: 'authentication-required', tokenFile }); return
          }
          response.setHeader('Set-Cookie', credential.setCookieHeader(COOKIE_MAX_AGE_SECONDS))
          reply(200, { userId }); return
        }
        if (method === 'DELETE') {
          response.setHeader('Set-Cookie', clearLocalHumanCookieHeader())
          reply(200, { signedOut: true }); return
        }
        response.setHeader('Allow', 'GET, POST, DELETE')
        reply(405, { error: 'method-not-allowed' })
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
          if (!principal && !main) { reply(400, { error: 'invalid-request' }); return }
          if (principal) {
            if (!ownsHome(input.homeAddress as string)) { reply(403, { error: 'home-forbidden' }); return }
            const result = await ctx.bizagentAgentSessions.openPrincipal(input.homeAddress as string)
            reply(200, { ...result,
              workspacePath: ctx.bizagent.store.homeWorkspacePath(result.homeAddress) })
          } else {
            const project = ctx.bizagent.projectLedger?.get(input.projectId as string)
            if (!project || !ownsHome(project.lead)) { reply(403, { error: 'project-forbidden' }); return }
            const result = await ctx.bizagentAgentSessions.openProjectMain(input.projectId as string)
            reply(200, { ...result,
              workspacePath: ctx.bizagent.store.homeWorkspacePath(result.homeAddress) })
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
