import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { stableId } from './domain.js'
import type { FormalProject } from './project-ledger.js'
import type { BizAgentService } from './service.js'
import { BIZAGENT_PROJECT_PLAN_API } from './ui-contract.js'

const MAX_BODY_BYTES = 128 * 1024
const Id = z.string().trim().min(1).max(200)
const Revision = z.number().int().positive()
const Reason = z.string().trim().min(1).max(4000)
const IdempotencyKey = z.string().trim().min(1).max(128)
const Step = z.strictObject({
  id: Id, title: z.string().trim().min(1).max(120),
  intent: z.string().trim().min(1).max(4000), executor: Id,
  acceptanceCriteria: z.string().trim().min(1).max(4000),
  after: z.array(Id).max(12).optional(),
  reviewer: Id.optional(), reviewCriteria: z.string().trim().min(1).max(4000).optional(),
})
const Workflow = z.strictObject({ summary: z.string().trim().min(1).max(2000),
  steps: z.array(Step).min(1).max(12) })
const Action = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('progression'), projectId: Id,
    expectedRevision: Revision, mode: z.enum(['automatic', 'reviewed']),
    reviewers: z.array(z.strictObject({ nodeId: Id, reviewerHome: Id })).max(12),
    reason: Reason }),
  z.strictObject({ action: z.literal('amend'), projectId: Id,
    expectedRevision: Revision, expectedWorkflowRevision: Revision,
    reason: Reason, idempotencyKey: IdempotencyKey, proposalKey: IdempotencyKey.optional(),
    workflow: Workflow }),
  z.strictObject({ action: z.literal('rebuild'), projectId: Id,
    expectedRevision: Revision, expectedWorkflowRevision: Revision,
    reason: Reason, idempotencyKey: IdempotencyKey, proposalKey: IdempotencyKey.optional(),
    restartNodeIds: z.array(Id).max(12).optional(),
    workflow: Workflow }),
  z.strictObject({ action: z.literal('reopen'), projectId: Id,
    expectedRevision: Revision, nodeId: Id, reason: Reason }),
  z.strictObject({ action: z.literal('reassign'), projectId: Id,
    expectedRevision: Revision, nodeId: Id, workId: Id,
    expectedPrincipal: Id.nullable(), assignedPrincipal: Id, reason: Reason }),
])

export interface ProjectPlanPrincipal { userId: string }
export interface ProjectPlanRouteOptions {
  authenticateUser: (request: IncomingMessage) => ProjectPlanPrincipal | null
    | Promise<ProjectPlanPrincipal | null>
  authorizeMutation: (request: IncomingMessage, principal: ProjectPlanPrincipal) =>
    boolean | Promise<boolean>
  /** Check the human's current grant over the Project and lead Home. */
  authorizePlan: (principal: ProjectPlanPrincipal, project: Readonly<FormalProject>) =>
    boolean | Promise<boolean>
  /** Check each reviewer Home assignment against the manager's current Host grant. */
  authorizeReviewerHome?: (principal: ProjectPlanPrincipal, project: Readonly<FormalProject>,
    reviewerHome: string, nodeId: string) => boolean | Promise<boolean>
  inspectRuntime: (principal: ProjectPlanPrincipal, projectId: string) => Promise<{
    status: 'quiet' | 'busy' | 'unknown'; sessionIds: string[]
  }>
  /** Host-provided active humans eligible to review this Home's node result. */
  listReviewerCandidates?: (principal: ProjectPlanPrincipal, project: Readonly<FormalProject>,
    reviewerHome: string, nodeId: string) => Promise<Array<{ userId: string; name: string }>>
  /** Revalidate the chosen human's grant inside the Project write lock. */
  authorizeReviewerTarget?: (targetUserId: string, project: Readonly<FormalProject>,
    reviewerHome: string, nodeId: string, workId: string) => boolean | Promise<boolean>
}

