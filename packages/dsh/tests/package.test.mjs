import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('published package declares an installable DSH bundle', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.name, '@bizagent/dsh')
  assert.equal(manifest.version, '0.1.0-alpha.2')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-session-query'], '^0.1.1-rc.2')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'].default, './lib/client.js')
  assert.equal(manifest.exports['./ui-host'].default, './lib/ui-host.js')
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: bizagent/)
  assert.match(patch, /name: '@bizagent\/dsh'/)
  assert.match(patch, /id: bizagent-ui/)
  assert.match(patch, /name: '@bizagent\/dsh\/ui-host'/)

  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /sidebar\.footer\.action/)
  assert.match(client, /shell\.overlay/)
  assert.doesNotMatch(client, /node:/)
  assert.doesNotMatch(client, /\.\/service\.js/)
})
