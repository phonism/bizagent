import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { makeTempDir } from './temp-dir.mjs'

const execFileAsync = promisify(execFile)

test('CLI initializes and diagnoses a Home root', async (t) => {
  const root = await makeTempDir('bizagent-cli-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const cli = new URL('../lib/cli.js', import.meta.url)
  const initialized = await execFileAsync(process.execPath, [cli.pathname, '--root', root, 'init', '--default-home', 'personal:alice'])
  const initResult = JSON.parse(initialized.stdout)
  assert.equal(initResult.home.address, 'personal:alice')

  await execFileAsync(process.execPath, [cli.pathname, '--root', root, 'home', 'create', 'role:growth-strategy'])
  const listed = await execFileAsync(process.execPath, [cli.pathname, '--root', root, 'home', 'list'])
  assert.equal(JSON.parse(listed.stdout).homes.length, 2)

  const diagnosed = await execFileAsync(process.execPath, [cli.pathname, '--root', root, 'doctor'])
  assert.equal(JSON.parse(diagnosed.stdout).ok, true)
})
