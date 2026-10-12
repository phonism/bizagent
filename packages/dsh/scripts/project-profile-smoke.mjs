import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HomeStore } from '../lib/home-store.js'
import { stableId } from '../lib/domain.js'
import { projectMainSessionId } from '../lib/agent-session-address.js'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const root = await mkdtemp(join(await realpath(tmpdir()), 'bizagent-dsh-project-'))
const projectId = stableId('project', 'personal:default:smoke-project')
const workflowProjectId = stableId('project', 'personal:default:smoke-workflow-plan')
const crashProjectId = stableId('project', 'personal:default:smoke-crash-pause')
const crashWorkIds = ['first', 'second'].map(key => stableId('work', `personal:default:smoke-crash-${key}`))
const seatAddress = `seat:${projectId}:${stableId('seat', 'role:analyst')}`
const requestId = stableId('inbox', 'personal:default:smoke-seat-request')
const replyId = stableId('inbox', 'role:analyst:smoke-seat-reply')
const requests = []
const serverErrors = []
let leadStage = 0
let workerStage = 0
let workerReplied = false
let workerFinished = false
let leadReadReply = false
let restartStage = 0
let planStage = 0
let planRestoreStage = 0
let crashStage = 0
let crashRestoreStage = 0

const collectStep = { id: 'collect', title: 'Collect evidence', intent: 'Collect source evidence.',
  executor: 'personal:default', acceptance_criteria: 'Return source evidence.', after: [] }
const auditStep = { id: 'audit', title: 'Audit evidence', intent: 'Check the source evidence.',
  executor: 'role:analyst', acceptance_criteria: 'Return an audit.', after: ['collect'] }

function call(name, args, id) {
  return { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
    function: { name, arguments: JSON.stringify(args) } }] }
}

