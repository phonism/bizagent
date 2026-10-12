import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { stableId } from './domain.js'
import type { FormalProject } from './project-ledger.js'
import type { BizAgentService } from './service.js'
import { BIZAGENT_PROJECT_REVIEW_API } from './ui-contract.js'
import { ProjectSnapshotStore, WorkSnapshotStore } from './worklog-snapshot.js'

const MAX_BODY_BYTES = 8 * 1024
const Id = z.string().trim().min(1).max(200)
const Review = z.strictObject({ projectId: Id, claimId: Id,
  expectedRevision: z.number().int().positive(),
  decision: z.enum(['accept', 'rework']), reason: z.string().trim().min(1).max(4000) })

export interface ProjectReviewPrincipal { userId: string }
export interface ProjectReviewRouteOptions {
  authenticateUser: (request: IncomingMessage) => ProjectReviewPrincipal | null
    | Promise<ProjectReviewPrincipal | null>
  authorizeMutation: (request: IncomingMessage, principal: ProjectReviewPrincipal) =>
    boolean | Promise<boolean>
  /** Check the current Project and its lead against this human's actual grant. */
  authorizeReview: (principal: ProjectReviewPrincipal, project: Readonly<FormalProject>) =>
    boolean | Promise<boolean>
}

/** Optional human Project acceptance route; Agent reviews continue through their bound Sessions. */
export function createProjectReviewHttpHandler(service: BizAgentService,
  options: ProjectReviewRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      reply(res, 405, failure('method-not-allowed', 'Use GET or POST for Project review.'))
      return
    }
    try {
      const principal = await options.authenticateUser(req)
      if (!principal?.userId.trim()) {
        reply(res, 401, failure('authentication-required', 'Sign in to review a Project.'))
        return
      }
      if (req.method === 'GET') {
        const query = new URL(req.url ?? '', 'http://bizagent.local').searchParams
        if (query.get('inbox') === '1') {
          const offset = z.string().regex(/^(0|[1-9][0-9]{0,5})$/)
            .transform(Number).parse(query.get('offset') ?? '0')
          reply(res, 200, await service.listPendingProjectOutcomeReviewsAsHuman(
            principal.userId, (_actor, current) => options.authorizeReview(principal, current), offset))
          return
        }
        const projectId = Id.parse(query.get('projectId'))
        const project = service.projectLedger?.get(projectId)
        if (!project || !await options.authorizeReview(principal, project)) {
          reply(res, 403, failure('review-forbidden', 'This Project cannot be reviewed here.'))
          return
        }
        if (query.has('artifactPath')) {
          const claimId = Id.parse(query.get('claimId'))
          const artifactPath = z.string().min(1).max(500).parse(query.get('artifactPath'))
          if (query.has('workId')) {
            const workId = Id.parse(query.get('workId'))
            const claim = project.status === 'awaiting_acceptance'
              && project.currentClaimId === claimId
              ? project.claims.find(item => item.id === claimId) : undefined
            const reference = claim?.work.find(item => item.id === workId
              && item.status === 'completed')
            const work = service.workLedger?.get(workId)
            const artifact = work?.projectId === project.id && work.status === 'completed'
              && work.resultMessageId === reference?.resultMessageId
              ? work.resultArtifacts?.find(item => item.path === artifactPath) : undefined
            if (!reference || !artifact) {
              reply(res, 404, failure('artifact-unavailable', 'Work artifact is unavailable.'))
              return
            }
            const bytes = await new WorkSnapshotStore(service.store.root)
              .read(artifact.sha256, artifact.bytes)
            res.setHeader('Content-Type', 'application/octet-stream')
            res.setHeader('Content-Disposition', 'attachment; filename="work-artifact"')
            res.setHeader('Content-Length', bytes.byteLength)
            res.end(bytes)
            return
          }
          const artifact = project.claims.find(item => item.id === claimId)?.artifacts
            ?.find(item => item.path === artifactPath)
          if (!artifact) {
            reply(res, 404, failure('artifact-unavailable', 'Project artifact is unavailable.'))
            return
          }
          const bytes = await new ProjectSnapshotStore(service.store.root)
            .read(artifact.sha256, artifact.bytes)
          res.setHeader('Content-Type', 'application/octet-stream')
          res.setHeader('Content-Disposition', 'attachment; filename="project-artifact"')
          res.setHeader('Content-Length', bytes.byteLength)
          res.end(bytes)
          return
        }
        const latestReview = project.reviews?.at(-1)
        const reworkId = latestReview?.decision === 'rework'
          && latestReview.claimId === project.currentClaimId
          ? stableId('project-outcome-rework', `${project.id}:${latestReview.claimId}`) : undefined
        reply(res, 200, { canReview: project.status === 'awaiting_acceptance',
          revision: project.revision, claimId: project.currentClaimId ?? null,
          ...(reworkId === undefined ? {} : { outcomeReworkNotification: {
            claimId: latestReview!.claimId,
            state: service.ledger.getInboxMessage(reworkId)
              && service.ledger.getInboxDelivery(reworkId, project.lead)?.status === 'delivered'
              ? 'delivered' : 'pending',
          } }) })
        return
      }
      if (!await options.authorizeMutation(req, principal)) {
        reply(res, 403, failure('mutation-forbidden', 'This request cannot review a Project.'))
        return
      }
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        reply(res, 415, failure('content-type', 'Send JSON to review a Project.'))
        return
      }
      const input = Review.parse(await readJson(req))
      const result = await service.reviewProjectAsHuman(principal.userId, input,
        (_actor, current) => options.authorizeReview(principal, current))
      reply(res, 200, result)
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof RequestError) {
        reply(res, 400, failure('invalid-request', 'Check the Project review fields.'))
      } else if (error instanceof Error && error.message.includes('not authorized')) {
        reply(res, 403, failure('review-forbidden', 'This Project cannot be reviewed here.'))
      } else if (error instanceof Error && error.message.includes('revision conflict')) {
        reply(res, 409, failure('revision-conflict', 'Project changed. Refresh before reviewing.'))
      } else {
        reply(res, 409, failure('review-rejected',
          'Project review could not be completed. Refresh and check its current state.'))
      }
    }
  }
}

export function registerProjectReviewRoute(webServer: {
  register: (route: { kind: 'exact'; path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => () => void
}, service: BizAgentService, options: ProjectReviewRouteOptions): () => void {
  return webServer.register({ kind: 'exact', path: BIZAGENT_PROJECT_REVIEW_API,
    handler: createProjectReviewHttpHandler(service, options) })
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
