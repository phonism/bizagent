import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HomeStore } from '../lib/home-store.js'
import { stableId } from '../lib/domain.js'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const root = await mkdtemp(join(await realpath(tmpdir()), 'bizagent-dsh-work-'))
const requests = []
const workId = stableId('work', 'personal:default:smoke-work')
const assetId = 'smoke-worker-method'
let leadDispatched = false
let workerCompleted = false
let leadReadCount = 0
let workerResult = ''
let workerReceipt
let workerMemoryReceipt
let workerFeedbackReceipt
let useOutcomeReceipt
let workerLogReceipt
let workerLogDetailReceipt
const requesterReceipts = []
const requesterEvaluations = []
const requesterToolSummary = []

function call(name, args, id) {
  return { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
    function: { name, arguments: JSON.stringify(args) } }] }
}

async function waitForWorker() {
  const until = Date.now() + 20000
  while (!workerCompleted && Date.now() < until) await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
  if (!workerCompleted) throw new Error(`worker did not complete: ${workerResult.slice(0, 800)}`)
}

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
    const messages = input.messages ?? []
    const hasToolResult = messages.some(message => message.role === 'tool')
    const isTitle = input.messages?.some(message => message.role === 'system'
      && String(message.content).includes('Create a concise title'))
    const isWorker = JSON.stringify(messages).includes('Formal Work assigned to this Agent Home')
    const isWorklogCheck = JSON.stringify(messages).includes('Inspect the automatic Worklog for completed formal Work')
    const isUseAudit = JSON.stringify(messages).includes('Inspect memory use outcomes for the completed Work')
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const emit = (delta, finishReason = null) => res.write(`data: ${JSON.stringify({
      id: `chatcmpl-smoke-${requests.length}`, object: 'chat.completion.chunk',
      created: 1, model: 'smoke-model', choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`)
    if (isTitle) {
      emit({ role: 'assistant', content: 'Smoke test' })
      emit({}, 'stop')
    } else if (isWorklogCheck && hasToolResult) {
      const results = messages.filter(message => message.role === 'tool')
        .map(message => JSON.parse(String(message.content)))
      if (results.length === 1) {
        workerLogReceipt = results[0]
        const log = workerLogReceipt.worklogs?.find(item => item.workId === workId)
        if (!log) throw new Error(`automatic Worklog missing: ${JSON.stringify(workerLogReceipt)}`)
        emit(call('bizagent_worklog_read', { session_id: log.sessionId }, 'call-worklog-read'))
        emit({}, 'tool_calls')
      } else {
        workerLogDetailReceipt = results.at(-1)
        emit({ role: 'assistant', content: 'Automatic Worklog inspected.' })
        emit({}, 'stop')
      }
    } else if (isWorklogCheck) {
      emit(call('bizagent_worklogs', { limit: 20 }, 'call-worklogs'))
      emit({}, 'tool_calls')
    } else if (isUseAudit && hasToolResult) {
      useOutcomeReceipt = JSON.parse(String(messages.filter(message => message.role === 'tool').at(-1)?.content))
      emit({ role: 'assistant', content: 'Memory use inspected.' })
      emit({}, 'stop')
    } else if (isUseAudit) {
      emit(call('bizagent_memory_use_outcomes', { asset_id: assetId }, 'call-use-outcomes'))
      emit({}, 'tool_calls')
    } else if (isWorker && hasToolResult) {
      const content = messages.filter(message => message.role === 'tool').at(-1)?.content
      workerResult = String(content)
      const result = JSON.parse(content)
      if (result.asset?.id === assetId && result.receipt === undefined) {
        workerMemoryReceipt = result
        emit(call('bizagent_memory_feedback', { asset_id: assetId, signal: 'applied',
          outcome: 'Used the method before delivering Work.' }, 'call-memory-feedback'))
        emit({}, 'tool_calls')
      } else if (result.receipt?.signal === 'applied') {
        workerFeedbackReceipt = result
        emit(call('bizagent_work_complete', { work_id: workId,
          subject: 'Smoke work complete', body: 'Worker verified metric 7 using the method.' }, 'call-complete'))
        emit({}, 'tool_calls')
      } else {
        workerReceipt = result
        workerCompleted = workerReceipt.work?.id === workId && workerReceipt.work?.status === 'completed'
          && workerReceipt.notification?.deliveries?.some(delivery => delivery.recipient === 'personal:default'
            && delivery.status === 'delivered')
        emit({ role: 'assistant', content: 'Worker delivered the result.' })
        emit({}, 'stop')
      }
    } else if (isWorker) {
      emit(call('bizagent_memory_read', { asset_id: assetId }, 'call-memory-read'))
      emit({}, 'tool_calls')
    } else if (!leadDispatched) {
      leadDispatched = true
      emit(call('bizagent_work_dispatch', { to_address: 'role:worker', goal: 'Verify the assignment.',
        acceptance_criteria: 'Return one formal result with metric 7.', idempotency_key: 'smoke-work' },
        'call-dispatch'))
      emit({}, 'tool_calls')
    } else {
      const results = messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
      requesterToolSummary.push(results.map(result => ({ id: result.work?.id,
        status: result.work?.status, resultDelivery: result.resultDelivery?.status,
        workerLaunch: result.workerLaunch?.work?.status })))
      const evaluation = results.findLast(result => Array.isArray(result.sources))
      if (evaluation?.workId === workId) {
        requesterEvaluations.push(evaluation)
        emit({ role: 'assistant', content: 'Formal Work completed.' })
        emit({}, 'stop')
        res.end('data: [DONE]\n\n')
        return
      }
      const readReceipt = results.findLast(result => result.requestDelivery !== undefined)
      if (readReceipt?.work?.status === 'completed' && readReceipt.resultDelivery?.status === 'delivered') {
        requesterReceipts.push(readReceipt)
        emit(call('bizagent_work_output_eval', { work_id: workId }, `call-eval-${requesterReceipts.length}`))
        emit({}, 'tool_calls')
      } else {
        await waitForWorker()
        if (++leadReadCount > 8) throw new Error(`requester did not receive Work read result: ${JSON.stringify(requesterToolSummary)}`)
        emit(call('bizagent_work_read', { work_id: workId }, `call-read-${leadReadCount}`))
        emit({}, 'tool_calls')
      }
    }
    res.end('data: [DONE]\n\n')
  } catch (error) {
    if (res.headersSent) res.destroy(error)
    else {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(String(error))
    }
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

async function headless(patch, task, cwd = packageRoot) {
  const child = spawn('dsh', ['--profile', 'headless', '--patch', patch,
    task], {
    cwd,
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
  const workerDir = join(root, 'worker')
  await mkdir(workerDir)
  const homeStore = new HomeStore(join(root, 'bizagent'))
  await homeStore.initialize()
  // Automatic worker start requires the requester and assignee Homes to share one explicit owner.
  await homeStore.createHome({ address: 'personal:default', owner: 'smoke-owner' })
  await homeStore.createHome({ address: 'role:worker', owner: 'smoke-owner' })
  await homeStore.createAsset({ id: assetId, ownerAddress: 'role:worker', kind: 'method',
    description: 'Verify assigned work using the smoke method.', body: 'Check the assignment before delivery.',
    status: 'active', sourceRefs: [{ type: 'document', uri: 'smoke:worker-method', digest: 'local-smoke' }] })
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
        defaultHome: personal:default
        autoCreateDefaultHome: true
        workspaceHomes:
          '${workerDir}': role:worker
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
  const output = await headless(patch, 'Dispatch formal Work to role:worker, then read its completed result.')
  assert.match(output, /Formal Work completed\./)
  assert.ok(leadReadCount >= 1 && leadReadCount <= 8)
  assert.equal(workerCompleted, true, workerResult)
  assert.equal(workerMemoryReceipt.asset.id, assetId)
  assert.equal(workerFeedbackReceipt.receipt.signal, 'applied')
  assert.equal(workerReceipt.work.workerSessionId, workerReceipt.work.resultSessionId)
  assert.notEqual(workerReceipt.work.workerSessionId, workerReceipt.work.returnToSessionId)
  assert.equal(requesterReceipts[0].work.status, 'completed', JSON.stringify(requesterToolSummary))
  assert.equal(requesterReceipts[0].resultDelivery.status, 'delivered')
  assert.deepEqual(requesterEvaluations[0].sources[0].verdicts.map(verdict => verdict.result), ['pass', 'pass'])
  assert.match(requesterEvaluations[0].sources[0].sha256, /^[a-f0-9]{64}$/)
  assert.ok(requests.some(request => request.tools?.some(tool =>
    tool.function?.name === 'bizagent_work_dispatch')))
  assert.ok(requests.some(request => JSON.stringify(request.messages).includes('Formal Work assigned to this Agent Home')))
  assert.ok(requests.some(request => request.messages?.some(message => message.role === 'tool'
    && JSON.stringify(message).includes(workId) && JSON.stringify(message).includes('completed'))))
  const restored = await headless(patch, `Read formal Work ${workId} after this DSH restart.`)
  assert.match(restored, /Formal Work completed\./)
  assert.ok(leadReadCount >= 2 && leadReadCount <= 8)
  assert.equal(requesterReceipts[1].work.id, workId)
  assert.equal(requesterReceipts[1].work.status, 'completed')
  assert.equal(requesterReceipts[1].resultDelivery.status, 'delivered')
  assert.equal(requesterEvaluations[1].sources[0].sha256, requesterEvaluations[0].sources[0].sha256)
  const logOutput = await headless(patch, 'Inspect the automatic Worklog for completed formal Work.', workerDir)
  assert.match(logOutput, /Automatic Worklog inspected\./)
  assert.equal(workerLogReceipt.homeAddress, 'role:worker')
  assert.equal(workerLogReceipt.worklogs.filter(item => item.workId === workId).length, 1,
    JSON.stringify(workerLogReceipt))
  assert.equal(workerLogReceipt.worklogs.find(item => item.workId === workId)?.description,
    'Smoke work complete')
  assert.equal(workerLogDetailReceipt.worklog.origin, 'work-result')
  assert.equal(workerLogDetailReceipt.worklog.workId, workId)
  assert.equal(workerLogDetailReceipt.source.status, 'verified')
  const useOutput = await headless(patch, 'Inspect memory use outcomes for the completed Work.', workerDir)
  assert.match(useOutput, /Memory use inspected\./)
  assert.equal(useOutcomeReceipt.outcomes[0].workId, workId)
  assert.equal(useOutcomeReceipt.outcomes[0].workSourceStatus, 'verified')
  assert.deepEqual(useOutcomeReceipt.outcomes[0].uses.map(use => [use.signal, use.sourceStatus]),
    [['retrieved', 'verified'], ['applied', 'verified']])
  process.stdout.write('BizAgent real DSH Work smoke passed: dispatch, frozen result evaluation across restart, automatic Worklog, and memory use outcomes.\n')
} finally {
  await close()
  await rm(root, { recursive: true, force: true })
}
