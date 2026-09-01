import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(realpathSync(tmpdir()), 'bizagent-dsh-smoke-'))
const cli = new URL('../lib/cli.js', import.meta.url)

function run(...args) {
  return JSON.parse(
    execFileSync(process.execPath, [cli.pathname, '--root', root, ...args], {
      encoding: 'utf8',
    }),
  )
}

try {
  const initialized = run('init', '--default-home', 'personal:alice')
  assert.equal(initialized.home.address, 'personal:alice')

  const created = run('home', 'create', 'role:growth-strategy')
  assert.equal(created.home.address, 'role:growth-strategy')

  const listed = run('home', 'list')
  assert.deepEqual(
    listed.homes.map((home) => home.address),
    ['personal:alice', 'role:growth-strategy'],
  )

  const doctor = run('doctor')
  assert.equal(doctor.ok, true)
  assert.equal(doctor.homeCount, 2)
  assert.deepEqual(doctor.issues, [])

  process.stdout.write(
    `BizAgent DSH smoke test passed: ${doctor.homeCount} Homes, doctor ok.\n`,
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
