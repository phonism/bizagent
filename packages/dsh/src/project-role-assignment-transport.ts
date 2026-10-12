import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { projectRoleAssignmentState, type FormalProject } from './project-ledger.js'
import type { BizAgentService } from './service.js'
import { BIZAGENT_PROJECT_ROLE_ASSIGNMENTS_API } from './ui-contract.js'

const Id = z.string().trim().min(1).max(200)
const Decision = z.strictObject({
  projectId: Id,
  roleHome: z.string().trim().min(1).max(200),
  action: z.enum(['assign', 'clear', 'reject']),
  targetPrincipal: Id.optional(),
  suggestionId: Id.optional(),
  expectedProjectRevision: z.number().int().positive(),
  expectedBindingRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(1).max(2000),
})

export interface ProjectRoleAssignmentPrincipal { userId: string }
export interface ProjectRoleAssignmentRouteOptions {
  authenticateUser: (request: IncomingMessage) => ProjectRoleAssignmentPrincipal | null
    | Promise<ProjectRoleAssignmentPrincipal | null>
  authorizeMutation: (request: IncomingMessage, principal: ProjectRoleAssignmentPrincipal) =>
    boolean | Promise<boolean>
  authorizeRead: (principal: ProjectRoleAssignmentPrincipal, project: Readonly<FormalProject>) =>
    boolean | Promise<boolean>
  authorizeManage: (principal: ProjectRoleAssignmentPrincipal, project: Readonly<FormalProject>) =>
    boolean | Promise<boolean>
  listCandidates: (principal: ProjectRoleAssignmentPrincipal, project: Readonly<FormalProject>,
    roleHome: string) => Promise<Array<{ id: string; label: string }>>
    | Array<{ id: string; label: string }>
  authorizeTarget: (targetPrincipal: string, project: Readonly<FormalProject>,
    roleHome: string) => boolean | Promise<boolean>
}

export function createProjectRoleAssignmentHttpHandler(service: BizAgentService,
  options: ProjectRoleAssignmentRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      reply(res, 405, 'method-not-allowed', 'Use GET or POST for Project role assignments.')
      return
    }
    try {
      const principal = await options.authenticateUser(req)
      if (!principal?.userId.trim()) {
        reply(res, 401, 'authentication-required', 'Sign in to view Project role assignments.')
        return
      }
      if (req.method === 'GET') {
        const query = new URL(req.url ?? '', 'http://bizagent.local').searchParams
        const projectId = Id.parse(query.get('projectId'))
        const project = service.projectLedger?.get(projectId)
        if (project === undefined || !await options.authorizeRead(principal, project)) {
          reply(res, 403, 'roles-forbidden', 'This Project is not available here.')
          return
        }
        const canManage = project.status === 'open' && await options.authorizeManage(principal, project)
        const roles = (project.seats ?? []).filter(seat => seat.status === 'active'
          && seat.homeAddress.startsWith('role:')).map(seat => ({
          roleHome: seat.homeAddress, responsibility: seat.responsibility,
        }))
        const roleHome = query.get('roleHome')
        let candidates: Array<{ id: string; label: string }> | undefined
        if (roleHome !== null) {
          if (!canManage || !roles.some(role => role.roleHome === roleHome)) {
            reply(res, 403, 'roles-forbidden', 'Candidates are not available for this Role Seat.')
            return
          }
          candidates = z.array(z.strictObject({ id: Id, label: z.string().trim().min(1).max(200) }))
            .max(200).parse(await options.listCandidates(principal, project, roleHome))
          if (new Set(candidates.map(item => item.id)).size !== candidates.length) {
            reply(res, 409, 'candidate-conflict', 'Candidate IDs must be unique.')
            return
          }
        }
        res.end(JSON.stringify({ projectId: project.id, projectRevision: project.revision,
          canManage, roles, ...projectRoleAssignmentState(project),
          ...(candidates === undefined ? {} : { candidates }) }))
        return
      }
      if (!await options.authorizeMutation(req, principal)) {
        reply(res, 403, 'mutation-forbidden', 'This request cannot change Project roles.')
        return
      }
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        reply(res, 415, 'content-type', 'Send JSON to change Project roles.')
        return
      }
      const parsed = Decision.parse(await readJson(req))
      const { targetPrincipal, suggestionId, ...base } = parsed
      const result = await service.decideProjectRoleAsHuman(principal.userId, {
        ...base,
        ...(targetPrincipal === undefined ? {} : { targetPrincipal }),
        ...(suggestionId === undefined ? {} : { suggestionId }),
      }, (_actor, current) => options.authorizeManage(principal, current),
      (target, current, role) => options.authorizeTarget(target, current, role))
      res.end(JSON.stringify(result))
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof RequestError) {
        reply(res, 400, 'invalid-request', 'Check the Project role assignment fields.')
      } else if (error instanceof Error && error.message.includes('not authorized')) {
        reply(res, 403, 'roles-forbidden', 'This Project role decision is not authorized.')
      } else if (error instanceof Error && (error.message.includes('revision')
        || error.message.includes('no longer pending'))) {
        reply(res, 409, 'revision-conflict', 'Project roles changed. Refresh before deciding.')
      } else {
        reply(res, 409, 'roles-rejected', 'Project role assignment could not be saved.')
      }
    }
  }
}

export function registerProjectRoleAssignmentRoute(webServer: {
  register: (route: { kind: 'exact'; path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => () => void
}, service: BizAgentService, options: ProjectRoleAssignmentRouteOptions): () => void {
  return webServer.register({ kind: 'exact', path: BIZAGENT_PROJECT_ROLE_ASSIGNMENTS_API,
    handler: createProjectRoleAssignmentHttpHandler(service, options) })
}

class RequestError extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > 8 * 1024) throw new RequestError('request body too large')
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RequestError('invalid JSON') }
}

function reply(res: ServerResponse, status: number, code: string, message: string): void {
  res.statusCode = status
  res.end(JSON.stringify({ error: { code, message } }))
}
