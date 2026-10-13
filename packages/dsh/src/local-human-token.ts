import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const LOCAL_HUMAN_COOKIE = 'bizagent_local_human'
const COOKIE_CONTEXT = 'bizagent-local-human-cookie-v1'

/** Where the local single-user host keeps its review token unless one is configured. */
export function defaultLocalHumanTokenFile(homeRoot: string): string {
  return join(homeRoot, 'local-human.token')
}

/** Create a private random token file if it does not exist yet. Returns true when created. */
export async function ensureLocalHumanToken(file: string): Promise<boolean> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  let handle
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    await handle.writeFile(`${randomBytes(32).toString('hex')}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return true
}

/** Read a token file that must be a private regular file owned by the current user. */
export async function readLocalHumanToken(file: string): Promise<string> {
  const info = await stat(file)
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw new Error('Local human token file must be a private regular file (mode 0600)')
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('Local human token file must belong to the current user')
  }
  const token = (await readFile(file, 'utf8')).trim()
  if (!isTokenShape(token)) throw new Error('Local human token must contain 32-512 non-whitespace characters')
  return token
}

export function isTokenShape(value: string): boolean {
  return value.length >= 32 && value.length <= 512 && !/\s/u.test(value)
}

/** Verifies a presented Bearer token or browser cookie against one local token. */
export class LocalHumanCredential {
  private readonly tokenDigest: Buffer
  private readonly cookieValue: string

  constructor(token: string) {
    this.tokenDigest = createHash('sha256').update(token).digest()
    // The cookie carries a derived value, so the token itself never sits in the browser.
    this.cookieValue = createHmac('sha256', token).update(COOKIE_CONTEXT).digest('hex')
  }

  matchesToken(candidate: string): boolean {
    if (!isTokenShape(candidate)) return false
    return timingSafeEqual(createHash('sha256').update(candidate).digest(), this.tokenDigest)
  }

  matchesCookie(cookieHeader: string | undefined): boolean {
    const presented = readCookie(cookieHeader, LOCAL_HUMAN_COOKIE)
    if (presented === undefined || presented.length !== this.cookieValue.length) return false
    return timingSafeEqual(Buffer.from(presented), Buffer.from(this.cookieValue))
  }

  setCookieHeader(maxAgeSeconds: number): string {
    return `${LOCAL_HUMAN_COOKIE}=${this.cookieValue}; Path=/api/bizagent; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`
  }
}

export function clearLocalHumanCookieHeader(): string {
  return `${LOCAL_HUMAN_COOKIE}=; Path=/api/bizagent; HttpOnly; SameSite=Strict; Max-Age=0`
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return undefined
}
