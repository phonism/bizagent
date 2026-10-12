import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { HomeStore } from '../lib/home-store.js'
import { principalSessionId, projectMainSessionId } from '../lib/agent-session-address.js'
import { safeHomeId, stableId } from '../lib/domain.js'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const root = await mkdtemp(join(await realpath(tmpdir()), 'bizagent-dsh-profile-'))
const packed = process.argv.includes('--packed')
const installedConsumer = process.env.BIZAGENT_INSTALLED_CONSUMER
const pluginAddTarball = process.env.BIZAGENT_PLUGIN_ADD_TARBALL
const localHuman = process.env.BIZAGENT_PROFILE_SMOKE_HUMAN === '1'
const humanToken = localHuman ? randomBytes(32).toString('hex') : undefined
const humanProjectId = stableId('project', 'personal:default:profile-main')
const humanWorkId = stableId('work', 'personal:default:profile-work')
const humanInboxId = stableId('inbox', 'personal:default:profile-inbox')
const lineKnowledgeProposalId = stableId('proposal', 'profile-SMOKE_PROPOSE_LINE_KNOWLEDGE')
const commonKnowledgeProposalId = stableId('proposal', 'profile-SMOKE_PROPOSE_COMMON_KNOWLEDGE')
const modelStages = new Map()
let modelServer
let modelPort
const runtimeCwd = installedConsumer ? resolve(installedConsumer) : pluginAddTarball ? root : packageRoot
const run = promisify(execFile)
let patch = join(installedConsumer ? join(runtimeCwd, 'node_modules', '@bizagent', 'dsh') : packageRoot,
  'cordis.patch.yml')
let active

async function installPackedContent(moduleDirectory) {
  const { stdout } = await run('npm', ['pack', '--json', '--offline', '--pack-destination', root], {
    cwd: runtimeCwd,
    env: { ...process.env, npm_config_cache: join(root, 'npm-cache') },
  })
  const [manifest] = JSON.parse(stdout)
  assert.equal(manifest.name, '@bizagent/dsh')
  for (const path of ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js']) {
    assert.ok(manifest.files.some(file => file.path === path), `tarball missing ${path}`)
  }
  const destination = join(moduleDirectory, 'dsh')
  await mkdir(destination)
  await run('tar', ['-xzf', join(root, manifest.filename), '-C', destination, '--strip-components=1'])
  await symlink(join(packageRoot, 'node_modules'), join(destination, 'node_modules'), 'dir')
  patch = join(destination, 'cordis.patch.yml')
}

function launch() {
  const child = spawn('dsh', ['--profile', 'web', ...(pluginAddTarball ? [] : ['--patch', patch]),
    '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: runtimeCwd,
    env: { ...process.env, DSH_HOME: root, DSH_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`DSH startup timed out: ${output}`)), 30000)
    const fail = error => { clearTimeout(timer); rejectReady(error) }
    child.once('error', fail)
    child.once('exit', (code, signal) => fail(new Error(
      `DSH exited before ready (${code ?? signal}): ${output}`)))
    const capture = chunk => {
      output = `${output}${chunk.toString()}`.slice(-16000)
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
      if (url) { clearTimeout(timer); resolveReady(url) }
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
  })
  return { child, ready }
}

async function verifySecondWriterBlocked() {
  const child = spawn('dsh', ['--profile', 'web', ...(pluginAddTarball ? [] : ['--patch', patch]),
    '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: runtimeCwd,
    env: { ...process.env, DSH_HOME: root, DSH_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output = `${output}${chunk.toString()}`.slice(-16000) })
  child.stderr.on('data', chunk => { output = `${output}${chunk.toString()}`.slice(-16000) })
  let timer
  try {
    const result = await Promise.race([
      new Promise((resolveExit, rejectExit) => {
        child.once('error', rejectExit)
        child.once('exit', (code, signal) => resolveExit({ code, signal }))
      }),
      new Promise((_, rejectTimeout) => {
        timer = setTimeout(() => rejectTimeout(new Error(
          `second DSH writer did not exit: ${output}`)), 15000)
      }),
    ])
    assert.notEqual(result.code, 0, `second DSH writer unexpectedly started: ${output}`)
    assert.match(output, /BizAgent writer is already reserved/)
  } finally {
    clearTimeout(timer)
    await stop(child)
  }
}

async function stop(child) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGINT')
  if (await waitForExit(child, 5000)) return
  child.kill('SIGTERM')
  if (await waitForExit(child, 5000)) return
  child.kill('SIGKILL')
  if (!await waitForExit(child, 5000)) throw new Error('isolated DSH smoke child did not exit')
}

