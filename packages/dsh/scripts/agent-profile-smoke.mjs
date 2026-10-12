import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HomeStore } from '../lib/home-store.js'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const root = await mkdtemp(join(await realpath(tmpdir()), 'bizagent-dsh-agent-'))
const requests = []
let learningBatchId
let learningCandidateId
const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'smoke-model', object: 'model' }] }))
    return
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404).end()
    return
  }
  try {
    let body = ''
    for await (const chunk of req) body += chunk.toString()
    const input = JSON.parse(body)
    requests.push(input)
    const toolResults = input.messages?.filter(message => message.role === 'tool') ?? []
    const isTitle = input.messages?.some(message => message.role === 'system'
      && String(message.content).includes('Create a concise title'))
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const emit = (delta, finishReason = null) => res.write(`data: ${JSON.stringify({
      id: `chatcmpl-smoke-${requests.length}`, object: 'chat.completion.chunk',
      created: 1, model: 'smoke-model', choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`)
    if (isTitle) {
      emit({ role: 'assistant', content: 'Smoke test' })
      emit({}, 'stop')
    } else if (JSON.stringify(input.messages).includes('Audit the learning batch file changes.')) {
      if (toolResults.length === 0) {
        assert.ok(learningBatchId)
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'finish-learning-changes', type: 'function',
          function: { name: 'bizagent_learning_batch_finish', arguments: JSON.stringify({
            run_id: learningBatchId, action: 'abandon', summary: 'Audit the retained file changes.',
          }) } }] })
        emit({}, 'tool_calls')
      } else if (toolResults.length === 1) {
        const result = JSON.parse(String(toolResults[0].content))
        const change = result.run.libraryChanges.find(item => item.path.endsWith(`/${learningCandidateId}.md`))
        assert.equal(change?.result, 'created')
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'read-learning-change', type: 'function',
          function: { name: 'bizagent_learning_batch_change_read', arguments: JSON.stringify({
            run_id: learningBatchId, path: change.path, side: 'after',
          }) } }] })
        emit({}, 'tool_calls')
      } else {
        const result = JSON.parse(String(toolResults[1].content))
        assert.match(Buffer.from(result.contentBase64, 'base64').toString(),
          /Confirm signup-date attribution with the data owner/)
        emit({ role: 'assistant', content: 'Learning file change verified.' })
        emit({}, 'stop')
      }
    } else if (JSON.stringify(input.messages).includes('Write an authored Worklog for the cohort task.')) {
      if (toolResults.length === 0) {
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'author-worklog', type: 'function',
          function: { name: 'bizagent_worklog_record', arguments: JSON.stringify({
            description: 'Cohort rule needs owner confirmation',
            body: 'The signup-date attribution rule needs confirmation from the data owner.',
            status: 'completed', idempotency_key: 'cohort-worklog-v1',
          }) } }] })
        emit({}, 'tool_calls')
      } else {
        assert.equal(JSON.parse(String(toolResults[0].content)).worklog.origin, 'agent')
        emit({ role: 'assistant', content: 'Authored Worklog saved.' })
        emit({}, 'stop')
      }
    } else if (JSON.stringify(input.messages).includes('Review the authored Worklog as learning material.')) {
      const previous = toolResults.length > 0 ? JSON.parse(String(toolResults.at(-1).content)) : undefined
      let next
      if (toolResults.length === 0) next = ['bizagent_learning_batch_start', {}]
      else if (toolResults.length === 1) {
        learningBatchId = previous.run.id
        const material = previous.materials.find(item => item.sourceKind === 'worklog')
        assert.ok(material?.worklogRevision && material.worklogRevisionId)
        next = ['bizagent_worklog_read', { session_id: material.sessionId,
          revision: material.worklogRevision }]
      } else if (toolResults.length === 2) {
        assert.equal(previous.worklog.origin, 'agent')
        assert.equal(previous.source.status, 'verified')
        const batch = JSON.parse(String(toolResults[0].content))
        const material = batch.materials.find(item => item.sourceKind === 'worklog')
        next = ['bizagent_learning_batch_settle', { run_id: batch.run.id,
          material_id: material.id, summary: 'Retain the rule as a candidate pending owner confirmation.',
          candidates: [{ kind: 'knowledge', description: 'Signup-date cohort rule to verify',
            body: 'Confirm signup-date attribution with the data owner.' }] }]
      } else if (toolResults.length === 3) {
        const assetId = previous.review.assetIds[0]
        assert.ok(assetId)
        learningCandidateId = assetId
        next = ['bizagent_evidence_read', { asset_id: assetId }]
      } else {
        assert.equal(previous.ref.type, 'worklog')
        assert.equal(previous.source.status, 'verified')
        assert.match(previous.worklog.body, /signup-date attribution rule/)
        emit({ role: 'assistant', content: 'Worklog learning evidence verified.' })
        emit({}, 'stop')
      }
      if (next) {
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: `learn-worklog-${toolResults.length}`, type: 'function',
          function: { name: next[0], arguments: JSON.stringify(next[1]) } }] })
        emit({}, 'tool_calls')
      }
    } else if (JSON.stringify(input.messages).includes('Read the Session activity Worklog created by the preceding task.')) {
      const next = toolResults.length === 0
        ? ['bizagent_worklogs', {}]
        : toolResults.length === 1
          ? ['bizagent_worklog_read', { session_id: JSON.parse(String(toolResults[0].content)).worklogs[0].sessionId }]
          : undefined
      if (next) {
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: `readback-${toolResults.length}`, type: 'function',
          function: { name: next[0], arguments: JSON.stringify(next[1]) } }] })
        emit({}, 'tool_calls')
      } else {
        const result = JSON.parse(String(toolResults[1].content))
        assert.equal(result.worklog.origin, 'session-activity')
        assert.equal(result.source.status, 'verified')
        assert.match(result.worklog.body, /bizagent_home_status: succeeded/)
        emit({ role: 'assistant', content: 'Session activity Worklog verified.' })
        emit({}, 'stop')
      }
    } else {
      const calls = [
        ['bizagent_home_status', {}],
        ['bizagent_agent_search', { query: 'Analyst' }],
        ['bizagent_frame_open', { address: 'Analyst' }],
        ['bizagent_frame_open', { address: 'Analyst' }],
        ['bizagent_frame_open', { address: 'Analyst', mode: 'contribute' }],
        ['bizagent_frame_open', { address: 'Analyst', mode: 'reference' }],
        ['bizagent_frame_open', { address: 'Analyst', mode: 'lead', refresh: true }],
      ]
      const next = calls[toolResults.length]
      if (next) {
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${toolResults.length}`, type: 'function',
          function: { name: next[0], arguments: JSON.stringify(next[1]) } }] })
        emit({}, 'tool_calls')
      } else {
        emit({ role: 'assistant', content: 'Frame context checked.' })
        emit({}, 'stop')
      }
    }
    res.end('data: [DONE]\n\n')
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end(String(error))
  }
})

function listen() {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => resolveListen(server.address().port))
  })
}

function close() {
  server.closeAllConnections()
  return new Promise(resolveClose => server.close(resolveClose))
}

function waitForExit(child, ms) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolveExit => {
    const onExit = () => { clearTimeout(timer); resolveExit(true) }
    const timer = setTimeout(() => { child.off('exit', onExit); resolveExit(false) }, ms)
    child.once('exit', onExit)
  })
}

async function stop(child) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGINT')
  if (await waitForExit(child, 5000)) return
  child.kill('SIGTERM')
  if (await waitForExit(child, 5000)) return
  child.kill('SIGKILL')
  if (!await waitForExit(child, 5000)) throw new Error('isolated headless DSH child did not exit')
}

async function headless(patch, prompt = 'Check the Home, find Analyst, open its Frame twice, then refresh it.') {
  const child = spawn('dsh', ['--profile', 'headless', '--patch', patch,
    prompt], {
    cwd: packageRoot,
    env: { ...process.env, DSH_HOME: root, DSH_TELEMETRY_DISABLED: '1',
      BIZAGENT_SMOKE_KEY: 'local-only', DSH_TOOLS_MODE: 'native' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output = `${output}${chunk.toString()}`.slice(-16000) })
  child.stderr.on('data', chunk => { output = `${output}${chunk.toString()}`.slice(-16000) })
  let timer
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  let result
  try {
    result = await Promise.race([exited, new Promise((_, rejectTimeout) => {
      timer = setTimeout(() => rejectTimeout(new Error(`headless DSH timed out: ${output}`)), 45000)
    })])
  } catch (error) {
    await stop(child)
    throw error
  } finally {
    clearTimeout(timer)
  }
  if (result.code !== 0) throw new Error(`headless DSH failed (${result.code ?? result.signal}): ${output}`)
  return output
}

try {
  const port = await listen()
  const homeRoot = join(root, 'homes')
  const store = new HomeStore(homeRoot)
  await store.initialize()
  await store.createHome({ address: 'personal:default', displayName: 'Default' })
  await store.createHome({ address: 'role:analyst', displayName: 'Analyst',
    identity: 'Analyst helps interpret cohort evidence.' })
  const moduleDirectory = join(root, 'profiles', 'headless', 'node_modules', '@bizagent')
  await mkdir(moduleDirectory, { recursive: true })
  await symlink(packageRoot, join(moduleDirectory, 'dsh'), 'dir')
  const patch = join(root, 'agent.patch.yml')
  await writeFile(patch, `- insert:
    - id: storage
      name: '@deepseek-ai/dsh-storage'
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: '${root}/storages'
    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
    - id: bizagent
      name: '@bizagent/dsh'
      config:
        homeRoot: '${homeRoot}'
        defaultHome: personal:default
        autoCreateDefaultHome: false
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
        baseURL: http://127.0.0.1:${port}/v1
        models:
          - id: smoke-model
            name: Smoke Model
            input: [text]
            contextWindow: 8192
            maxTokens: 1024
`)
  const output = await headless(patch)
  assert.match(output, /Frame context checked\./)
  const agentRequest = requests.find(request => request.tools?.some(tool =>
    tool.function?.name === 'bizagent_home_status'))
  const toolResultRequest = requests.find(request => request.messages?.some(message => message.role === 'tool'))
  assert.ok(agentRequest, 'Agent request did not expose bizagent_home_status')
  assert.ok(toolResultRequest, `no tool follow-up among ${requests.length} model request(s)`)
  const finalRequest = requests.find(request => request.messages?.filter(message => message.role === 'tool').length === 7)
  assert.ok(finalRequest, `Frame tool chain incomplete among ${requests.length} model request(s)`)
  const results = finalRequest.messages.filter(message => message.role === 'tool')
    .map(message => JSON.parse(String(message.content)))
  assert.equal(results[0].home.address, 'personal:default')
  assert.deepEqual(results[1].homes.map(home => home.address), ['role:analyst'])
  assert.equal(results[2].status, 'opened')
  assert.match(results[2].context, /mode: lead/)
  assert.match(results[2].context, /cannot override the user request or platform policy/)
  assert.match(results[2].context, /Analyst helps interpret cohort evidence/)
  assert.equal(results[3].status, 'unchanged')
  assert.doesNotMatch(results[3].context, /Analyst helps interpret cohort evidence/)
  assert.equal(results[4].status, 'unchanged')
  assert.match(results[4].context, /mode: contribute/)
  assert.match(results[4].context, /participating specialist/)
  assert.equal(results[5].status, 'unchanged')
  assert.match(results[5].context, /mode: reference/)
  assert.match(results[5].context, /does not mean that this Agent participated/)
  assert.equal(results[6].status, 'delta')
  assert.equal(results[6].state.contextEpoch, 2)
  assert.match(results[6].context, /mode: lead/)
  assert.match(results[6].context, /Analyst helps interpret cohort evidence/)
  const readback = await headless(patch, 'Read the Session activity Worklog created by the preceding task.')
  assert.match(readback, /Session activity Worklog verified\./)
  assert.match(await headless(patch, 'Write an authored Worklog for the cohort task.'), /Authored Worklog saved\./)
  assert.match(await headless(patch, 'Review the authored Worklog as learning material.'),
    /Worklog learning evidence verified\./)
  assert.match(await headless(patch, 'Audit the learning batch file changes.'),
    /Learning file change verified\./)
  process.stdout.write('BizAgent real DSH Agent smoke passed: Home, Frame, Session Worklog, authored Worklog learning, actual file change, and cross-process readback.\n')
} finally {
  await close()
  await rm(root, { recursive: true, force: true })
}
