import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

test('published package declares an installable DSH bundle', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.name, '@bizagent/dsh')
  assert.equal(manifest.version, '0.1.0-alpha.2')
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '~4.0.4')
  assert.equal(manifest.dependencies['@deepseek-ai/schemastery'], '3.18.4')
  assert.equal(manifest.dependencies.yaml, '2.9.0')
  assert.equal(manifest.dependencies.zod, '4.5.2')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-session-query'], '^0.2.0-rc.2')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-conversation'], '^0.2.0-rc.2')
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(range, '^0.2.0-rc.2', name)
  }
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
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
  assert.match(client, /^window\.__ModuleLoader__\.load\(\{/)
  assert.match(client, /id: "@bizagent\/dsh"/)
  assert.match(client, /sidebar\.footer\.action/)
  assert.match(client, /shell\.overlay/)
  assert.match(client, /bizagent-agent/)
  assert.match(client, /conversation\.input\.dock/)
  assert.match(client, /First-time setup/)
  assert.match(client, /createOrganization/)
  // Check module specifiers, not CSS selectors such as .ba-business-node:hover.
  assert.doesNotMatch(client, /\b(?:require|import)\s*\(\s*['"]node:/)
  assert.doesNotMatch(client, /\.\/service\.js/)

  let registration
  vm.runInNewContext(client, {
    URLSearchParams,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({
      kind: 'principal', homeAddress: 'personal:alice', logicalAddress: 'personal:alice',
      sessionId: 'session-principal', workspacePath: '/tmp/alice',
    }) }),
    window: {
      location: { search: '' },
      __ModuleLoader__: {
        load(value) { registration = value },
      },
    },
  })
  assert.equal(registration?.id, '@bizagent/dsh')
  assert.equal(typeof registration?.factory, 'function')
  const clientExports = registration.factory((id) => {
    assert.ok(!id.startsWith('node:'), `browser bundle imports Node builtin: ${id}`)
    return {}
  })
  assert.equal(clientExports.name, 'bizagent-ui')
  assert.equal(typeof clientExports.apply, 'function')
  assert.deepEqual([...clientExports.inject], ['slots', 'locale', 'inputTriggers', 'sessions', 'workspaces', 'uiWorkspace'])
  const entries = []
  const calls = []
  clientExports.apply({
    effect() {},
    slots: {
      inject(_slot, install) { install() },
      register(entry) { entries.push(entry) },
    },
    workspaces: {
      async create({ path }) { calls.push(['create', path]); return { workspaceId: 'workspace-alice' } },
      async insertSessionBefore(workspaceId, sessionId) { calls.push(['insert', workspaceId, sessionId]) },
    },
    sessions: { async refresh() { calls.push(['refresh']) } },
    uiWorkspace: { openSession(id) { calls.push(['open', id]) } },
  })
  const dashboard = entries.find(entry => entry.name === 'shell.overlay')
  assert.ok(dashboard)
  await dashboard.inject().openAgentSession({ homeAddress: 'personal:alice' })
  assert.deepEqual(calls, [['create', '/tmp/alice'],
    ['insert', 'workspace-alice', 'session-principal'], ['refresh'], ['open', 'session-principal']])
})
