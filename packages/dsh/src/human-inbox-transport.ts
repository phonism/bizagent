import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { BizAgentService } from './service.js'

export const HUMAN_INBOX_API = '/api/bizagent/human-inbox'
const MAX_BODY_BYTES = 64 * 1024

const HumanInboxActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('handle'), messageId: z.string().min(1).max(200) }),
  z.strictObject({ action: z.literal('reply'), messageId: z.string().min(1).max(200),
    subject: z.string().min(1).max(200), body: z.string().min(1).max(16000),
    idempotencyKey: z.string().min(1).max(128) }),
  z.strictObject({ action: z.literal('notification-preference'), enabled: z.boolean(),
    expectedRevision: z.number().int().nonnegative() }),
])

export interface HumanInboxPrincipal {
  /** Verified by the host's session or bearer credential, never read from request fields. */
  userId: string
}

export interface HumanInboxRouteOptions {
  authenticateUser: (request: IncomingMessage) => HumanInboxPrincipal | null
    | Promise<HumanInboxPrincipal | null>
  /** The host checks CSRF protection or a non-cookie credential for every mutation. */
  authorizeMutation: (request: IncomingMessage, principal: HumanInboxPrincipal) => boolean | Promise<boolean>
}

/** Opt-in route; the core plugin cannot infer a human identity from DSH Agent bindings. */
export function createHumanInboxHttpHandler(service: BizAgentService, options: HumanInboxRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      reply(res, 405, { error: 'method-not-allowed' })
      return
    }
    try {
      const principal = await options.authenticateUser(req)
      if (!principal || !principal.userId.trim()) {
        reply(res, 401, { error: 'authentication-required' })
        return
      }
      if (req.method === 'GET') {
        const url = new URL(req.url ?? '', 'http://bizagent.local')
        const messageId = url.searchParams.get('messageId')
        if (messageId) {
          reply(res, 200, service.readHumanInbox(principal.userId, messageId))
          return
        }
        const direction = url.searchParams.get('direction')
        const beforeMessageId = url.searchParams.get('beforeMessageId')
        const limit = url.searchParams.get('limit')
        reply(res, 200, service.listHumanInbox(principal.userId, {
          ...(direction !== null ? { direction: direction as 'incoming' | 'outgoing' | 'both' } : {}),
          ...(beforeMessageId !== null ? { beforeMessageId } : {}),
          ...(limit !== null ? { limit: Number(limit) } : {}),
          pendingOnly: url.searchParams.get('pendingOnly') === 'true',
        }))
        return
      }
      if (!(await options.authorizeMutation(req, principal))) {
        reply(res, 403, { error: 'mutation-forbidden' })
        return
      }
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        reply(res, 415, { error: 'content-type' })
        return
      }
      const action = HumanInboxActionSchema.parse(await readJson(req))
      const result = action.action === 'handle'
        ? await service.handleHumanInbox(principal.userId, action.messageId)
        : action.action === 'notification-preference'
          ? await service.setHumanNotificationPreference(principal.userId,
            action.enabled, action.expectedRevision)
          : await service.replyHumanInbox(principal.userId, {
            replyTo: action.messageId, subject: action.subject, body: action.body,
            idempotencyKey: action.idempotencyKey,
          })
      reply(res, 200, result)
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof RequestError) {
        reply(res, 400, { error: 'invalid-request' })
      } else {
        reply(res, 409, { error: 'inbox-operation-rejected' })
      }
    }
  }
}

export function registerHumanInboxRoute(webServer: {
  register: (route: { kind: 'exact'; path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => () => void
}, service: BizAgentService, options: HumanInboxRouteOptions): () => void {
  return webServer.register({ kind: 'exact', path: HUMAN_INBOX_API,
    handler: createHumanInboxHttpHandler(service, options) })
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

function reply(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code
  res.end(JSON.stringify(body))
}
