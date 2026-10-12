import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { exportHomeArchive, importHomeArchive, verifyHomeArchive } from '../lib/home-archive.js'
import { RuntimeWriterGuard } from '../lib/writer-guard.js'
import { makeTempDir } from './temp-dir.mjs'

const exec = promisify(execFile)

test('Home archive roundtrip preserves Home files and rejects tampering or overwrite', async (t) => {
  const base = await makeTempDir('bizagent-home-archive-')
  t.after(() => rm(base, { recursive: true, force: true }))
  const source = join(base, 'source')
  const archive = join(base, 'archive-v1')
  const restored = join(base, 'restored')
  const store = new HomeStore(source)
  await store.initialize()
  const home = await store.createHome({ address: 'personal:alice', identity: 'Alice keeps verified working knowledge.' })
  await writeFile(join(store.homesRoot, home.id, 'inbox.json'),
    JSON.stringify({ policy: 'batch', batchMinutes: 23 }))
  await store.createAsset({
    id: 'archived-knowledge', ownerAddress: 'personal:alice', kind: 'knowledge',
    description: 'Reviewed source field', body: 'Use event_day for the cohort date.',
    sourceRefs: [{ type: 'artifact', uri: 'test:cohort-schema', digest: 'sha256:test' }],
    status: 'candidate',
  })

  const cli = new URL('../lib/cli.js', import.meta.url).pathname
  const exported = await exec(process.execPath, [cli, '--root', source, 'archive', 'export', archive])
  const manifest = await verifyHomeArchive(archive)
  assert.equal(JSON.parse(exported.stdout).rootDigest, manifest.rootDigest)
  const verified = await exec(process.execPath, [cli, 'archive', 'verify', archive])
  assert.equal(JSON.parse(verified.stdout).verified, true)
  assert.equal(manifest.kind, 'bizagent-dsh-home-files')
  assert.equal((await verifyHomeArchive(archive)).rootDigest, manifest.rootDigest)
  await assert.rejects(() => exportHomeArchive(source, archive), /destination already exists/)
  const imported = await exec(process.execPath, [cli,
    '--root', restored, 'archive', 'import', archive])
  assert.equal(JSON.parse(imported.stdout).rootDigest, manifest.rootDigest)
  const reloaded = new HomeStore(restored)
  await reloaded.initialize()
  assert.equal(reloaded.getIdentity('personal:alice'), 'Alice keeps verified working knowledge.')
  assert.equal(reloaded.readAsset('personal:alice', 'archived-knowledge').body, 'Use event_day for the cohort date.')
  assert.equal(reloaded.readAsset('personal:alice', 'archived-knowledge').status, 'candidate')
  assert.deepEqual(await reloaded.readInboxWakePolicy('personal:alice'),
    { policy: 'batch', batchMinutes: 23 })
  assert.deepEqual((await reloaded.doctor()).issues, [])
  assert.equal((await exportHomeArchive(restored, join(base, 'roundtrip'))).rootDigest, manifest.rootDigest)
  await assert.rejects(() => exec(process.execPath, [cli,
    '--root', restored, 'archive', 'import', archive]), /destination already exists/)

  const file = manifest.files.find(item => item.path.endsWith('archived-knowledge.md'))
  assert.ok(file)
  await writeFile(join(archive, file.path), 'tampered')
  await assert.rejects(() => verifyHomeArchive(archive), /SHA-256 mismatch/)
  await assert.rejects(() => exec(process.execPath, [cli,
    '--root', join(base, 'tampered-import'), 'archive', 'import', archive]), /SHA-256 mismatch/)
  assert.equal((await readFile(join(restored, file.path), 'utf8')).includes('event_day'), true)
})

test('Home archive rejects symlinks and destinations inside the source root', async (t) => {
  const base = await makeTempDir('bizagent-home-archive-boundary-')
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'home')
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await assert.rejects(() => exportHomeArchive(root, join(root, 'nested-archive')), /outside the source/)
  await writeFile(join(base, 'external.txt'), 'should not enter the archive')
  await symlink(join(base, 'external.txt'), join(root, 'external-link'))
  await assert.rejects(() => exportHomeArchive(root, join(base, 'bad-archive')), /rejects symlinks/)
})

test('Home archive excludes an active writer guard from the restored Home', async t => {
  const base = await makeTempDir('bizagent-home-archive-guard-')
  t.after(() => rm(base, { recursive: true, force: true }))
  const source = join(base, 'source')
  const store = new HomeStore(source)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  const guard = await RuntimeWriterGuard.acquire([source])
  try {
    await writeFile(join(source, '.bizagent-writer-claim.lock'), 'transient claim')
    const archive = join(base, 'archive')
    const manifest = await exportHomeArchive(source, archive)
    assert.ok(!manifest.files.some(file => file.path.startsWith('.bizagent-writer')))
    const restored = join(base, 'restored')
    await importHomeArchive(archive, restored)
    await assert.rejects(readFile(join(restored, '.bizagent-writer.lock')), /ENOENT/)
  } finally {
    await guard.release()
  }
})
