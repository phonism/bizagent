import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Browser-trust fence for every HTTP route this plugin registers on the local DSH web server.
 *
 * It mirrors DSH's own API guard: DNS rebinding (a page on an attacker domain resolving to
 * 127.0.0.1) still names the attacker domain in `Host`, so the Host must be loopback; a
 * cross-site page is rejected by Fetch Metadata; and every mutation must carry an `Origin`
 * whose host:port equals the `Host`. This is not an authentication layer.
 */
export type RouteRejection = 'untrusted-host' | 'cross-site-request' | 'origin-rejected'

const SAFE_METHODS = new Set(['GET', 'HEAD'])

export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Return why a request must be rejected, or undefined when it may reach the handler. */
export function localRouteRejection(request: Pick<IncomingMessage, 'method' | 'headers'>): RouteRejection | undefined {
  const host = singleHeader(request.headers.host)
  const hostUrl = host === undefined ? undefined : parseAuthority(host)
  if (hostUrl === undefined || !isLoopbackHostname(hostUrl.hostname)) return 'untrusted-host'
  if (singleHeader(request.headers['sec-fetch-site'])?.toLowerCase() === 'cross-site') {
    return 'cross-site-request'
  }
  const origin = singleHeader(request.headers.origin)
  if (origin === undefined) {
    return SAFE_METHODS.has((request.method ?? 'GET').toUpperCase()) ? undefined : 'origin-rejected'
  }
  try {
    const originUrl = new URL(origin)
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return 'origin-rejected'
    return originUrl.host === hostUrl.host ? undefined : 'origin-rejected'
  } catch {
    return 'origin-rejected'
  }
}

/** Wrap a route handler so untrusted browser requests get a 403 before any handler code runs. */
export function guardLocalRoute<Req extends IncomingMessage, Res extends ServerResponse>(
  handler: (request: Req, response: Res) => void | Promise<void>,
): (request: Req, response: Res) => Promise<void> {
  return async (request, response) => {
    if (rejectUntrustedRequest(request, response)) return
    await handler(request, response)
  }
}

/** Write the standard 403 response and return true when the request fails the fence. */
export function rejectUntrustedRequest(request: Pick<IncomingMessage, 'method' | 'headers'>,
  response: Pick<ServerResponse, 'setHeader' | 'end'> & { statusCode: number }): boolean {
  const rejection = localRouteRejection(request)
  if (rejection === undefined) return false
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.statusCode = 403
  response.end(JSON.stringify({ error: { code: rejection, message: REJECTION_MESSAGES[rejection] } }))
  return true
}

const REJECTION_MESSAGES: Record<RouteRejection, string> = {
  'untrusted-host': 'This endpoint only serves the local loopback DSH origin.',
  'cross-site-request': 'Cross-site requests are not accepted.',
  'origin-rejected': 'Mutation requests must come from this DSH origin.',
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Parse a bare `host[:port]` authority; anything with userinfo, a path, query, or fragment is refused. */
function parseAuthority(authority: string): URL | undefined {
  if (authority.length === 0 || /[\s/?#@\\]/u.test(authority)) return undefined
  try {
    const url = new URL(`http://${authority}`)
    return url.username === '' && url.password === '' && url.pathname === '/' ? url : undefined
  } catch {
    return undefined
  }
}
