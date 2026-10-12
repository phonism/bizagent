import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { FormalProject } from './project-ledger.js'
import type { BizAgentService } from './service.js'
import { BIZAGENT_PROJECT_INTERVENTION_API } from './ui-contract.js'

const MAX_BODY_BYTES = 8 * 1024
const Id = z.string().trim().min(1).max(200)
const Revision = z.number().int().positive()
const Action = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('pause'), projectId: Id, expectedRevision: Revision,
    reason: z.string().trim().min(1).max(4000) }),
  z.strictObject({ action: z.literal('resume'), projectId: Id, expectedRevision: Revision }),
])

export interface ProjectInterventionPrincipal { userId: string }
export interface ProjectInterventionRouteOptions {
  authenticateUser: (request: IncomingMessage) => ProjectInterventionPrincipal | null
    | Promise<ProjectInterventionPrincipal | null>
  authorizeMutation: (request: IncomingMessage, principal: ProjectInterventionPrincipal) =>
    boolean | Promise<boolean>
  /** Check this human's current grant over the Project and its lead Home. */
  authorizeIntervention: (principal: ProjectInterventionPrincipal, project: Readonly<FormalProject>) =>
    boolean | Promise<boolean>
  /** Interrupt every known Project Session and release cancelled Work runner handles; retries must be safe. */
  afterPause: (principal: ProjectInterventionPrincipal, projectId: string,
    cancelledWorkIds: string[]) => Promise<{ interrupted: string[]; failed: string[] }>
  /** Return unknown unless all known Project Sessions can be checked. */
  inspectRuntime: (principal: ProjectInterventionPrincipal, projectId: string) => Promise<{
    status: 'quiet' | 'busy' | 'unknown'; sessionIds: string[]
  }>
}

export function createProjectInterventionHttpHandler(service: BizAgentService,
  options: ProjectInterventionRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      reply(res, 405, failure('method-not-allowed', 'Use GET or POST for Project intervention.'))
      return
    }
    try {
      const principal = await options.authenticateUser(req)
      if (!principal?.userId.trim()) {
        reply(res, 401, failure('authentication-required', 'Sign in to manage this Project.'))
        return
      }
      const authorize = (_actor: string, project: FormalProject) =>
        options.authorizeIntervention(principal, project)
      if (req.method === 'GET') {
        const query = new URL(req.url ?? '', 'http://bizagent.local').searchParams
        const projectId = Id.parse(query.get('projectId'))
        const project = service.projectLedger?.get(projectId)
        if (!project || !await options.authorizeIntervention(principal, project)) {
          reply(res, 403, failure('intervention-forbidden', 'This Project cannot be managed here.'))
          return
        }
        reply(res, 200, { revision: project.revision,
          canPause: ['open', 'blocked'].includes(project.status) && !project.intervention?.paused,
          canResume: ['open', 'blocked'].includes(project.status) && Boolean(project.intervention?.paused) })
        return
      }
      if (!await options.authorizeMutation(req, principal)) {
        reply(res, 403, failure('mutation-forbidden', 'This request cannot change the Project.'))
        return
      }
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        reply(res, 415, failure('content-type', 'Send JSON to change the Project.'))
        return
      }
      const input = Action.parse(await readJson(req))
      if (input.action === 'pause') {
        const afterPause = () => {
          const pauseCancelledWorkIds = (service.workLedger?.list() ?? [])
            .filter(item => item.projectId === input.projectId && item.status === 'cancelled'
              && (item.cancelledByProjectSessionId !== undefined
                || item.cancelledByProjectPrincipal !== undefined))
            .map(item => item.id)
          return options.afterPause(principal, input.projectId, pauseCancelledWorkIds)
        }
        let result: Record<string, unknown>
        try {
          result = await service.pauseProjectAsHuman(principal.userId, {
            projectId: input.projectId, expectedProjectRevision: input.expectedRevision,
            reason: input.reason,
          }, authorize)
        } catch (error) {
          const current = service.projectLedger?.get(input.projectId)
          if (current?.intervention?.paused
            && await options.authorizeIntervention(principal, current)) {
            try { await afterPause() } catch { /* Keep the durable pause for retry. */ }
            throw new PauseIncompleteError()
          }
          throw error
        }
        let interruption: { interrupted: string[]; failed: string[] }
        try {
          interruption = await afterPause()
          if (interruption.failed.length > 0) throw new PauseIncompleteError()
        } catch {
          throw new PauseIncompleteError()
        }
        reply(res, 200, { ...result, interruption })
      } else {
        const result = await service.resumeProjectAsHuman(principal.userId, {
          projectId: input.projectId, expectedProjectRevision: input.expectedRevision,
        }, authorize, () => options.inspectRuntime(principal, input.projectId))
        reply(res, 200, result)
      }
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof RequestError) {
        reply(res, 400, failure('invalid-request', 'Check the Project intervention fields.'))
      } else if (error instanceof PauseIncompleteError) {
        reply(res, 503, failure('pause-incomplete',
          'Project is paused, but cleanup is incomplete. Retry pause to finish cleanup.'))
      } else if (error instanceof Error && error.message.includes('not authorized')) {
        reply(res, 403, failure('intervention-forbidden', 'This Project cannot be managed here.'))
      } else if (error instanceof Error && error.message.includes('revision changed')) {
        reply(res, 409, failure('revision-conflict', 'Project changed. Refresh before continuing.'))
      } else {
        reply(res, 409, failure('intervention-rejected',
          'Project could not change state. Refresh and check its current state.'))
      }
    }
  }
}

export function registerProjectInterventionRoute(webServer: {
  register: (route: { kind: 'exact'; path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => () => void
}, service: BizAgentService, options: ProjectInterventionRouteOptions): () => void {
  return webServer.register({ kind: 'exact', path: BIZAGENT_PROJECT_INTERVENTION_API,
    handler: createProjectInterventionHttpHandler(service, options) })
}

class RequestError extends Error {}
class PauseIncompleteError extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let total = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > MAX_BODY_BYTES) throw new RequestError('request body too large')
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RequestError('invalid JSON') }
}

function failure(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } }
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.end(JSON.stringify(body))
}
