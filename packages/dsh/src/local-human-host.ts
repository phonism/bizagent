import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { registerHumanInboxRoute } from './human-inbox-transport.js'
import { registerProjectReviewRoute } from './project-review-transport.js'
import { registerProposalReviewRoute } from './proposal-review-transport.js'
import { registerSharedKnowledgeReviewRoute } from './shared-knowledge-review-transport.js'
import { BIZAGENT_AGENT_SESSION_API, BIZAGENT_LOCAL_HUMAN_STATUS_API } from './ui-contract.js'

export const name = 'bizagent-local-human-host'
export const inject = ['bizagent', 'bizagentAgentSessions', 'webServer']

const USER_ID = /^[a-zA-Z0-9._-]{1,100}$/

/** Local single-user adapter. The token stays outside DSH config and never enters Agent context. */
export async function apply(ctx: Context): Promise<void> {
  const tokenFile = process.env.BIZAGENT_LOCAL_HUMAN_TOKEN_FILE
  const userId = process.env.BIZAGENT_LOCAL_HUMAN_ID
  if (!tokenFile && !userId) return
  if (!tokenFile || !userId || !USER_ID.test(userId)) {
    throw new Error('Local human review needs BIZAGENT_LOCAL_HUMAN_ID and BIZAGENT_LOCAL_HUMAN_TOKEN_FILE')
  }
  if (ctx.webServer.host !== '127.0.0.1') {
    throw new Error('Local human Bearer review requires DSH Web to bind 127.0.0.1')
  }
  const info = await stat(tokenFile)
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw new Error('Local human token file must be a private regular file (mode 0600)')
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('Local human token file must belong to the current user')
  }
  const token = (await readFile(tokenFile, 'utf8')).trim()
  if (token.length < 32 || token.length > 512 || /\s/u.test(token)) {
    throw new Error('Local human token must contain 32-512 non-whitespace characters')
  }
  const expected = createHash('sha256').update(token).digest()
  const authenticate = (request: IncomingMessage): { userId: string } | null => {
    const header = request.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
    const candidate = header.slice('Bearer '.length)
    if (candidate.length < 32 || candidate.length > 512 || /\s/u.test(candidate)) return null
    const actual = createHash('sha256').update(candidate).digest()
    return timingSafeEqual(actual, expected) ? { userId } : null
  }
  const ownsHome = (address: string): boolean => {
    try { return ctx.bizagent.store.getHome(address).owner === userId }
    catch { return false }
  }
  const authorizeMutation = (_request: IncomingMessage, principal: { userId: string }) =>
    principal.userId === userId
  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: BIZAGENT_LOCAL_HUMAN_STATUS_API,
      handler: async (request, response) => {
        response.setHeader('Cache-Control', 'no-store')
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        response.setHeader('X-Content-Type-Options', 'nosniff')
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' }); response.end(JSON.stringify({ error: 'method-not-allowed' })); return
        }
        const principal = authenticate(request)
        response.statusCode = principal ? 200 : 401
        response.end(JSON.stringify(principal ? { userId: principal.userId } : { error: 'authentication-required' }))
      } }),
    ctx.webServer.register({ kind: 'exact', path: BIZAGENT_AGENT_SESSION_API,
      handler: async (request, response) => {
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
      } }),
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
