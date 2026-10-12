import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { FormalProject } from './project-ledger.js'
import type { BizAgentService } from './service.js'
import { BIZAGENT_PROJECT_NODE_REVIEW_API } from './ui-contract.js'
import { WorkSnapshotStore } from './worklog-snapshot.js'

const MAX_BODY_BYTES = 8 * 1024
const Id = z.string().trim().min(1).max(200)
const Review = z.strictObject({ projectId: Id, nodeId: Id, workId: Id,
  expectedRevision: z.number().int().positive(),
  decision: z.enum(['approve', 'rework']), reason: z.string().trim().min(1).max(4000) })

export interface ProjectNodeReviewPrincipal { userId: string }
export interface ProjectNodeReviewRouteOptions {
  authenticateUser: (request: IncomingMessage) => ProjectNodeReviewPrincipal | null
    | Promise<ProjectNodeReviewPrincipal | null>
  authorizeMutation: (request: IncomingMessage, principal: ProjectNodeReviewPrincipal) =>
    boolean | Promise<boolean>
  /** Check the current Project, node, and reviewer Home against this human's actual grant. */
  authorizeReview: (principal: ProjectNodeReviewPrincipal, project: Readonly<FormalProject>,
    reviewerHome: string, nodeId: string) => boolean | Promise<boolean>
}

export function createProjectNodeReviewHttpHandler(service: BizAgentService,
  options: ProjectNodeReviewRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      reply(res, 405, failure('method-not-allowed', 'Use GET or POST for Workflow node review.'))
      return
    }
    try {
      const principal = await options.authenticateUser(req)
      if (!principal?.userId.trim()) {
        reply(res, 401, failure('authentication-required', 'Sign in to review a Workflow node.'))
        return
      }
      const authorize = (_actor: string, project: FormalProject, reviewerHome: string,
        nodeId: string) => options.authorizeReview(principal, project, reviewerHome, nodeId)
      if (req.method === 'GET') {
        const query = new URL(req.url ?? '', 'http://bizagent.local').searchParams
        if (query.get('inbox') === '1') {
          const offset = z.string().regex(/^(0|[1-9][0-9]{0,5})$/)
            .transform(Number).parse(query.get('offset') ?? '0')
          reply(res, 200, await service.listPendingProjectNodeReviewsAsHuman(
            principal.userId, authorize, offset))
          return
        }
        const projectId = Id.parse(query.get('projectId'))
        const nodeId = Id.parse(query.get('nodeId'))
        const access = await service.readProjectNodeReviewAsHuman(principal.userId, projectId,
          nodeId, authorize)
        if (query.has('artifactPath')) {
          const workId = Id.parse(query.get('workId'))
          const artifactPath = z.string().min(1).max(500).parse(query.get('artifactPath'))
          const artifact = access.workId === workId ? access.work?.resultArtifacts
            ?.find(item => item.path === artifactPath) : undefined
          if (!access.canReview || !artifact) {
            reply(res, 404, failure('artifact-unavailable', 'Workflow artifact is unavailable.'))
            return
          }
          const bytes = await new WorkSnapshotStore(service.store.root)
            .read(artifact.sha256, artifact.bytes)
          res.setHeader('Content-Type', 'application/octet-stream')
          res.setHeader('Content-Disposition', 'attachment; filename="workflow-artifact"')
          res.setHeader('Content-Length', bytes.byteLength)
          res.end(bytes)
          return
        }
        reply(res, 200, { canReview: access.canReview, revision: access.revision,
          workId: access.workId })
        return
      }
      if (!await options.authorizeMutation(req, principal)) {
        reply(res, 403, failure('mutation-forbidden', 'This request cannot review a Workflow node.'))
        return
      }
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        reply(res, 415, failure('content-type', 'Send JSON to review a Workflow node.'))
        return
      }
      const input = Review.parse(await readJson(req))
      const result = await service.reviewProjectNodeAsHuman(principal.userId, input, authorize)
      reply(res, 200, result)
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof RequestError) {
        reply(res, 400, failure('invalid-request', 'Check the Workflow review fields.'))
      } else if (error instanceof Error && error.message.includes('not authorized')) {
        reply(res, 403, failure('review-forbidden', 'This Workflow node cannot be reviewed here.'))
      } else if (error instanceof Error && error.message.includes('revision conflict')) {
        reply(res, 409, failure('revision-conflict', 'Project changed. Refresh before reviewing.'))
      } else {
        reply(res, 409, failure('review-rejected',
          'Workflow review could not be completed. Refresh and check its current state.'))
      }
    }
  }
}

export function registerProjectNodeReviewRoute(webServer: {
  register: (route: { kind: 'exact'; path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => () => void
}, service: BizAgentService, options: ProjectNodeReviewRouteOptions): () => void {
  return webServer.register({ kind: 'exact', path: BIZAGENT_PROJECT_NODE_REVIEW_API,
    handler: createProjectNodeReviewHttpHandler(service, options) })
}

class RequestError extends Error {}

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
