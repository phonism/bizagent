import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { FormalProject } from './project-ledger.js'
import type { BizAgentService } from './service.js'
import { BIZAGENT_PROJECT_DELIVERY_FEEDBACK_API } from './ui-contract.js'
import { ProjectSnapshotStore } from './worklog-snapshot.js'

const Id = z.string().trim().min(1).max(200)
const Opinion = z.strictObject({
  projectId: Id,
  path: z.string().min(1).max(500),
  version: z.enum(['working', 'submitted']),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedProjectRevision: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(128),
  section: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(5000),
})

export interface ProjectDeliveryFeedbackPrincipal { userId: string }
export interface ProjectDeliveryFeedbackRouteOptions {
  authenticateUser: (request: IncomingMessage) => ProjectDeliveryFeedbackPrincipal | null
    | Promise<ProjectDeliveryFeedbackPrincipal | null>
  authorizeMutation: (request: IncomingMessage, principal: ProjectDeliveryFeedbackPrincipal) =>
    boolean | Promise<boolean>
  /** Grant the current human access to this exact Project and its lead Home. */
  authorizeFeedback: (principal: ProjectDeliveryFeedbackPrincipal,
    project: Readonly<FormalProject>) => boolean | Promise<boolean>
}

export function createProjectDeliveryFeedbackHttpHandler(service: BizAgentService,
  options: ProjectDeliveryFeedbackRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      reply(res, 405, 'method-not-allowed', 'Use GET or POST for Project delivery feedback.')
      return
    }
    try {
      const principal = await options.authenticateUser(req)
      if (!principal?.userId.trim()) {
        reply(res, 401, 'authentication-required', 'Sign in to read Project delivery feedback.')
        return
      }
      if (req.method === 'GET') {
        const query = new URL(req.url ?? '', 'http://bizagent.local').searchParams
        const projectId = Id.parse(query.get('projectId'))
        const project = service.projectLedger?.get(projectId)
        if (project === undefined || !await options.authorizeFeedback(principal, project)) {
          reply(res, 403, 'feedback-forbidden', 'This Project is not available here.')
          return
        }
        const feedbackId = query.get('feedbackId')
        const assetPath = query.get('assetPath')
        if (feedbackId !== null && assetPath !== null) {
          reply(res, 400, 'invalid-request', 'Read one delivery asset at a time.')
          return
        }
        if (feedbackId !== null || assetPath !== null) {
          const source = feedbackId !== null
            ? project.deliveryFeedback?.find(item => item.id === Id.parse(feedbackId))
            : assetForRead(project, assetPath!, query)
          if (source === undefined) {
            reply(res, 404, 'asset-unavailable', 'This delivery snapshot is unavailable.')
            return
          }
          const bytes = await new ProjectSnapshotStore(service.store.root).read(source.sha256, source.bytes)
          res.setHeader('Content-Type', 'application/octet-stream')
          res.setHeader('Content-Disposition', 'attachment; filename="project-delivery-asset"')
          res.setHeader('Content-Length', bytes.byteLength)
          res.end(bytes)
          return
        }
        const latest = new Map<string, NonNullable<FormalProject['workingAssets']>[number]>()
        for (const asset of project.workingAssets ?? []) latest.set(asset.path, asset)
        const claim = project.status === 'awaiting_acceptance'
          ? project.claims.find(item => item.id === project.currentClaimId) : undefined
        res.end(JSON.stringify({ projectId: project.id, revision: project.revision,
          canFeedback: project.status === 'open' || project.status === 'awaiting_acceptance',
          workingAssets: [...latest.values()].map(item => ({ path: item.path,
            revision: item.revision, sha256: item.sha256, bytes: item.bytes })),
          submitted: claim === undefined ? null : { claimId: claim.id,
            artifacts: claim.artifacts ?? [] },
          feedback: project.deliveryFeedback ?? [] }))
        return
      }
      if (!await options.authorizeMutation(req, principal)) {
        reply(res, 403, 'mutation-forbidden', 'This request cannot comment on a Project.')
        return
      }
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        reply(res, 415, 'content-type', 'Send JSON to comment on a Project.')
        return
      }
      const input = Opinion.parse(await readJson(req))
      const { section, ...base } = input
      const result = await service.addProjectDeliveryFeedbackAsHuman(principal.userId,
        { ...base, ...(section === undefined ? {} : { section }) },
        (_actor, current) => options.authorizeFeedback(principal, current))
      res.end(JSON.stringify(result))
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof RequestError) {
        reply(res, 400, 'invalid-request', 'Check the delivery feedback fields.')
      } else if (error instanceof Error && error.message.includes('not authorized')) {
        reply(res, 403, 'feedback-forbidden', 'This Project is not available here.')
      } else if (error instanceof Error && (error.message.includes('revision conflict')
        || error.message.includes('asset changed'))) {
        reply(res, 409, 'revision-conflict', 'Delivery changed. Refresh before commenting.')
      } else {
        reply(res, 409, 'feedback-rejected', 'Delivery feedback could not be saved.')
      }
    }
  }
}

export function registerProjectDeliveryFeedbackRoute(webServer: {
  register: (route: { kind: 'exact'; path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => () => void
}, service: BizAgentService, options: ProjectDeliveryFeedbackRouteOptions): () => void {
  return webServer.register({ kind: 'exact', path: BIZAGENT_PROJECT_DELIVERY_FEEDBACK_API,
    handler: createProjectDeliveryFeedbackHttpHandler(service, options) })
}

function assetForRead(project: FormalProject, path: string, query: URLSearchParams):
  { sha256: string; bytes: number } | undefined {
  if (path.length < 1 || path.length > 500) return undefined
  const version = query.get('version')
  if (version === 'working') {
    const revision = query.get('revision')
    if (revision === null) return project.workingAssets?.findLast(item => item.path === path)
    const parsed = z.string().regex(/^[1-9][0-9]{0,5}$/).transform(Number).parse(revision)
    return project.workingAssets?.find(item => item.path === path && item.revision === parsed)
  }
  if (version === 'submitted' && project.status === 'awaiting_acceptance') {
    const claim = project.claims.find(item => item.id === project.currentClaimId)
    return claim?.artifacts?.find(item => item.path === path)
  }
  if (version === 'accepted' && project.status === 'accepted') {
    const claim = project.claims.find(item => item.id === project.acceptedClaimId)
    return claim?.artifacts?.find(item => item.path === path)
  }
  return undefined
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
