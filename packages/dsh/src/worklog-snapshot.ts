import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const WORKLOG_SNAPSHOT_DIRECTORY = 'worklog-snapshots/sha256'
export const PROJECT_SNAPSHOT_DIRECTORY = 'project-snapshots/sha256'
export const WORK_SNAPSHOT_DIRECTORY = 'work-snapshots/sha256'
export const LEARNING_SNAPSHOT_DIRECTORY = 'learning-snapshots/sha256'
export const MAX_WORKLOG_FILE_BYTES = 8 * 1024 * 1024
const DIGEST = /^[a-f0-9]{64}$/

export function worklogSnapshotPath(sha256: string): string {
  if (!DIGEST.test(sha256)) throw new Error('invalid Worklog snapshot SHA-256')
  return `${WORKLOG_SNAPSHOT_DIRECTORY}/${sha256}`
}

export function projectSnapshotPath(sha256: string): string {
  if (!DIGEST.test(sha256)) throw new Error('invalid Project snapshot SHA-256')
  return `${PROJECT_SNAPSHOT_DIRECTORY}/${sha256}`
}

export function workSnapshotPath(sha256: string): string {
  if (!DIGEST.test(sha256)) throw new Error('invalid Work snapshot SHA-256')
  return `${WORK_SNAPSHOT_DIRECTORY}/${sha256}`
}

export function learningSnapshotPath(sha256: string): string {
  if (!DIGEST.test(sha256)) throw new Error('invalid Learning snapshot SHA-256')
  return `${LEARNING_SNAPSHOT_DIRECTORY}/${sha256}`
}

/** Immutable objects live under the Home root, so Home archives carry them. */
class HomeSnapshotStore {
  constructor(private readonly homeRoot: string, private readonly directoryName: string) {}

  async retain(bytes: Uint8Array): Promise<{ sha256: string; bytes: number }> {
    if (bytes.length > MAX_WORKLOG_FILE_BYTES) throw new Error('file snapshot exceeds 8 MiB')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const root = resolve(this.homeRoot)
    if (await realpath(root) !== root) throw new Error('snapshot Home root must be a real directory')
    const directory = join(root, this.directoryName)
    await mkdir(directory, { recursive: true })
    if (await realpath(directory) !== directory) throw new Error('snapshot directory traverses a symlink')
    const target = join(directory, sha256)
    const temporary = join(directory, `.${sha256}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
      try { await link(temporary, target) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    } finally {
      await rm(temporary, { force: true })
    }
    await this.read(sha256, bytes.length)
    return { sha256, bytes: bytes.length }
  }

  async read(sha256: string, expectedBytes?: number): Promise<Buffer> {
    const root = resolve(this.homeRoot)
    const directory = join(root, this.directoryName)
    if (await realpath(root) !== root || await realpath(directory) !== directory) {
      throw new Error('snapshot directory traverses a symlink')
    }
    if (!DIGEST.test(sha256)) throw new Error('invalid snapshot SHA-256')
    const target = join(directory, sha256)
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_WORKLOG_FILE_BYTES
      || (expectedBytes !== undefined && info.size !== expectedBytes)) {
      throw new Error('snapshot is missing, oversized, or changed')
    }
    const bytes = await readFile(target)
    if (bytes.length !== info.size || createHash('sha256').update(bytes).digest('hex') !== sha256) {
      throw new Error('snapshot checksum mismatch')
    }
    return bytes
  }
}

export class WorklogSnapshotStore extends HomeSnapshotStore {
  constructor(homeRoot: string) { super(homeRoot, WORKLOG_SNAPSHOT_DIRECTORY) }
}

export class ProjectSnapshotStore extends HomeSnapshotStore {
  constructor(homeRoot: string) { super(homeRoot, PROJECT_SNAPSHOT_DIRECTORY) }
}

export class WorkSnapshotStore extends HomeSnapshotStore {
  constructor(homeRoot: string) { super(homeRoot, WORK_SNAPSHOT_DIRECTORY) }
}

export class LearningSnapshotStore extends HomeSnapshotStore {
  constructor(homeRoot: string) { super(homeRoot, LEARNING_SNAPSHOT_DIRECTORY) }
}
