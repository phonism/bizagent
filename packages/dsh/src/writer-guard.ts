import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, realpath, lstat, unlink, type FileHandle } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'

interface HeldLock {
  path: string
  handle: FileHandle
  device: number
  inode: number
}

export const RUNTIME_WRITER_LOCK_NAME = '.bizagent-writer.lock'
export const RUNTIME_WRITER_CLAIM_NAME = '.bizagent-writer-claim.lock'
const CLAIM_WAIT_MS = 2_000
const CLAIM_POLL_MS = 25
/** Lock and claim paths this process currently holds, so its own PID is not mistaken for a live owner. */
const heldInProcess = new Set<string>()

/** Prevent two DSH processes from using independent cached Domain snapshots for the same profile or Home root. */
export class RuntimeWriterGuard {
  private released = false

  private constructor(private readonly locks: HeldLock[]) {}

  static async acquire(roots: string[]): Promise<RuntimeWriterGuard> {
    const canonical = new Set<string>()
    for (const root of roots) {
      await mkdir(root, { recursive: true })
      canonical.add(await realpath(resolve(root)))
    }
    const held: HeldLock[] = []
    try {
      for (const root of [...canonical].sort()) {
        const path = join(root, RUNTIME_WRITER_LOCK_NAME)
        const claim = await acquireClaim(join(root, RUNTIME_WRITER_CLAIM_NAME))
        try {
          const existing = await inspectLock(path)
          if (existing) {
            if (ownerMayBeLive(path, existing.owner)) {
              throw new Error(`BizAgent writer is already reserved at ${path} `
                + `by ${existing.owner.hostname} PID ${existing.owner.pid}`)
            }
            const current = await lstat(path)
            if (current.dev !== existing.device || current.ino !== existing.inode) {
              throw new Error(`BizAgent writer lock changed during recovery: ${path}`)
            }
            await unlink(path)
          }
          held.push(await createHeld(path))
        } finally {
          await releaseLocks([claim])
        }
      }
      return new RuntimeWriterGuard(held)
    } catch (error) {
      await releaseLocks(held)
      throw error
    }
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    await releaseLocks(this.locks)
  }
}

async function acquireClaim(path: string): Promise<HeldLock> {
  const deadline = Date.now() + CLAIM_WAIT_MS
  while (true) {
    try { return await createHeld(path) } catch (error) {
      if (!isExists(error)) throw error
    }
    let claim: Awaited<ReturnType<typeof inspectLock>>
    try { claim = await inspectLock(path) } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise(resolveDelay => setTimeout(resolveDelay, CLAIM_POLL_MS))
      continue
    }
    if (!claim) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, CLAIM_POLL_MS))
      continue
    }
    if (claim.owner.hostname !== hostname() || !ownerMayBeLive(path, claim.owner)) {
      throw new Error(`BizAgent writer recovery claim is stale at ${path}; `
        + 'verify the prior process before removing it')
    }
    if (Date.now() >= deadline) throw new Error(`BizAgent writer acquisition is busy at ${path}`)
    await new Promise(resolveDelay => setTimeout(resolveDelay, CLAIM_POLL_MS))
  }
}

async function inspectLock(path: string): Promise<{
  device: number; inode: number; owner: { pid: number; hostname: string }
} | undefined> {
  const info = await lstat(path).catch(error => {
    if (isMissing(error)) return undefined
    throw error
  })
  if (!info) return undefined
  if (!info.isFile()) throw new Error(`BizAgent writer lock is not a regular file: ${path}`)
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch (error) {
    if (isMissing(error)) return undefined
    throw new Error(`BizAgent writer lock is unreadable at ${path}; verify before removing it`)
  }
  let owner: unknown
  try { owner = JSON.parse(raw) } catch {
    throw new Error(`BizAgent writer lock is unreadable at ${path}; verify before removing it`)
  }
  if (!validOwner(owner)) {
    throw new Error(`BizAgent writer lock has invalid owner at ${path}; verify before removing it`)
  }
  return { device: info.dev, inode: info.ino, owner }
}

async function createHeld(path: string): Promise<HeldLock> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(),
      createdAt: new Date().toISOString(), token: randomUUID() }) + '\n')
    await handle.sync()
    const info = await handle.stat()
    heldInProcess.add(path)
    return { path, handle, device: info.dev, inode: info.ino }
  } catch (error) {
    const info = await handle.stat().catch(() => undefined)
    await handle.close()
    const current = await lstat(path).catch(() => undefined)
    if (info && current && info.dev === current.dev && info.ino === current.ino) {
      await unlink(path).catch(() => undefined)
    }
    throw error
  }
}

function validOwner(value: unknown): value is { pid: number; hostname: string } {
  if (typeof value !== 'object' || value === null) return false
  const owner = value as Record<string, unknown>
  return Number.isSafeInteger(owner['pid']) && Number(owner['pid']) > 0
    && typeof owner['hostname'] === 'string' && owner['hostname'].length > 0
    && typeof owner['token'] === 'string' && owner['token'].length > 0
}

/**
 * Whether a lock owner may still be running. Another host cannot be checked, so it counts as live.
 * The current PID is live only while this process holds the path: after a crash, a restart that
 * reuses the PID (for example PID 1 in a container) must not be blocked by its predecessor's lock.
 */
function ownerMayBeLive(path: string, owner: { pid: number; hostname: string }): boolean {
  if (owner.hostname !== hostname()) return true
  if (owner.pid === process.pid) return heldInProcess.has(path)
  return processAlive(owner.pid)
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

async function releaseLocks(locks: HeldLock[]): Promise<void> {
  const errors: unknown[] = []
  for (const lock of [...locks].reverse()) {
    try {
      const current = await lstat(lock.path).catch(error => {
        if (isMissing(error)) return undefined
        throw error
      })
      if (current && (current.dev !== lock.device || current.ino !== lock.inode)) {
        throw new Error(`BizAgent writer lock changed while held: ${lock.path}`)
      }
      if (current) await unlink(lock.path)
    } catch (error) {
      errors.push(error)
    } finally {
      heldInProcess.delete(lock.path)
      await lock.handle.close().catch(error => { errors.push(error) })
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'BizAgent writer lock cleanup failed')
}

function isExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
