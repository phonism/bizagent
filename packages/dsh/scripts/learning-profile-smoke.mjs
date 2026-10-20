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
const root = await mkdtemp(join(await realpath(tmpdir()), 'bizagent-dsh-learning-'))
const recover = process.argv.includes('--recover')
const requests = []
const trace = []
let sourceStage = 0
let requesterStage = 0
let requesterReads = 0
let reviewStage = 0
let workerCompleted = false
let runId
let launchId
let workerSessionId
let material
let sourceSeq
let candidateId
let pausedOnce = false
let interruptedHostStopped = false
let recoveryStatusRequested = false
let recoveryStatusSeen = false
let observedUsage
let reportPaused
const workerPaused = new Promise(resolvePaused => { reportPaused = resolvePaused })
let releasePaused
const workerReleased = new Promise(resolveReleased => { releasePaused = resolveReleased })

function call(name, args, id) {
  return { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
    function: { name, arguments: JSON.stringify(args) } }] }
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
    const isTitle = messages.some(message => message.role === 'system'
      && String(message.content).includes('Create a concise title'))
    const isWorker = JSON.stringify(messages).includes('Dedicated learning review for this Agent Home')
    const hasResumePrompt = isWorker && JSON.stringify(messages).includes('Continue the interrupted learning review')
    const isRequester = !isWorker && JSON.stringify(messages).includes('Launch a dedicated learning review for this Home')
    const lastTool = messages.filter(message => message.role === 'tool').at(-1)
    trace.push({ side: isTitle ? 'title' : isWorker ? 'worker' : isRequester ? 'requester' : 'source',
      sourceStage, requesterStage, reviewStage,
      resumePrompt: hasResumePrompt,
      toolStarted: lastTool ? (() => { try { return JSON.parse(lastTool.content).started } catch { return undefined } })() : undefined,
      tool: lastTool ? String(lastTool.content).slice(0, 300) : undefined,
      launchStatus: lastTool ? (() => { try { return JSON.parse(lastTool.content).launch?.status } catch { return undefined } })() : undefined,
      workerStatus: lastTool ? (() => { try { return JSON.parse(lastTool.content).workerStatus } catch { return undefined } })() : undefined })
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const emit = (delta, finishReason = null) => res.write(`data: ${JSON.stringify({
      id: `chatcmpl-learning-${requests.length}`, object: 'chat.completion.chunk',
      created: 1, model: 'smoke-model', choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`)
    if (isTitle) {
      emit({ role: 'assistant', content: 'Learning smoke' })
      emit({}, 'stop')
    } else if (isRequester && requesterStage++ === 0) {
      emit(call('bizagent_learning_launch', { idempotency_key: 'smoke-learning' }, 'learning-launch'))
      emit({}, 'tool_calls')
    } else if (isRequester) {
      const result = JSON.parse(lastTool?.content ?? '{}')
      if (result.launch?.workerSessionId) launchId = result.launch.id
      if (result.usage?.status === 'reported' || result.usage?.status === 'partial') {
        observedUsage = result.usage
      }
      assert.ok(launchId, lastTool?.content)
      if (result.launch?.status === 'completed' && workerCompleted) {
        emit({ role: 'assistant', content: 'Dedicated learning worker completed.' })
        emit({}, 'stop')
      } else if (result.launch?.status === 'needs_review') {
        emit({ role: 'assistant', content: `Learning launch needs review: ${result.launch.reason}` })
        emit({}, 'stop')
      } else {
        if (++requesterReads > 60) throw new Error(`learning worker did not finish after ${requesterReads} reads`)
        await new Promise(resolveDelay => setTimeout(resolveDelay, 150))
        emit(call('bizagent_learning_launch_read', { launch_id: launchId }, `learning-read-${requesterReads}`))
        emit({}, 'tool_calls')
      }
    } else if (!isWorker && sourceStage++ === 0) {
      emit(call('bizagent_home_status', {}, 'source-home'))
      emit({}, 'tool_calls')
    } else if (!isWorker && sourceStage === 2) {
      assert.ok(lastTool, 'source Home status tool did not return')
      emit({ role: 'assistant', content: 'Source work complete.' })
      emit({}, 'stop')
    } else if (!isWorker) {
      emit({ role: 'assistant', content: 'Context summary complete.' })
      emit({}, 'stop')
    } else if (reviewStage === 0) {
      reviewStage += 1
      emit(call('bizagent_learning_batch_start', {}, 'learning-start'))
      emit({}, 'tool_calls')
    } else if (reviewStage === 1) {
      if (recover && !pausedOnce) {
        pausedOnce = true
        reportPaused()
        await workerReleased
        if (interruptedHostStopped || res.destroyed) { res.destroy(); return }
      }
      const result = JSON.parse(lastTool?.content ?? '{}')
      assert.ok(result.started === true || recover && result.run?.id === runId
        && result.run?.status === 'open', lastTool?.content)
      assert.equal(result.materials.length, 1, lastTool?.content)
      runId = result.run.id
      workerSessionId = result.run.reviewerSessionId
      material = result.materials[0]
      if (recover && hasResumePrompt && !recoveryStatusRequested) {
        recoveryStatusRequested = true
        emit(call('bizagent_learning_batch_status', { run_id: runId }, 'learning-recovery-status'))
      } else {
        if (recoveryStatusRequested) recoveryStatusSeen = true
        reviewStage += 1
        emit(call('bizagent_episode_read', { session_id: material.sessionId, limit: 20 }, 'learning-source'))
      }
      emit({}, 'tool_calls')
    } else if (reviewStage === 2) {
      const result = JSON.parse(lastTool?.content ?? '{}')
      const sourceEvent = result.events?.find(event => String(event.text).includes('signup date'))
      assert.ok(sourceEvent, lastTool?.content)
      sourceSeq = sourceEvent.seq
      reviewStage += 1
      emit(call('bizagent_learning_batch_settle', {
        run_id: runId, material_id: material.id, summary: 'Keep the source statement as a candidate.',
        candidates: [{ kind: 'knowledge', description: 'Cohort date convention to verify',
          body: 'Use signup date for the cohort.', from_seq: sourceSeq, to_seq: sourceSeq }],
      }, 'learning-settle'))
      emit({}, 'tool_calls')
    } else if (reviewStage === 3) {
      const result = JSON.parse(lastTool?.content ?? '{}')
      candidateId = result.review?.assetIds?.[0]
      assert.ok(candidateId, lastTool?.content)
      reviewStage += 1
      emit(call('bizagent_evidence_read', { asset_id: candidateId }, 'learning-evidence'))
      emit({}, 'tool_calls')
    } else if (reviewStage === 4) {
      const result = JSON.parse(lastTool?.content ?? '{}')
      assert.equal(result.ref?.sessionId, material.sessionId, lastTool?.content)
      assert.ok(result.events?.some(event => String(event.text).includes('signup date')), lastTool?.content)
      reviewStage += 1
      emit(call('bizagent_learning_batch_finish', {
        run_id: runId, action: 'complete', summary: 'One source reviewed.',
      }, 'learning-finish'))
      emit({}, 'tool_calls')
    } else {
      const result = JSON.parse(lastTool?.content ?? '{}')
      assert.equal(result.run?.status, 'completed', lastTool?.content)
      assert.equal(result.run?.reviewerSessionId, workerSessionId)
      workerCompleted = true
      reviewStage += 1
      emit({ role: 'assistant', content: 'Learning batch completed.' })
      emit({}, 'stop')
    }
    res.write(`data: ${JSON.stringify({ id: `chatcmpl-learning-${requests.length}`,
      object: 'chat.completion.chunk', created: 1, model: 'smoke-model', choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  } catch (error) {
    trace.push({ error: String(error) })
    if (res.headersSent) res.destroy(error)
    else { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(String(error)) }
  }
})

function listen() {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => resolveListen(server.address().port))
  })
}

async function headless(patch, task, onSpawn) {
  const child = spawn('dsh', ['--profile', 'headless', '--patch', patch, task], {
    cwd: packageRoot,
    env: { ...process.env, DSH_HOME: root, BIZAGENT_HOME: join(root, 'bizagent'), DSH_TELEMETRY_DISABLED: '1',
      BIZAGENT_SMOKE_KEY: 'local-only', DSH_TOOLS_MODE: 'native' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  onSpawn?.(child)
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
        timer = setTimeout(() => rejectTimeout(new Error(`headless DSH timed out: ${output}; trace: ${JSON.stringify(trace)}`)), 45000)
      }),
    ])
    if (result.code !== 0) throw new Error(`headless DSH failed (${result.code ?? result.signal}): ${output}; trace: ${JSON.stringify(trace)}`)
    return output
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGINT')
      await new Promise(resolveExit => { child.once('exit', resolveExit); setTimeout(resolveExit, 5000) })
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
    throw error
  } finally { clearTimeout(timer) }
}

try {
  const port = await listen()
  const moduleDirectory = join(root, 'profiles', 'headless', 'node_modules', '@bizagent')
  await mkdir(moduleDirectory, { recursive: true })
  await symlink(packageRoot, join(moduleDirectory, 'dsh-plugin'), 'dir')
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
      name: '@bizagent/dsh-plugin'
      config:
        defaultHome: personal:default
        autoCreateDefaultHome: true
        workspaceHomes:
          '${packageRoot}': personal:default
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
  const sourceOutput = await headless(patch, 'For this cohort, use signup date. Call Home status once.')
  assert.match(sourceOutput, /Source work complete\./)
  const reviewTask = 'Launch a dedicated learning review for this Home, then report completion.'
  let reviewOutput
  if (recover) {
    launchId = stableId('learning-launch', 'personal:default:smoke-learning')
    let interruptedChild
    const interrupted = headless(patch, reviewTask, child => { interruptedChild = child })
      .then(() => new Error('first learning host exited before the fault was injected'))
      .catch(error => error)
    let pauseTimer
    try {
      await Promise.race([
        workerPaused,
        interrupted.then(error => { throw error }),
        new Promise((_, rejectTimeout) => { pauseTimer = setTimeout(() => rejectTimeout(new Error(
          `learning worker did not reach the interruption point: ${JSON.stringify(trace)}`)), 30_000) }),
      ])
    } finally { clearTimeout(pauseTimer) }
    assert.equal(interruptedChild.kill('SIGKILL'), true)
    assert.match(String(await interrupted), /headless DSH failed/)
    interruptedHostStopped = true
    observedUsage = undefined
    releasePaused()
    reviewOutput = await headless(patch, reviewTask)
  } else {
    reviewOutput = await headless(patch, reviewTask)
  }
  assert.match(reviewOutput, /Dedicated learning worker completed\./, JSON.stringify(trace))
  const store = new HomeStore(join(root, 'bizagent'))
  await store.initialize()
  const asset = store.readAsset('personal:default', candidateId)
  assert.equal(asset.status, 'candidate')
  assert.equal(asset.sourceRefs[0].type, 'session-events')
  assert.equal(asset.sourceRefs[0].sessionId, material.sessionId)
  assert.equal(workerSessionId, stableId('learning-session', launchId))
  assert.ok(observedUsage?.reported?.inputTokens > 0, JSON.stringify(observedUsage))
  assert.ok(observedUsage?.reported?.outputTokens > 0, JSON.stringify(observedUsage))
  assert.equal(observedUsage.costUsd, null)
  assert.deepEqual([asset.sourceRefs[0].fromSeq, asset.sourceRefs[0].toSeq], [sourceSeq, sourceSeq])
  assert.equal(store.searchAssets('personal:default').length, 0)
  assert.ok(requests.some(request => request.tools?.some(tool =>
    tool.function?.name === 'bizagent_learning_batch_settle')))
  assert.ok(requests.some(request => request.tools?.some(tool =>
    tool.function?.name === 'bizagent_learning_launch')))
  if (recover && trace.some(item => item.resumePrompt)) {
    assert.equal(recoveryStatusSeen, true, 'resumed worker did not read its frozen batch status')
  }
  if (process.argv.includes('--trace')) process.stdout.write(`${JSON.stringify(trace
    .filter(item => item.side === 'worker')
    .map(({ reviewStage: stage, resumePrompt, toolStarted, error }) =>
      ({ stage, resumePrompt, toolStarted, error }))) }\n`)
  process.stdout.write(`BizAgent real DSH learning smoke passed: dedicated worker, source evidence, completion${recover ? ', and cross-process recovery' : ''}.\n`)
} finally {
  releasePaused()
  server.closeAllConnections()
  await new Promise(resolveClose => server.close(resolveClose))
  await rm(root, { recursive: true, force: true })
}
