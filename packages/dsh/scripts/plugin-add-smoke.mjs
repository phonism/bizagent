import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const run = promisify(execFile)
const temporary = await mkdtemp(join(tmpdir(), 'bizagent-plugin-add-'))

try {
  let spec
  if (process.argv.includes('--registry')) {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    spec = `${manifest.name}@${manifest.version}`
  } else {
    const packed = await run('npm', ['pack', '--silent', '--offline', '--pack-destination', temporary], {
      cwd: packageRoot, env: { ...process.env, npm_config_cache: join(temporary, 'pack-cache') },
    })
    const tarball = packed.stdout.trim()
    assert.match(tarball, /^bizagent-dsh-plugin-.*\.tgz$/)
    spec = join(temporary, tarball)
  }
  const smoke = await run('node', [join(packageRoot, 'scripts', 'profile-smoke.mjs')], {
    cwd: temporary,
    env: { ...process.env, BIZAGENT_PLUGIN_ADD_SPEC: spec },
    maxBuffer: 1024 * 1024,
  })
  process.stdout.write(smoke.stdout)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
