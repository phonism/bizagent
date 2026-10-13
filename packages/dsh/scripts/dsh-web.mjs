// Helpers for driving an isolated `dsh --profile web` process from smoke scripts.
import { randomUUID } from 'node:crypto'

/** The startup URL DSH Web prints, including its one-time login token. */
export function startupUrl(output) {
  return output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)?.[0]
}

/** Exchange the startup URL for DSH's browser login cookie, as a browser would. */
export async function signIn(url) {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).find(Boolean)
  if (cookie === undefined) throw new Error(`DSH Web did not issue a login cookie (HTTP ${response.status})`)
  return { base: new URL(url).origin, cookie }
}

/** Fetch a DSH Web path as the signed-in browser (cookie, plus Origin on mutations). */
export function webFetch(web, path, init = {}) {
  const headers = new Headers(init.headers)
  headers.set('Cookie', web.cookie)
  if ((init.method ?? 'GET') !== 'GET' && !headers.has('Origin')) headers.set('Origin', web.base)
  return fetch(`${web.base}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(10000) })
}

/** Call one DSH Remote endpoint, such as `session/prompt`, and return its value. */
export async function remote(web, endpoint, args) {
  const rpcId = randomUUID()
  const response = await webFetch(web, `/api/${endpoint}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }) })
  const text = await response.text()
  if (response.status !== 200) throw new Error(`${endpoint}: HTTP ${response.status} ${text.slice(0, 500)}`)
  const message = JSON.parse(text)
  if (message.rpcId !== rpcId) throw new Error(`${endpoint}: rpcId mismatch`)
  if (!message.result?.ok) throw new Error(`${endpoint}: ${JSON.stringify(message.result).slice(0, 800)}`)
  return message.result.value
}

/** Queue a user prompt on an existing Session. */
export function prompt(web, sessionId, text) {
  return remote(web, 'session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue',
    content: [{ type: 'text', text }] } })
}
