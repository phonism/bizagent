import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'

export interface RegularFileIdentity {
  dev: number
  ino: number
}

export interface ReadRegularFileOptions {
  /** Reject files larger than this many bytes, checked on the open handle. */
  maxBytes?: number
  /** Require the opened file to be this exact inode, e.g. one validated by an earlier path check. */
  expected?: RegularFileIdentity
}

/**
 * Read one file without following a final symlink and without a check-then-read race: the file
 * is opened with O_NOFOLLOW (O_NONBLOCK keeps a FIFO from blocking the open), then the open
 * handle is checked to be a regular file and read. Platforms without O_NOFOLLOW fall back to an
 * lstat check plus the same handle checks.
 */
export async function readRegularFileNoFollow(path: string, options: ReadRegularFileOptions = {}): Promise<Buffer> {
  if (constants.O_NOFOLLOW === undefined) {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error(`refusing to follow a symlink: ${path}`)
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  let handle
  try {
    handle = await open(path, flags)
  } catch (error) {
    if (isErrno(error, 'ELOOP')) throw new Error(`refusing to follow a symlink: ${path}`, { cause: error })
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`not a regular file: ${path}`)
    if (options.expected !== undefined
      && (info.dev !== options.expected.dev || info.ino !== options.expected.ino)) {
      throw new Error(`file changed while it was being opened: ${path}`)
    }
    if (options.maxBytes !== undefined && info.size > options.maxBytes) {
      throw new Error(`file exceeds ${options.maxBytes} bytes: ${path}`)
    }
    const bytes = await handle.readFile()
    if (options.maxBytes !== undefined && bytes.length > options.maxBytes) {
      throw new Error(`file exceeds ${options.maxBytes} bytes: ${path}`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