function waitFor(predicate, label, ms = 20000) {
  const deadline = Date.now() + ms
  return new Promise((resolveWait, rejectWait) => {
    const check = () => {
      if (predicate()) { resolveWait(); return }
      if (Date.now() >= deadline) { rejectWait(new Error(`timed out waiting for ${label}`)); return }
      setTimeout(check, 25)
    }
    check()
  })
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
    const isCompaction = messages.some(message => message.role === 'user'
      && String(message.content).includes('You are now acting as a compaction engine'))
    const isRestart = JSON.stringify(messages).includes('Read the persisted Project after restart')
    const isPlan = JSON.stringify(messages).includes('Create and amend an audited Workflow plan')
    const isPlanRestore = JSON.stringify(messages).includes('Read the amended Workflow after restart')
    const isCrash = JSON.stringify(messages).includes('Create a Project and crash during its pause')
    const isCrashRestore = JSON.stringify(messages).includes('Read the paused Project after a crash')
    const isWorker = JSON.stringify(messages).includes('# Pending Inbox for this Agent Home')
    const results = messages.filter(message => message.role === 'tool')
    const latest = results.at(-1) === undefined ? undefined : JSON.parse(String(results.at(-1).content))
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const emit = (delta, finishReason = null) => res.write(`data: ${JSON.stringify({
      id: `chatcmpl-project-${requests.length}`, object: 'chat.completion.chunk',
      created: 1, model: 'smoke-model', choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`)
    if (isTitle) {
      emit({ role: 'assistant', content: 'Project smoke' })
      emit({}, 'stop')
    } else if (isCompaction) {
      emit({ role: 'assistant', content: `## Primary Request and Intent
- Create a Project, invite the Analyst Home into a Project Seat, send an urgent Project message, and read its reply.

## Current State
- Project ID: ${projectId}
- Analyst Seat address: ${seatAddress}
- Request message ID: ${requestId}
- Reply message ID: ${replyId}
- Continue the pending tool workflow using the existing tool results.

## Important Instructions
- Keep execution in the Analyst Home. Use the Seat address for Project routing and attribution.` })
      emit({}, 'stop')
    } else if (isRestart) {
      const stage = restartStage++
      if (stage === 0) {
        emit(call('bizagent_project_read', { project_id: projectId }, 'restart-read-project'))
        emit({}, 'tool_calls')
      } else if (stage === 1) {
        assert.equal(latest.project.id, projectId)
        assert.equal(latest.project.seats[0].address, seatAddress)
        assert.equal(latest.project.seats[0].status, 'active')
        emit(call('bizagent_inbox_read', { message_id: replyId }, 'restart-read-reply'))
        emit({}, 'tool_calls')
      } else {
        assert.equal(latest.message.id, replyId)
        assert.equal(latest.message.fromAddress, seatAddress)
        emit({ role: 'assistant', content: 'Project Seat restart verified.' })
        emit({}, 'stop')
      }
    } else if (isCrashRestore) {
      const stage = crashRestoreStage++
      if (stage === 0) {
        emit(call('bizagent_project_read', { project_id: crashProjectId }, 'crash-restart-read'))
        emit({}, 'tool_calls')
      } else if (stage === 1) {
        assert.equal(latest.project.id, crashProjectId)
        assert.equal(latest.project.revision, 2)
        assert.equal(latest.project.intervention.paused, true)
        assert.deepEqual(latest.work.map(work => work.id).sort(), [...crashWorkIds].sort())
        assert.deepEqual(latest.work.map(work => work.status), ['cancelled', 'cancelled'])
        assert.ok(latest.work.every(work => work.cancelReason === 'Project paused: Revise after both reports.'))
        emit(call('bizagent_work_read', { work_id: crashWorkIds[0] }, 'crash-work-first'))
        emit({}, 'tool_calls')
      } else if (stage === 2) {
        assert.equal(latest.work.id, crashWorkIds[0])
        assert.equal(latest.cancelDelivery.status, 'delivered')
        emit(call('bizagent_work_read', { work_id: crashWorkIds[1] }, 'crash-work-second'))
        emit({}, 'tool_calls')
      } else {
        assert.equal(latest.work.id, crashWorkIds[1])
        assert.equal(latest.cancelDelivery.status, 'delivered')
        emit({ role: 'assistant', content: 'Paused Project crash recovery verified.' })
        emit({}, 'stop')
      }
    } else if (isCrash) {
      const stage = crashStage++
      if (stage === 0) {
        emit(call('bizagent_project_create', {
          title: 'Crash pause smoke', goal: 'Review two reports.',
          done_when: 'Both reports are reviewed.', idempotency_key: 'smoke-crash-pause',
        }, 'crash-create'))
        emit({}, 'tool_calls')
      } else if (stage === 1 || stage === 2) {
        if (stage === 1) assert.equal(latest.project.id, crashProjectId)
        else assert.equal(latest.work.id, crashWorkIds[0])
        const key = stage === 1 ? 'first' : 'second'
        emit(call('bizagent_work_dispatch', {
          to_address: 'role:analyst', goal: `Prepare ${key} report`,
          acceptance_criteria: 'Return a report.', idempotency_key: `smoke-crash-${key}`,
          project_id: crashProjectId,
        }, `crash-dispatch-${key}`))
        emit({}, 'tool_calls')
      } else {
        assert.equal(latest.work.id, crashWorkIds[1])
        emit(call('bizagent_project_pause', {
          project_id: crashProjectId, expected_project_revision: 1,
          reason: 'Revise after both reports.',
        }, 'crash-pause'))
        emit({}, 'tool_calls')
      }
    } else if (isPlanRestore) {
      const stage = planRestoreStage++
      if (stage === 0) {
        emit(call('bizagent_project_read', { project_id: workflowProjectId }, 'plan-restart-read'))
        emit({}, 'tool_calls')
      } else {
        assert.equal(latest.project.workflow.revision, 3)
        assert.deepEqual(latest.project.workflow.steps.map(step => step.id), ['collect'])
        assert.equal(latest.project.workflowAmendments[0].reason, 'Add an evidence audit.')
        assert.equal(latest.project.workflowAmendments[1].mode, 'rebuild')
        assert.deepEqual(latest.project.workflowAmendments[1].retained, [])
        assert.deepEqual(latest.project.intervention.history.map(item => item.action), ['pause', 'resume'])
        emit({ role: 'assistant', content: 'Workflow amendment restart verified.' })
        emit({}, 'stop')
      }
    } else if (isPlan) {
      const stage = planStage++
      if (stage === 0) {
        emit(call('bizagent_project_create', {
          title: 'Workflow plan smoke', goal: 'Review source evidence.',
          done_when: 'An audit is recorded.', idempotency_key: 'smoke-workflow-plan',
          workflow: { summary: 'Collect evidence.', steps: [collectStep] },
        }, 'plan-create'))
        emit({}, 'tool_calls')
      } else if (stage === 1) {
        assert.equal(latest.project.id, workflowProjectId)
        assert.equal(latest.project.workflow.revision, 1)
        emit(call('bizagent_project_turn_join', { project_id: workflowProjectId }, 'plan-turn-join'))
        emit({}, 'tool_calls')
      } else if (stage === 2) {
        assert.equal(latest.participation.projectId, workflowProjectId)
        assert.ok(latest.participation.sessionId)
        emit(call('bizagent_project_plan_amend', {
          project_id: workflowProjectId, expected_project_revision: 1,
          expected_workflow_revision: 1, reason: 'Add an evidence audit.',
          idempotency_key: 'smoke-plan-amend',
          workflow: { summary: 'Collect and audit evidence.', steps: [collectStep, auditStep] },
        }, 'plan-amend'))
        emit({}, 'tool_calls')
      } else if (stage === 3) {
        assert.equal(latest.project.id, workflowProjectId)
        assert.equal(latest.project.workflow.revision, 2)
        assert.equal(latest.project.workflowAmendments.length, 1)
        emit(call('bizagent_project_pause', {
          project_id: workflowProjectId, expected_project_revision: 2,
          reason: 'Check the execution state.',
        }, 'plan-pause'))
        emit({}, 'tool_calls')
      } else if (stage === 4) {
        assert.equal(latest.project.intervention.paused, true)
        assert.deepEqual(latest.cancelledWorkIds, [])
        emit(call('bizagent_project_plan_rebuild', {
          project_id: workflowProjectId, expected_project_revision: 3,
          expected_workflow_revision: 2, reason: 'Remove the unnecessary audit.',
          idempotency_key: 'smoke-plan-rebuild',
          workflow: { summary: 'Collect evidence only.', steps: [collectStep] },
        }, 'plan-rebuild'))
        emit({}, 'tool_calls')
      } else if (stage === 5) {
        assert.equal(latest.project.workflow.revision, 3)
        assert.deepEqual(latest.project.workflow.steps.map(step => step.id), ['collect'])
        emit(call('bizagent_project_resume', {
          project_id: workflowProjectId, expected_project_revision: 4,
        }, 'plan-resume'))
        emit({}, 'tool_calls')
      } else {
        assert.equal(latest.project.intervention.paused, false)
        assert.equal(latest.project.intervention.epoch, 1)
        emit({ role: 'assistant', content: 'Workflow amendment verified.' })
        emit({}, 'stop')
      }
    } else if (isWorker) {
      const stage = workerStage++
      if (stage === 0) {
        assert.ok(JSON.stringify(messages).includes(`Your Seat address: ${seatAddress}`))
        assert.ok(JSON.stringify(messages).includes('Your responsibility: Analyze source evidence'))
        emit(call('bizagent_inbox_read', { message_id: requestId }, 'seat-read-letter'))
        emit({}, 'tool_calls')
      } else if (stage === 1) {
        assert.equal(latest.message.id, requestId)
        assert.deepEqual(latest.message.to, [seatAddress])
        emit(call('bizagent_project_read', { project_id: projectId }, 'seat-read-project'))
        emit({}, 'tool_calls')
      } else if (stage === 2) {
        assert.equal(latest.project.id, projectId)
        assert.equal(latest.project.seats[0].responsibility, 'Analyze source evidence')
        emit(call('bizagent_inbox_send', {
          to: ['personal:default'], reply_to: requestId, idempotency_key: 'smoke-seat-reply',
          subject: 'Source review', body: 'The Project Seat checked the source evidence.',
          priority: 'urgent',
        }, 'seat-reply'))
        emit({}, 'tool_calls')
      } else if (stage === 3) {
        assert.equal(latest.message.id, replyId)
        assert.equal(latest.message.fromAddress, seatAddress)
        assert.equal(latest.message.projectId, projectId)
        assert.deepEqual(latest.message.to, ['personal:default'])
        workerReplied = true
        emit(call('bizagent_inbox_handle', { message_id: requestId }, 'seat-handle'))
        emit({}, 'tool_calls')
      } else {
        assert.equal(latest.delivery.recipient, seatAddress)
        workerFinished = true
        emit({ role: 'assistant', content: 'Project Seat reply delivered.' })
        emit({}, 'stop')
      }
    } else {
      const stage = leadStage++
      if (stage === 0) {
        emit(call('bizagent_project_create', {
          title: 'Project smoke', goal: 'Review source evidence.',
          done_when: 'A source conclusion is recorded.', idempotency_key: 'smoke-project',
        }, 'lead-create'))
        emit({}, 'tool_calls')
      } else if (stage === 1) {
        assert.equal(latest.project.id, projectId)
        assert.equal(latest.project.driver, `project:${projectId}`)
        assert.equal(latest.mainSession?.status, 'ready')
        assert.equal(latest.mainSession.sessionId, projectMainSessionId(projectId))
        emit(call('bizagent_project_invite', {
          project_id: projectId, home_address: 'role:analyst',
          responsibility: 'Analyze source evidence',
        }, 'lead-invite'))
        emit({}, 'tool_calls')
      } else if (stage === 2) {
        assert.equal(latest.seat.address, seatAddress)
        emit(call('bizagent_inbox_send', {
          project_id: projectId, to: ['role:analyst'],
          subject: 'Review source evidence', body: 'Read the Project and return a finding.',
          priority: 'urgent', idempotency_key: 'smoke-seat-request',
        }, 'lead-send'))
        emit({}, 'tool_calls')
      } else if (stage === 3) {
        assert.equal(latest.message.id, requestId)
        assert.deepEqual(latest.message.to, [seatAddress])
        assert.equal(latest.deliveries[0].status, 'delivered')
        emit(call('bizagent_home_status', {}, 'lead-wake-status'))
        emit({}, 'tool_calls')
      } else if (stage === 4) {
        assert.deepEqual(latest.persistenceErrors, [])
        await waitFor(() => workerReplied, `Project Seat reply; Home status ${JSON.stringify(latest)}`)
        emit(call('bizagent_inbox_read', { message_id: replyId }, 'lead-read-reply'))
        emit({}, 'tool_calls')
      } else {
        assert.equal(latest.message.id, replyId)
        assert.equal(latest.message.fromAddress, seatAddress)
        leadReadReply = true
        emit({ role: 'assistant', content: 'Project Seat communication verified.' })
        emit({}, 'stop')
      }
    }
    res.end('data: [DONE]\n\n')
  } catch (error) {
    serverErrors.push({ error: String(error), leadStage, workerStage,
      requests: requests.length, lastTool: String(requests.at(-1)?.messages?.filter(message =>
        message.role === 'tool').at(-1)?.content).slice(0, 900),
      ...(serverErrors.length === 0 ? { messages: JSON.stringify(requests.at(-1)?.messages).slice(-2600) } : {}) })
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

async function headless(patch, task, options = {}) {
  const child = spawn('dsh', ['--profile', 'headless', '--patch', patch,
    task], {
    cwd: packageRoot,
    env: { ...process.env, DSH_HOME: root, DSH_TELEMETRY_DISABLED: '1',
      BIZAGENT_SMOKE_KEY: 'local-only', DSH_TOOLS_MODE: 'native',
      ...(options.nodeOptions !== undefined ? { NODE_OPTIONS: options.nodeOptions } : {}) },
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
  } finally { clearTimeout(timer) }
  if (options.expectedSignal !== undefined) {
    if (result.signal !== options.expectedSignal) {
      throw new Error(`headless DSH did not exit by ${options.expectedSignal} (${result.code ?? result.signal}): ${output}; `
        + `server errors: ${JSON.stringify(serverErrors)}; requests: ${requests.length}`)
    }
    return output
  }
  if (result.code !== 0) throw new Error(`headless DSH failed (${result.code ?? result.signal}): ${output}; `
    + `server errors: ${JSON.stringify(serverErrors)}; requests: ${requests.length}`)
  return output
}

try {
  const port = await listen()
  const analystDir = join(root, 'analyst')
  await mkdir(analystDir)
  const homeRoot = join(root, 'bizagent')
  const store = new HomeStore(homeRoot)
  await store.initialize()
  await store.createHome({ address: 'personal:default', owner: 'smoke-owner' })
  await store.createHome({ address: 'role:analyst', owner: 'smoke-owner' })
  const moduleDirectory = join(root, 'profiles', 'headless', 'node_modules', '@bizagent')
  await mkdir(moduleDirectory, { recursive: true })
  await symlink(packageRoot, join(moduleDirectory, 'dsh'), 'dir')
  const patch = join(root, 'project.patch.yml')
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
        workspaceHomes:
          '${analystDir}': role:analyst
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
            contextWindow: 65536
            maxTokens: 1024
`)
  const output = await headless(patch,
    'Create a Project, invite Analyst, send an urgent Project message, and read its reply.')
  await waitFor(() => workerFinished && leadReadReply, 'Project Seat exchange')
  assert.match(output, /Project Seat communication verified\./)
  const restored = await headless(patch, 'Read the persisted Project after restart and the Analyst reply.')
  assert.match(restored, /Project Seat restart verified\./)
  const planned = await headless(patch, 'Create and amend an audited Workflow plan.')
  assert.match(planned, /Workflow amendment verified\./)
  const planRestored = await headless(patch, 'Read the amended Workflow after restart.')
  assert.match(planRestored, /Workflow amendment restart verified\./)
  const faultPreload = join(root, 'project-pause-fault.mjs')
  await writeFile(faultPreload, `import { WorkLedger } from ${JSON.stringify(pathToFileURL(join(packageRoot, 'lib', 'work-ledger.js')).href)}
const originalPut = WorkLedger.prototype.put
let cancelled = 0
WorkLedger.prototype.put = async function (work) {
  if (work.status === 'cancelled' && ++cancelled === 2) process.kill(process.pid, 'SIGKILL')
  return originalPut.call(this, work)
}
`)
  const nodeOptions = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(faultPreload).href}`]
    .filter(Boolean).join(' ')
  await headless(patch, 'Create a Project and crash during its pause.',
    { nodeOptions, expectedSignal: 'SIGKILL' })
  assert.equal(crashStage, 4)
  const crashRestored = await headless(patch, 'Read the paused Project after a crash.')
  assert.match(crashRestored, /Paused Project crash recovery verified\./)
  assert.ok(requests.some(request => request.tools?.some(tool =>
    tool.function?.name === 'bizagent_project_invite')))
  assert.ok(requests.some(request => request.tools?.some(tool =>
    tool.function?.name === 'bizagent_inbox_read')))
  assert.ok(requests.some(request => request.tools?.some(tool =>
    tool.function?.name === 'bizagent_project_plan_amend')))
  assert.ok(requests.some(request => request.tools?.some(tool =>
    tool.function?.name === 'bizagent_project_plan_rebuild')))
  assert.ok(requests.some(request => request.tools?.some(tool =>
    tool.function?.name === 'bizagent_project_turn_join')))
  assert.ok(requests.some(request => request.tools?.some(tool =>
    tool.function?.name === 'bizagent_project_pause')))
  process.stdout.write('BizAgent real DSH Project Seat smoke passed: invite, Seat wake context, Project read, reply, Home-bound execution, turn join, Workflow amendment, paused rebuild, resume, restart recovery, and crash-safe pause repair.\n')
} finally {
  await close()
  await rm(root, { recursive: true, force: true })
}
