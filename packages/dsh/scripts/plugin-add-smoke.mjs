import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const run = promisify(execFile)
const temporary = await mkdtemp(join(tmpdir(), 'bizagent-plugin-add-'))

try {
  const packed = await run('npm', ['pack', '--silent', '--offline', '--pack-destination', temporary], {
    cwd: packageRoot, env: { ...process.env, npm_config_cache: join(temporary, 'pack-cache') },
  })
  const tarball = packed.stdout.trim()
  assert.match(tarball, /^bizagent-dsh-.*\.tgz$/)
  const smoke = await run('node', [join(packageRoot, 'scripts', 'profile-smoke.mjs')], {
    cwd: temporary,
    env: { ...process.env, BIZAGENT_PLUGIN_ADD_TARBALL: join(temporary, tarball) },
    maxBuffer: 1024 * 1024,
  })
  process.stdout.write(smoke.stdout)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
