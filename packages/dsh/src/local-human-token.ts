import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'

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

function isTokenShape(value: string): boolean {
  return value.length >= 32 && value.length <= 512 && !/\s/u.test(value)
}

/** Verifies a presented Bearer token against one local token without leaking timing. */
export class LocalHumanCredential {
  private readonly tokenDigest: Buffer

  constructor(token: string) {
    this.tokenDigest = createHash('sha256').update(token).digest()
  }

  matchesToken(candidate: string): boolean {
    if (!isTokenShape(candidate)) return false
    return timingSafeEqual(createHash('sha256').update(candidate).digest(), this.tokenDigest)
  }
}
