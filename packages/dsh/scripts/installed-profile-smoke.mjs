import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const run = promisify(execFile)
const temporary = await mkdtemp(join(tmpdir(), 'bizagent-installed-profile-'))

try {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(join(packageRoot, 'package-lock.json'), 'utf8'))
  const packed = await run('npm', ['pack', '--silent', '--offline', '--pack-destination', temporary], {
    cwd: packageRoot, env: { ...process.env, npm_config_cache: join(temporary, 'pack-cache') },
  })
  const tarball = packed.stdout.trim()
  assert.match(tarball, /^bizagent-dsh-.*\.tgz$/)
  const consumer = join(temporary, 'consumer')
  await mkdir(consumer)
  const dependencies = { '@bizagent/dsh': `file:../${tarball}` }
  for (const name of Object.keys(manifest.peerDependencies)) {
    const version = lock.packages[`node_modules/${name}`]?.version
    assert.ok(version, `missing locked DSH peer: ${name}`)
    dependencies[name] = version
  }
  // Match the tested host graph; upstream optional plugin ranges also admit newer, incompatible releases.
  const overrides = {}
  for (const name of ['@deepseek-ai/cordis-plugin-include', '@deepseek-ai/cordis-plugin-loader',
    '@deepseek-ai/schemastery', '@deepseek-ai/cosmokit']) {
    const version = lock.packages[`node_modules/${name}`]?.version
    assert.ok(version, `missing locked host dependency: ${name}`)
    overrides[name] = version
  }
  const host = { name: 'bizagent-install-smoke-host', version: '1.0.0', private: true,
    dependencies, overrides }
  await writeFile(join(consumer, 'package.json'), `${JSON.stringify(host, null, 2)}\n`)
  await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: consumer })
  const resolved = await run('node', ['-e', "import('@bizagent/dsh').then(m => { if (!m.BizAgentService) process.exit(2) })"],
    { cwd: consumer })
  assert.equal(resolved.stderr, '')
  if (process.argv.includes('--install-only')) {
    process.stdout.write('BizAgent tarball installed with locked DSH peers and loaded from an isolated consumer.\n')
  } else {
    const smoke = await run('node', [join(packageRoot, 'scripts', 'profile-smoke.mjs')], {
      cwd: consumer, env: { ...process.env, BIZAGENT_INSTALLED_CONSUMER: consumer },
      maxBuffer: 1024 * 1024,
    })
    process.stdout.write(smoke.stdout)
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