export function createProjectPlanHttpHandler(service: BizAgentService,
  options: ProjectPlanRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      reply(res, 405, failure('method-not-allowed', 'Use GET or POST for Project plan changes.'))
      return
    }
    try {
      const principal = await options.authenticateUser(req)
      if (!principal?.userId.trim()) {
        reply(res, 401, failure('authentication-required', 'Sign in to change the Project plan.'))
        return
      }
      const authorize = (_actor: string, project: FormalProject) =>
        options.authorizePlan(principal, project)
      if (req.method === 'GET') {
        const query = new URL(req.url ?? '', 'http://bizagent.local').searchParams
        const projectId = Id.parse(query.get('projectId'))
        const project = service.projectLedger?.get(projectId)
        if (!project || !await options.authorizePlan(principal, project)) {
          reply(res, 403, failure('plan-forbidden', 'This Project plan cannot be changed here.'))
          return
        }
        const openWorkflow = project.status === 'open' && project.workflow !== undefined
        const progression = project.progressionChanges?.at(-1)
        const noticeId = progression === undefined ? undefined
          : stableId('project-progression', `${project.id}:${progression.revision}`)
        const base = { revision: project.revision,
          workflowRevision: project.workflow?.revision ?? null,
          ...(progression === undefined ? {} : { progressionNotification: {
            revision: progression.revision,
            state: noticeId !== undefined && service.ledger.getInboxMessage(noticeId)
              && service.ledger.getInboxDelivery(noticeId, project.lead)?.status === 'delivered'
              ? 'delivered' : 'pending',
          } }),
          canSetProgression: openWorkflow && Boolean(options.authorizeReviewerHome),
          canAmend: openWorkflow && !project.intervention?.paused,
          canRebuild: openWorkflow && Boolean(project.intervention?.paused),
          canReopen: openWorkflow && !project.intervention?.paused,
          canReassign: openWorkflow && !project.intervention?.paused
            && Boolean(options.listReviewerCandidates && options.authorizeReviewerTarget) }
        if (query.has('nodeId') && base.canReassign) {
          const nodeId = Id.parse(query.get('nodeId'))
          const step = project.workflow?.steps.find(item => item.id === nodeId)
          const latest = service.workLedger?.list().filter(item => item.projectId === project.id
            && item.workflowNodeId === nodeId).sort((a, b) =>
            (b.workflowAttempt ?? 0) - (a.workflowAttempt ?? 0))[0]
          const reviewerHome = latest?.workflowReview?.mode === 'reviewed'
            ? latest.workflowReview.reviewerHome
            : latest?.workflowReview?.mode === 'automatic' ? undefined : step?.reviewer
          if (!step || reviewerHome === undefined) {
            reply(res, 404, failure('node-unavailable', 'Reviewer candidates are unavailable.'))
            return
          }
          const candidates = z.array(z.strictObject({ userId: Id,
            name: z.string().trim().min(1).max(200) })).max(100)
            .parse(await options.listReviewerCandidates!(principal, project, reviewerHome, nodeId))
          reply(res, 200, { ...base, reviewerCandidates: candidates })
          return
        }
        reply(res, 200, base)
        return
      }
      if (!await options.authorizeMutation(req, principal)) {
        reply(res, 403, failure('mutation-forbidden', 'This request cannot change the Project plan.'))
        return
      }
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        reply(res, 415, failure('content-type', 'Send JSON to change the Project plan.'))
        return
      }
      const input = Action.parse(await readJson(req))
      if (input.action === 'progression') {
        if (!options.authorizeReviewerHome) {
          reply(res, 409, failure('progression-unavailable', 'Reviewer Home authorization is unavailable.'))
          return
        }
        const result = await service.setProjectProgressionAsHuman(principal.userId, input, authorize,
          (_actor, project, reviewerHome, nodeId) =>
            options.authorizeReviewerHome!(principal, project, reviewerHome, nodeId))
        reply(res, 200, result)
      } else if (input.action === 'reassign') {
        if (!options.authorizeReviewerTarget) {
          reply(res, 409, failure('reassignment-unavailable', 'Reviewer reassignment is unavailable.'))
          return
        }
        const result = await service.reassignProjectNodeReviewerAsHuman(principal.userId, input,
          authorize, options.authorizeReviewerTarget)
        reply(res, 200, result)
      } else if (input.action === 'reopen') {
        const result = await service.reopenProjectNodeAsHuman(principal.userId, input, authorize)
        reply(res, 200, result)
      } else if (input.action === 'amend') {
        const result = await service.amendProjectWorkflowAsHuman(principal.userId, {
          ...input, expectedProjectRevision: input.expectedRevision,
        }, authorize)
        reply(res, 200, result)
      } else {
        const result = await service.rebuildProjectWorkflowAsHuman(principal.userId, {
          ...input, expectedProjectRevision: input.expectedRevision,
        }, authorize, () => options.inspectRuntime(principal, input.projectId))
        reply(res, 200, result)
      }
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof RequestError) {
        reply(res, 400, failure('invalid-request', 'Check the Project plan fields.'))
      } else if (error instanceof Error && error.message.includes('not authorized')) {
        reply(res, 403, failure('plan-forbidden', 'This Project plan cannot be changed here.'))
      } else if (error instanceof Error && (error.message.includes('revision changed')
        || error.message.includes('revision conflict')
        || error.message.includes('assignment changed'))) {
        reply(res, 409, failure('revision-conflict', 'Project changed. Refresh before editing.'))
      } else {
        reply(res, 409, failure('plan-rejected',
          'Project plan could not be changed. Refresh and check its current state.'))
      }
    }
  }
}

export function registerProjectPlanRoute(webServer: {
  register: (route: { kind: 'exact'; path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => () => void
}, service: BizAgentService, options: ProjectPlanRouteOptions): () => void {
  return webServer.register({ kind: 'exact', path: BIZAGENT_PROJECT_PLAN_API,
    handler: createProjectPlanHttpHandler(service, options) })
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