function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolveExit => {
    const timer = setTimeout(() => resolveExit(false), ms)
    child.once('exit', () => { clearTimeout(timer); resolveExit(true) })
  })
}

async function json(base, path, init) {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(5000) })
  if (response.status !== 200) throw new Error(`${path}: ${response.status} ${await response.text()}`)
  return response.json()
}

async function rpc(base, method, payload) {
  const rpcId = randomUUID()
  const response = await json(base, `/api/${method}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }) })
  assert.equal(response.rpcId, rpcId)
  if (!response.result.ok) throw new Error(`${method}: ${JSON.stringify(response.result)}`)
  return response.result.value
}

async function until(check, description) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`timed out waiting for ${description}`)
}

async function prompt(base, sessionId, marker) {
  assert.equal((await rpc(base, 'session.prompt', { sessionId, mode: 'queue',
    content: [{ type: 'text', text: marker }] })).accepted, true)
  await until(() => (modelStages.get(marker) ?? 0) >= 2, `${marker} model turn`)
}

async function assertToolSucceededContaining(base, sessionId, needle, minimum = 1) {
  await until(async () => {
    const history = await rpc(base, 'session.history', { sessionId, maxMessages: 100 })
    return history.events.filter(item => item.event.type === 'tool/result'
      && item.event.data.error === undefined
      && JSON.stringify(item.event.data.message).includes(needle)).length >= minimum
  }, `successful tool result containing ${needle} in ${sessionId}`)
}

function assertProjectToolSucceeded(base, sessionId, minimum = 1) {
  return assertToolSucceededContaining(base, sessionId, humanProjectId, minimum)
}

async function startSmokeModel() {
  modelServer = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'smoke-model', object: 'model' }] }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
    try {
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      const input = JSON.parse(body)
      const messages = JSON.stringify(input.messages ?? [])
      const titleRequest = input.messages?.some(message => message.role === 'system'
        && String(message.content).includes('Create a concise title'))
      const markers = ['SMOKE_CREATE_PROJECT', 'SMOKE_READ_MAIN_AFTER_RESTART', 'SMOKE_READ_MAIN',
        'SMOKE_LINE_PRINCIPAL', 'SMOKE_BUSINESS_PRINCIPAL', 'SMOKE_ROLE_PRINCIPAL',
        'SMOKE_CAPABILITY_PRINCIPAL', 'SMOKE_FRAME', 'SMOKE_INVITE_SEAT', 'SMOKE_SEND_INBOX',
        'SMOKE_READ_INBOX', 'SMOKE_DISPATCH_WORK', 'SMOKE_SUBMIT_PROJECT',
        'SMOKE_REMEMBER_KNOWLEDGE', 'SMOKE_SEARCH_KNOWLEDGE',
        'SMOKE_PROPOSE_LINE_KNOWLEDGE', 'SMOKE_PROPOSE_COMMON_KNOWLEDGE',
        'SMOKE_SEARCH_SHARED_LINE', 'SMOKE_SEARCH_SHARED_COMMON']
      const marker = (titleRequest ? [] : markers).map(value => ({ value, index: messages.lastIndexOf(value) }))
        .filter(item => item.index >= 0)
        .sort((a, b) => b.index - a.index || b.value.length - a.value.length)[0]?.value
      const worker = !titleRequest && marker === undefined
        && messages.includes('Formal Work assigned to this Agent Home')
      const lastWorkerResult = worker ? input.messages?.filter(message => message.role === 'tool')
        .map(message => { try { return JSON.parse(String(message.content)) } catch { return undefined } })
        .filter(Boolean).at(-1) : undefined
      if (marker === 'SMOKE_CREATE_PROJECT' || marker?.endsWith('_PRINCIPAL')) {
        assert.match(messages, /unique long-term Principal/)
        assert.doesNotMatch(messages, /dedicated Project Main/)
      }
      if (marker === 'SMOKE_CREATE_PROJECT') {
        // Principal Sessions join the DSH agent preset, which loads the Home's AGENTS.md.
        assert.match(messages, /HOME_AGENTS_SENTINEL/)
      }
      if (marker?.startsWith('SMOKE_READ_MAIN')) {
        assert.match(messages, new RegExp(`dedicated Project Main for project:${humanProjectId}`))
      }
      const stageKey = worker ? 'SMOKE_WORKER' : marker
      const stage = stageKey === undefined ? 0 : (modelStages.get(stageKey) ?? 0)
      if (stageKey !== undefined) modelStages.set(stageKey, stage + 1)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const emit = (delta, finishReason = null) => res.write(`data: ${JSON.stringify({
        id: `chatcmpl-profile-${randomUUID()}`, object: 'chat.completion.chunk', created: 1,
        model: 'smoke-model', choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`)
      if (titleRequest) {
        emit({ role: 'assistant', content: 'Profile smoke' })
        emit({}, 'stop')
      } else if (marker === 'SMOKE_CREATE_PROJECT' && stage === 0) {
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'create-profile-main', type: 'function',
          function: { name: 'bizagent_project_create', arguments: JSON.stringify({
            title: 'Profile Main', goal: 'Verify a durable Project Main.',
            done_when: 'The Main reads the Project after restart.', idempotency_key: 'profile-main',
          }) } }] })
        emit({}, 'tool_calls')
      } else if (marker?.startsWith('SMOKE_READ_MAIN') && stage === 0) {
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: `read-profile-main-${marker}`, type: 'function',
          function: { name: 'bizagent_project_read',
            arguments: JSON.stringify({ project_id: humanProjectId }) } }] })
        emit({}, 'tool_calls')
      } else if (marker?.endsWith('_PRINCIPAL') && stage === 0) {
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: `home-status-${marker}`, type: 'function',
          function: { name: 'bizagent_home_status', arguments: '{}' } }] })
        emit({}, 'tool_calls')
      } else if (worker && lastWorkerResult?.work?.status !== 'accepted'
        && lastWorkerResult?.work?.status !== 'completed') {
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'accept-profile-work', type: 'function',
          function: { name: 'bizagent_work_accept',
            arguments: JSON.stringify({ work_id: humanWorkId }) } }] })
        emit({}, 'tool_calls')
      } else if (worker && lastWorkerResult?.work?.status === 'accepted') {
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'complete-profile-work', type: 'function',
          function: { name: 'bizagent_work_complete', arguments: JSON.stringify({ work_id: humanWorkId,
            subject: 'Evidence checked', body: 'The assigned Home verified the source evidence.' }) } }] })
        emit({}, 'tool_calls')
      } else if (marker !== undefined && stage === 0) {
        const operations = {
          SMOKE_FRAME: ['bizagent_frame_open', { address: 'role:smoke', mode: 'contribute' }],
          SMOKE_INVITE_SEAT: ['bizagent_project_invite', { project_id: humanProjectId,
            home_address: 'role:smoke', responsibility: 'Check source evidence.' }],
          SMOKE_SEND_INBOX: ['bizagent_inbox_send', { project_id: humanProjectId,
            to: ['role:smoke'], subject: 'Check evidence', body: 'Read the Project and check the source.',
            priority: 'urgent', idempotency_key: 'profile-inbox' }],
          SMOKE_READ_INBOX: ['bizagent_inbox_read', { message_id: humanInboxId }],
          SMOKE_DISPATCH_WORK: ['bizagent_work_dispatch', { to_address: 'role:smoke',
            goal: 'Verify the Project source evidence.', acceptance_criteria: 'Return a clear finding.',
            idempotency_key: 'profile-work', project_id: humanProjectId }],
          SMOKE_SUBMIT_PROJECT: ['bizagent_project_submit', { project_id: humanProjectId,
            summary: 'Evidence verified', body: 'The assigned Home returned a formal finding.',
            done_when_assessment: 'The formal Work result meets the Project completion standard.' }],
          SMOKE_REMEMBER_KNOWLEDGE: ['bizagent_memory_remember', { kind: 'knowledge',
            description: 'Verify project source evidence before an outcome claim.',
            body: 'Ask the assigned Home to check source evidence, then submit the formal result for human acceptance.' }],
          SMOKE_SEARCH_KNOWLEDGE: ['bizagent_memory_search', { query: 'project source evidence' }],
          SMOKE_PROPOSE_LINE_KNOWLEDGE: ['bizagent_knowledge_propose', { scope: 'line', line: 'smoke',
            description: 'Line source verification rule', body: 'The smoke product line verifies every source.' }],
          SMOKE_PROPOSE_COMMON_KNOWLEDGE: ['bizagent_knowledge_propose', { scope: 'common',
            description: 'Platform source verification rule', body: 'Every product line verifies its source.' }],
          SMOKE_SEARCH_SHARED_LINE: ['bizagent_knowledge_search', { query: 'Line source verification' }],
          SMOKE_SEARCH_SHARED_COMMON: ['bizagent_knowledge_search', { query: 'Platform source verification' }],
        }
        const [name, args] = operations[marker] ?? []
        if (!name) throw new Error(`unknown profile marker: ${marker}`)
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: `profile-${marker}`, type: 'function',
          function: { name, arguments: JSON.stringify(args) } }] })
        emit({}, 'tool_calls')
      } else {
        emit({ role: 'assistant', content: marker === undefined ? 'Profile smoke.' : `${marker} complete.` })
        emit({}, 'stop')
      }
      res.end('data: [DONE]\n\n')
    } catch (error) { res.writeHead(500).end(String(error)) }
  })
  modelPort = await new Promise((resolveListen, rejectListen) => {
    modelServer.once('error', rejectListen)
    modelServer.listen(0, '127.0.0.1', () => resolveListen(modelServer.address().port))
  })
}

try {
  if (humanToken) {
    await startSmokeModel()
    process.env.BIZAGENT_SMOKE_KEY = 'local-only'
    const tokenFile = join(root, 'human.token')
    await writeFile(tokenFile, `${humanToken}\n`, { mode: 0o600 })
    process.env.BIZAGENT_LOCAL_HUMAN_ID = 'smoke-owner'
    process.env.BIZAGENT_LOCAL_HUMAN_TOKEN_FILE = tokenFile
    process.env.BIZAGENT_LOCAL_PLATFORM_ADMIN = '1'
    const homes = new HomeStore(join(root, 'bizagent'))
    await homes.initialize()
    await homes.createHome({ address: 'personal:default', owner: 'smoke-owner' })
    for (const address of ['line:smoke', 'business:smoke', 'role:smoke', 'capability:smoke']) {
      await homes.createHome({ address, owner: 'smoke-owner' })
    }
    await writeFile(join(homes.homeWorkspacePath('personal:default'), 'AGENTS.md'),
      'HOME_AGENTS_SENTINEL: project work instructions.\n')
  }
  const moduleDirectory = join(root, 'profiles', 'web', 'node_modules', '@bizagent')
  await mkdir(moduleDirectory, { recursive: true })
  if (pluginAddTarball) {
    const args = ['plugin', '--profile', 'web', 'add', resolve(pluginAddTarball)]
    if (process.env.npm_config_offline === 'true') args.push('--offline')
    const installOptions = { cwd: runtimeCwd,
      env: { ...process.env, DSH_HOME: root,
        PATH: `${join(packageRoot, 'node_modules', '.bin')}:${process.env.PATH ?? ''}` } }
    await run('dsh', args, installOptions)
    const profile = JSON.parse(await readFile(join(root, 'profiles', 'web', 'package.json'), 'utf8'))
    assert.ok(profile.dsh?.profile?.bundles.includes('@bizagent/dsh'))
    patch = join(moduleDirectory, 'dsh', 'cordis.patch.yml')
  } else if (installedConsumer) await symlink(join(runtimeCwd, 'node_modules', '@bizagent', 'dsh'),
    join(moduleDirectory, 'dsh'), 'dir')
  else if (packed) await installPackedContent(moduleDirectory)
  else await symlink(packageRoot, join(moduleDirectory, 'dsh'), 'dir')
  if (!pluginAddTarball) {
    const configuredPatch = join(root, 'bizagent-smoke.patch.yml')
    const sourcePatch = await readFile(patch, 'utf8')
    assert.match(sourcePatch, /indexMaxBytes: 16384/)
    const configured = sourcePatch.replace('indexMaxBytes: 16384', `indexMaxBytes: 16384
        learningSchedulerEnabled: true
        workspaceHomes:
          '${runtimeCwd}': personal:default
${modelPort === undefined ? '' : `          '${join(root, 'bizagent', 'homes', safeHomeId('role:smoke'))}': role:smoke\n`}
        learningSchedules:
          - home: personal:default
            cron: '0 3 1 1 *'
            model: unused-smoke-model
            dailyRuns: 2`)
    await writeFile(configuredPatch, configured + (modelPort === undefined ? '' : `
- id: agent-default-model
  config:
    provider: local-smoke
    model: smoke-model
- id: llm-pi-ai
  config:
    providers:
      local-smoke:
        displayName: Local Smoke
        apiKeyEnv: BIZAGENT_SMOKE_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:${modelPort}/v1
        models:
          - id: smoke-model
            name: Smoke Model
            input: [text]
            contextWindow: 65536
            maxTokens: 1024
`))
    patch = configuredPatch
  }

  active = launch()
  let base = await active.ready
  await verifySecondWriterBlocked()
  const overview = await json(base, '/api/bizagent/v1/overview')
  assert.equal(overview.health.ok, true)
  assert.deepEqual(overview.homes.map(home => home.address), humanToken
    ? ['business:smoke', 'capability:smoke', 'line:smoke', 'personal:default', 'role:smoke']
    : ['personal:default'])
  if (humanToken) {
    assert.equal((await fetch(`${base}/api/bizagent/local-human/status`)).status, 401)
    const humanStatus = await json(base, '/api/bizagent/local-human/status', {
      headers: { Authorization: `Bearer ${humanToken}` },
    })
    assert.equal(humanStatus.userId, 'smoke-owner')
    assert.equal((await fetch(`${base}/api/bizagent/human-inbox`)).status, 401)
    assert.equal((await fetch(`${base}/api/bizagent/human-inbox`, {
      headers: { Authorization: `Bearer ${humanToken}` },
    })).status, 200)
    const principal = await json(base, '/api/bizagent/agent-session', {
      method: 'POST', headers: { Authorization: `Bearer ${humanToken}`, Origin: base,
        'Content-Type': 'application/json' },
      body: JSON.stringify({ homeAddress: 'personal:default' }),
    })
    assert.equal(principal.sessionId, principalSessionId('personal:default'))
    assert.equal(principal.homeAddress, 'personal:default')
    assert.equal(principal.workspacePath, join(root, 'bizagent', 'homes',
      safeHomeId('personal:default')))
    for (const address of ['line:smoke', 'business:smoke', 'role:smoke', 'capability:smoke']) {
      const homePrincipal = await json(base, '/api/bizagent/agent-session', {
        method: 'POST', headers: { Authorization: `Bearer ${humanToken}`, Origin: base,
          'Content-Type': 'application/json' },
        body: JSON.stringify({ homeAddress: address }),
      })
      assert.equal(homePrincipal.sessionId, principalSessionId(address))
      assert.notEqual(homePrincipal.sessionId, principal.sessionId)
      await prompt(base, homePrincipal.sessionId, `SMOKE_${address.split(':')[0].toUpperCase()}_PRINCIPAL`)
      await until(async () => {
        const history = await rpc(base, 'session.history', { sessionId: homePrincipal.sessionId,
          maxMessages: 100 })
        return history.events.some(item => item.event.type === 'tool/result'
          && item.event.data.error === undefined
          && JSON.stringify(item.event.data.message).includes(address))
      }, `${address} Principal Home status`)
    }
    if (modelPort !== undefined) {
      await prompt(base, principal.sessionId, 'SMOKE_CREATE_PROJECT')
      await assertProjectToolSucceeded(base, principal.sessionId)
      await until(async () => {
        const projects = await json(base,
          `/api/bizagent/v1/projects?sessionId=${encodeURIComponent(principal.sessionId)}`)
        return projects.projects.some(project => project.id === humanProjectId)
      }, 'Project created by Principal')
      const main = await json(base, '/api/bizagent/agent-session', {
        method: 'POST', headers: { Authorization: `Bearer ${humanToken}`, Origin: base,
          'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: humanProjectId }),
      })
      assert.equal(main.sessionId, projectMainSessionId(humanProjectId))
      assert.equal(main.homeAddress, 'personal:default')
      assert.notEqual(main.sessionId, principal.sessionId)
      await prompt(base, main.sessionId, 'SMOKE_READ_MAIN')
      await assertProjectToolSucceeded(base, main.sessionId)
      assert.equal((await json(base, `/api/bizagent/v1/projects/detail?sessionId=${encodeURIComponent(main.sessionId)}&projectId=${humanProjectId}`)).project.id,
        humanProjectId)
    }
  }
  if (!pluginAddTarball) {
    const learningSchedule = await json(base,
      '/api/bizagent/v1/learning/schedule?home=personal%3Adefault')
    assert.equal(learningSchedule.hostEnabled, true)
    assert.equal(learningSchedule.configured, true)
    assert.equal(learningSchedule.schedule.model, 'unused-smoke-model')
    const pausedLearning = await json(base, '/api/bizagent/v1/learning/schedule/configure', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ home: 'personal:default', expectedRevision: 0,
        enabled: false, cron: '0 2 1 1 *', dailyRuns: 1 }),
    })
    assert.equal(pausedLearning.policy.revision, 1)
    assert.equal(pausedLearning.policy.enabled, false)
  }
  const client = await fetch(`${base}/plugins/@bizagent/dsh/client.js`, { signal: AbortSignal.timeout(5000) })
  assert.equal(client.status, 200)
  assert.ok((await client.text()).length > 1000)
  const created = await json(base, '/api/bizagent/v1/homes', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: 'role:smoke-reviewer', displayName: 'Smoke Reviewer' }),
  })
  assert.equal(created.home?.address ?? created.address, 'role:smoke-reviewer')

  await stop(active.child)
  active = launch()
  base = await active.ready
  const restored = await json(base, '/api/bizagent/v1/overview')
  assert.equal(restored.health.ok, true)
  assert.equal(restored.homes.length, humanToken ? 6 : 2)
  if (humanToken) {
    assert.equal((await fetch(`${base}/api/bizagent/human-inbox`, {
      headers: { Authorization: `Bearer ${humanToken}` },
    })).status, 200)
    assert.equal((await json(base, '/api/bizagent/local-human/status', {
      headers: { Authorization: `Bearer ${humanToken}` },
    })).userId, 'smoke-owner')
    const principal = await json(base, '/api/bizagent/agent-session', {
      method: 'POST', headers: { Authorization: `Bearer ${humanToken}`, Origin: base,
        'Content-Type': 'application/json' },
      body: JSON.stringify({ homeAddress: 'personal:default' }),
    })
    assert.equal(principal.sessionId, principalSessionId('personal:default'))
    for (const address of ['line:smoke', 'business:smoke', 'role:smoke', 'capability:smoke']) {
      const homePrincipal = await json(base, '/api/bizagent/agent-session', {
        method: 'POST', headers: { Authorization: `Bearer ${humanToken}`, Origin: base,
          'Content-Type': 'application/json' },
        body: JSON.stringify({ homeAddress: address }),
      })
      assert.equal(homePrincipal.sessionId, principalSessionId(address))
    }
    if (modelPort !== undefined) {
      const main = await json(base, '/api/bizagent/agent-session', {
        method: 'POST', headers: { Authorization: `Bearer ${humanToken}`, Origin: base,
          'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: humanProjectId }),
      })
      assert.equal(main.sessionId, projectMainSessionId(humanProjectId))
      await prompt(base, main.sessionId, 'SMOKE_READ_MAIN_AFTER_RESTART')
      await assertProjectToolSucceeded(base, main.sessionId, 2)
      assert.equal((await json(base, `/api/bizagent/v1/projects/detail?sessionId=${encodeURIComponent(main.sessionId)}&projectId=${humanProjectId}`)).project.id,
        humanProjectId)
      await prompt(base, main.sessionId, 'SMOKE_FRAME')
      await assertToolSucceededContaining(base, main.sessionId, 'role:smoke')
      await prompt(base, main.sessionId, 'SMOKE_INVITE_SEAT')
      await assertProjectToolSucceeded(base, main.sessionId, 3)
      await prompt(base, main.sessionId, 'SMOKE_SEND_INBOX')
      await assertToolSucceededContaining(base, main.sessionId, humanInboxId)
      const roleSessionId = principalSessionId('role:smoke')
      await prompt(base, roleSessionId, 'SMOKE_READ_INBOX')
      await assertToolSucceededContaining(base, roleSessionId, humanInboxId)
      await prompt(base, main.sessionId, 'SMOKE_DISPATCH_WORK')
      await assertToolSucceededContaining(base, main.sessionId, humanWorkId)
      const workerSessionId = stableId('work-session', humanWorkId)
      try {
        await until(async () => {
          const detail = await json(base,
            `/api/bizagent/v1/projects/detail?sessionId=${encodeURIComponent(main.sessionId)}&projectId=${humanProjectId}`)
          return detail.work.some(work => work.id === humanWorkId && work.status === 'completed')
        }, 'formal Work completed by assigned Home')
      } catch (error) {
        const detail = await json(base,
          `/api/bizagent/v1/projects/detail?sessionId=${encodeURIComponent(main.sessionId)}&projectId=${humanProjectId}`)
        const history = await rpc(base, 'session.history', { sessionId: main.sessionId, maxMessages: 100 })
        const resultText = history.events.filter(item => item.event.type === 'tool/result').at(-1)
          ?.event.data.message.content?.[0]?.content?.[0]?.text
        const dispatch = resultText === undefined ? undefined : JSON.parse(resultText)
        const workerHistory = await rpc(base, 'session.history', { sessionId: workerSessionId,
          maxMessages: 100 })
        const workerResults = workerHistory.events.filter(item => item.event.type === 'tool/result')
          .map(item => ({ error: item.event.data.error,
            text: item.event.data.message.content?.[0]?.content?.[0]?.text?.slice(0, 900) }))
        const workerEvents = workerHistory.events.slice(-14).map(item => ({ type: item.event.type,
          data: JSON.stringify(item.event.data).slice(0, 300) }))
        const workerSummary = (await rpc(base, 'session.list', {})).items
          .find(item => item.sessionId === workerSessionId)
        throw new Error(`${error}; work=${JSON.stringify(detail.work)}; stages=${JSON.stringify([...modelStages])}; `
          + `workerLaunch=${JSON.stringify(dispatch?.workerLaunch)}; workerResults=${JSON.stringify(workerResults)}; `
          + `workerSummary=${JSON.stringify({ running: workerSummary?.running })}; workerEvents=${JSON.stringify(workerEvents).slice(0, 5000)}`)
      }
      await prompt(base, main.sessionId, 'SMOKE_SUBMIT_PROJECT')
      await assertProjectToolSucceeded(base, main.sessionId, 4)
      const review = await json(base,
        `/api/bizagent/project-review?projectId=${humanProjectId}`, {
          headers: { Authorization: `Bearer ${humanToken}` },
        })
      assert.equal(review.canReview, true)
      const decision = await json(base, '/api/bizagent/project-review', {
        method: 'POST', headers: { Authorization: `Bearer ${humanToken}`, Origin: base,
          'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: humanProjectId, claimId: review.claimId,
          expectedRevision: review.revision, decision: 'accept',
          reason: 'The formal Work result satisfies the completion standard.' }),
      })
      assert.equal(decision.project.status, 'accepted')
      await prompt(base, main.sessionId, 'SMOKE_REMEMBER_KNOWLEDGE')
      await assertToolSucceededContaining(base, main.sessionId,
        'Verify project source evidence before an outcome claim.')
      const lineSessionId = principalSessionId('line:smoke')
      await prompt(base, lineSessionId, 'SMOKE_PROPOSE_LINE_KNOWLEDGE')
      await assertToolSucceededContaining(base, lineSessionId, lineKnowledgeProposalId)
      await prompt(base, principalSessionId('personal:default'), 'SMOKE_PROPOSE_COMMON_KNOWLEDGE')
      await assertToolSucceededContaining(base, principalSessionId('personal:default'), commonKnowledgeProposalId)
      const sharedBeforeReview = await json(base, '/api/bizagent/shared-knowledge/decision', {
        headers: { Authorization: `Bearer ${humanToken}` },
      })
      assert.ok(sharedBeforeReview.proposals.some(item => item.proposal.id === lineKnowledgeProposalId))
      assert.ok(sharedBeforeReview.proposals.some(item => item.proposal.id === commonKnowledgeProposalId))
      for (const proposalId of [lineKnowledgeProposalId, commonKnowledgeProposalId]) {
        const approved = await json(base, '/api/bizagent/shared-knowledge/decision', {
          method: 'POST', headers: { Authorization: `Bearer ${humanToken}`, Origin: base,
            'Content-Type': 'application/json' },
          body: JSON.stringify({ proposalId, action: 'accept', decision: 'The shared rule is verified.' }),
        })
        assert.equal(approved.proposal.status, 'accepted')
      }
    }
  }
  if (!pluginAddTarball) {
    const restoredLearning = await json(base,
      '/api/bizagent/v1/learning/schedule?home=personal%3Adefault')
    assert.equal(restoredLearning.policy.revision, 1)
    assert.equal(restoredLearning.policy.enabled, false)
    assert.equal(restoredLearning.schedule.cron, '0 2 1 1 *')
  }
  const home = await json(base, '/api/bizagent/v1/home?address=role%3Asmoke-reviewer')
  assert.equal(home.home?.address ?? home.address, 'role:smoke-reviewer')

  const crashed = active.child
  assert.equal(crashed.kill('SIGKILL'), true)
  assert.equal(await waitForExit(crashed, 5000), true)
  const stale = JSON.parse(await readFile(join(root, '.bizagent-writer.lock'), 'utf8'))
  assert.equal(stale.pid, crashed.pid)
  active = launch()
  base = await active.ready
  const recovered = await json(base, '/api/bizagent/v1/overview')
  assert.equal(recovered.health.ok, true)
  assert.equal(recovered.homes.length, humanToken ? 6 : 2)
  if (humanToken) {
    assert.equal((await fetch(`${base}/api/bizagent/human-inbox`, {
      headers: { Authorization: `Bearer ${humanToken}` },
    })).status, 200)
    const principal = await json(base, '/api/bizagent/agent-session', {
      method: 'POST', headers: { Authorization: `Bearer ${humanToken}`, Origin: base,
        'Content-Type': 'application/json' },
      body: JSON.stringify({ homeAddress: 'personal:default' }),
    })
    assert.equal(principal.sessionId, principalSessionId('personal:default'))
    await prompt(base, principal.sessionId, 'SMOKE_SEARCH_KNOWLEDGE')
    await assertToolSucceededContaining(base, principal.sessionId,
      'Verify project source evidence before an outcome claim.')
    const detail = await json(base,
      `/api/bizagent/v1/projects/detail?sessionId=${encodeURIComponent(principal.sessionId)}&projectId=${humanProjectId}`)
    assert.equal(detail.project.status, 'accepted')
    await prompt(base, principal.sessionId, 'SMOKE_SEARCH_SHARED_COMMON')
    await assertToolSucceededContaining(base, principal.sessionId, 'Platform source verification rule')
    const lineSessionId = principalSessionId('line:smoke')
    await prompt(base, lineSessionId, 'SMOKE_SEARCH_SHARED_LINE')
    await assertToolSucceededContaining(base, lineSessionId, 'Line source verification rule')
  }
  if (!pluginAddTarball) assert.equal((await json(base,
    '/api/bizagent/v1/learning/schedule?home=personal%3Adefault')).policy.enabled, false)
  process.stdout.write(`BizAgent real DSH ${pluginAddTarball ? 'plugin-add ' : installedConsumer ? 'installed-package ' : packed ? 'packed-content ' : ''}profile smoke passed: UI, Home API, ${humanToken ? 'five Principal types, separate Project Main, Frame/Seat/Inbox, formal Work, Bearer human acceptance, Home and shared Knowledge retrieval after crash, ' : ''}${pluginAddTarball ? '' : 'learning policy persistence, '}restart, and crash recovery.\n`)
} finally {
  if (active) await stop(active.child)
  if (modelServer) {
    modelServer.closeAllConnections()
    await new Promise(resolveClose => modelServer.close(resolveClose))
  }
  await rm(root, { recursive: true, force: true })
}
