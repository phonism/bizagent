import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { HomeStore } from './home-store.js'
import { RUNTIME_WRITER_CLAIM_NAME, RUNTIME_WRITER_LOCK_NAME } from './writer-guard.js'

const MANIFEST = 'home-archive.json'

const ArchiveFileSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})

export const HomeArchiveManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('bizagent-dsh-home-files'),
  capturedAt: z.string().datetime(),
  files: z.array(ArchiveFileSchema).min(1),
  rootDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).superRefine((manifest, context) => {
  const paths = manifest.files.map(file => file.path)
  if (paths.some(path => !isSafePath(path) || path === MANIFEST
    || path === RUNTIME_WRITER_LOCK_NAME || path === RUNTIME_WRITER_CLAIM_NAME)) {
    context.addIssue({ code: 'custom', path: ['files'], message: 'unsafe archive path' })
  }
  if (new Set(paths).size !== paths.length || paths.join('\n') !== [...paths].sort(comparePath).join('\n')) {
    context.addIssue({ code: 'custom', path: ['files'], message: 'archive paths must be unique and sorted' })
  }
  if (manifest.rootDigest !== digestFiles(manifest.files)) {
    context.addIssue({ code: 'custom', path: ['rootDigest'], message: 'archive root digest mismatch' })
  }
})

export type HomeArchiveManifest = z.infer<typeof HomeArchiveManifestSchema>
type ArchiveFile = z.infer<typeof ArchiveFileSchema>

export async function exportHomeArchive(sourceRoot: string, destination: string): Promise<HomeArchiveManifest> {
  const source = resolve(sourceRoot)
  const target = resolve(destination)
  await requireRealDirectory(source)
  requireOutside(source, target)
  await requireAbsent(target)
  await mkdir(dirname(target), { recursive: true })
  const stage = await mkdtemp(join(dirname(target), `.${basename(target)}.stage-`))
  try {
    const files = await scanFiles(source, true)
    if (files.length === 0) throw new Error('Home root has no files to archive')
    if (files.some(file => file.path === MANIFEST)) {
      throw new Error(`Home root contains reserved archive filename: ${MANIFEST}`)
    }
    for (const file of files) {
      const output = join(stage, file.path)
      await mkdir(dirname(output), { recursive: true })
      await copyFile(join(source, file.path), output)
    }
    const stagedFiles = await scanFiles(stage)
    if (JSON.stringify(stagedFiles) !== JSON.stringify(files)
      || JSON.stringify(await scanFiles(source, true)) !== JSON.stringify(files)) {
      throw new Error('Home files changed during archive export')
    }
    const manifest = HomeArchiveManifestSchema.parse({
      schemaVersion: 1, kind: 'bizagent-dsh-home-files', capturedAt: new Date().toISOString(),
      files, rootDigest: digestFiles(files),
    }) as HomeArchiveManifest
    await writeFile(join(stage, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    await verifyHomeArchive(stage)
    await requireAbsent(target)
    await rename(stage, target)
    return manifest
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}

export async function verifyHomeArchive(archiveRoot: string): Promise<HomeArchiveManifest> {
  const root = resolve(archiveRoot)
  await requireRealDirectory(root)
  const manifest = HomeArchiveManifestSchema.parse(JSON.parse(await readFile(join(root, MANIFEST), 'utf8'))) as HomeArchiveManifest
  const actual = (await scanFiles(root)).filter(file => file.path !== MANIFEST)
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new Error('Home archive file list, size, or SHA-256 mismatch')
  }
  return manifest
}

export async function importHomeArchive(archiveRoot: string, destinationRoot: string): Promise<HomeArchiveManifest> {
  const archive = resolve(archiveRoot)
  const target = resolve(destinationRoot)
  const manifest = await verifyHomeArchive(archive)
  requireOutside(archive, target)
  await requireAbsent(target)
  await mkdir(dirname(target), { recursive: true })
  const stage = await mkdtemp(join(dirname(target), `.${basename(target)}.stage-`))
  try {
    for (const file of manifest.files) {
      const output = join(stage, file.path)
      await mkdir(dirname(output), { recursive: true })
      await copyFile(join(archive, file.path), output)
    }
    if (JSON.stringify(await scanFiles(stage)) !== JSON.stringify(manifest.files)) {
      throw new Error('Home archive changed during import')
    }
    const store = new HomeStore(stage)
    await store.initialize()
    const report = await store.doctor()
    if (!report.ok) throw new Error(`Imported Home files failed doctor: ${report.issues.join('; ')}`)
    await requireAbsent(target)
    await rename(stage, target)
    return manifest
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}

async function scanFiles(root: string, excludeWriterLock = false): Promise<ArchiveFile[]> {
  const files: ArchiveFile[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (excludeWriterLock && directory === root
        && [RUNTIME_WRITER_LOCK_NAME, RUNTIME_WRITER_CLAIM_NAME].includes(entry.name)) continue
      const path = join(directory, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error(`Home archive rejects symlinks: ${relative(root, path)}`)
      if (info.isDirectory()) {
        await visit(path)
      } else if (info.isFile()) {
        const name = relative(root, path).split('\\').join('/')
        if (!isSafePath(name)) throw new Error(`unsafe Home archive path: ${name}`)
        const bytes = await readFile(path)
        files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) })
      } else {
        throw new Error(`Home archive rejects non-file entry: ${relative(root, path)}`)
      }
    }
  }
  await visit(root)
  return files.sort((a, b) => comparePath(a.path, b.path))
}

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function isSafePath(path: string): boolean {
  return !isAbsolute(path) && !path.includes('\\') && !path.includes('\0')
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function digestFiles(files: readonly ArchiveFile[]): string {
  return sha256(JSON.stringify(files.map(file => [file.path, file.bytes, file.sha256])))
}

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function requireRealDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || await realpath(path) !== path) throw new Error(`expected a real directory: ${path}`)
}

async function requireAbsent(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error(`destination already exists: ${path}`)
}

function requireOutside(source: string, target: string): void {
  const rel = relative(source, target)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error('archive destination must be outside the source directory')
  }
}
