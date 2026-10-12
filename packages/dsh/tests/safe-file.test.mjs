import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { readRegularFileNoFollow } from '../lib/safe-file.js'
import { makeTempDir } from './temp-dir.mjs'

test('no-follow reads refuse symlinks, swapped files, special files, and oversized files', async t => {
  const root = await makeTempDir('bizagent-safe-file-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'result.md')
  const outside = join(root, 'outside-secret.txt')
  await writeFile(file, 'validated result')
  await writeFile(outside, 'secret outside the Workspace')
  assert.equal((await readRegularFileNoFollow(file)).toString('utf8'), 'validated result')

  const link = join(root, 'link.md')
  await symlink(outside, link)
  await assert.rejects(() => readRegularFileNoFollow(link), /symlink/)

  // The path was validated, then another file was swapped in before the read.
  const validated = await stat(file)
  await writeFile(join(root, 'replacement.md'), 'swapped content')
  await rename(join(root, 'replacement.md'), file)
  await assert.rejects(() => readRegularFileNoFollow(file,
    { expected: { dev: validated.dev, ino: validated.ino } }), /changed while it was being opened/)
  const current = await stat(file)
  assert.equal((await readRegularFileNoFollow(file,
    { expected: { dev: current.dev, ino: current.ino } })).toString('utf8'), 'swapped content')

  await assert.rejects(() => readRegularFileNoFollow(file, { maxBytes: 4 }), /exceeds 4 bytes/)
  await assert.rejects(() => readRegularFileNoFollow(root), /not a regular file/)
  if (process.platform !== 'win32') {
    const fifo = join(root, 'pipe.md')
    execFileSync('mkfifo', [fifo])
    await assert.rejects(() => readRegularFileNoFollow(fifo), /not a regular file/)
  }
})
