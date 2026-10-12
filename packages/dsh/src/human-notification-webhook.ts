import type { HumanNotificationOutcome, HumanNotificationProvider,
  HumanNotificationRequest } from './human-notification-runner.js'

const MAX_RESPONSE_BYTES = 64 * 1024

export interface HumanNotificationWebhookOptions {
  endpoint: string
  /** The host obtains a current credential from its secret store. */
  authorization: () => string | Promise<string>
  timeoutMs?: number
  fetch?: typeof fetch
}

/** Generic channel adapter: only an explicit provider receipt can confirm a push. */
export class HumanNotificationWebhook implements HumanNotificationProvider {
  private readonly endpoint: URL
  private readonly request: typeof fetch
  private readonly timeoutMs: number

  constructor(private readonly options: HumanNotificationWebhookOptions) {
    const endpoint = new URL(options.endpoint)
    if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) {
      throw new Error('human notification webhook requires HTTPS or loopback HTTP')
    }
    if (endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error('human notification webhook endpoint cannot contain credentials or a fragment')
    }
    const timeoutMs = options.timeoutMs ?? 10_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
      throw new Error('human notification webhook timeout must be 250 to 30000 ms')
    }
    this.endpoint = endpoint
    this.request = options.fetch ?? fetch
    this.timeoutMs = timeoutMs
  }

  async notify(request: HumanNotificationRequest): Promise<HumanNotificationOutcome> {
    const authorization = await this.options.authorization()
    if (!authorization.trim() || /[\r\n]/.test(authorization)) {
      throw new Error('human notification webhook credential is unavailable')
    }
    let response: Response
    try {
      response = await this.request(this.endpoint, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, ...request }),
        // Never forward the Authorization header to a redirect target.
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch {
      return { status: 'unknown' }
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return { status: 'unknown' }
    }
    const body = await boundedJson(response)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 'unknown' }
    const record = body as Record<string, unknown>
    if (record['status'] === 'sent' && typeof record['receiptId'] === 'string'
      && record['receiptId'].trim()) {
      return { status: 'sent', providerReceipt: record['receiptId'].trim() }
    }
    if (record['status'] === 'rejected' && typeof record['reason'] === 'string'
      && record['reason'].trim()) {
      return { status: 'rejected', reason: record['reason'].trim() }
    }
    return { status: 'unknown' }
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) return undefined
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      total += item.value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        return undefined
      }
      chunks.push(item.value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown }
    catch { return undefined }
  } catch { return undefined }
  finally { reader.releaseLock() }
}
