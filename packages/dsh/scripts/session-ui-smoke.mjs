// Isolated real DSH Web + deterministic local model. Optional --preview keeps only this
// test instance alive for browser QA; Ctrl-C disposes the processes this script created.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startupUrl, signIn, webFetch, remote, prompt } from './dsh-web.mjs'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const root = await mkdtemp(join(await realpath(tmpdir()), 'bizagent-session-ui-'))
const modelRequests = []
const modelErrors = []
let projectId
let workId
let active
const model = createServer(async (req, res) => {
  if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"smoke-model"}]}'); return }
  let body = ''
  for await (const chunk of req) body += chunk
  try {
    const input = JSON.parse(body)
    modelRequests.push(input)
    const messages = input.messages ?? []
    const text = JSON.stringify(messages)
    const results = messages.filter(message => message.role === 'tool').map(message => {
      try { return JSON.parse(String(message.content)) } catch { return null }
    }).filter(Boolean)
    const worker = text.includes('# Formal Work assigned to this Agent Home')
    const title = messages.some(message => message.role === 'system' && String(message.content).includes('Create a concise title'))
    let delta = { role: 'assistant', content: '核对完成。正式工作和结果已留存在本会话。' }
    let finish = 'stop'
    const call = (name, args) => {
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: `ui-${name}-${results.length}`, type: 'function',
        function: { name, arguments: JSON.stringify(args) } }] }
      finish = 'tool_calls'
    }
    if (title) delta = { role: 'assistant', content: 'GMV 核对' }
    else if (worker) {
      if (!results.some(value => value.work?.status === 'accepted')) call('bizagent_work_accept', { work_id: workId })
      else if (!results.some(value => value.work?.status === 'completed')) call('bizagent_work_complete', {
        work_id: workId, subject: 'GMV 核对结果', body: '排除已取消和退款订单，GMV 为 400.50。' })
    } else if (text.includes('SESSION_UI_CHECK')) {
      // The first model request must already contain the selected Home's actual snapshot.
      assert.ok(messages.some(message => String(message.content).includes('[AGENT_FRAME]')),
        'selected Home was not loaded before the first model request')
      if (!results.some(value => value.asset)) call('bizagent_memory_remember', {
        description: 'GMV 排除取消和退款订单', body: '核对 GMV 时排除已取消和已退款订单。' })
      else if (!results.some(value => value.project)) call('bizagent_project_create', {
        title: 'GMV 核对', goal: '得到可信的 GMV', done_when: '分析师返回计算结果供验收', idempotency_key: 'session-ui-project' })
      else if (!results.some(value => value.work)) {
        projectId = results.find(value => value.project).project.id
        call('bizagent_work_dispatch', { to_address: 'role:analyst', goal: '核对订单 GMV',
          acceptance_criteria: '排除取消和退款订单，返回计算结果', project_id: projectId, idempotency_key: 'session-ui-work' })
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const emit = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-session-ui',
      object: 'chat.completion.chunk', created: 1, model: 'smoke-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    emit(delta, null); emit({}, finish); res.end('data: [DONE]\n\n')
  } catch (error) { modelErrors.push(String(error)); res.writeHead(500).end(String(error)) }
})

async function until(check, label) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timeout: ${label}; model errors: ${modelErrors.join('; ')}`)
}
async function stop() {
  if (active && active.exitCode === null) {
    active.kill('SIGINT')
    await Promise.race([new Promise(resolve => active.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))])
    if (active.exitCode === null && active.signalCode === null) active.kill('SIGTERM')
  }
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve))
  await rm(root, { recursive: true, force: true })
}

try {
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const modules = join(root, 'profiles/web/node_modules/@bizagent')
  await mkdir(modules, { recursive: true })
  await symlink(packageRoot, join(modules, 'dsh'))
  const patch = join(root, 'ui.patch.yml')
  await writeFile(patch, (await readFile(join(packageRoot, 'cordis.patch.yml'), 'utf8')) + `
- id: agent-default-model
  config: { provider: local-smoke, model: smoke-model }
- id: llm-pi-ai
  config:
    providers:
      local-smoke:
        api: openai-completions
        apiKeyEnv: BIZAGENT_SMOKE_KEY
        baseURL: http://127.0.0.1:${model.address().port}/v1
        models:
          - { id: smoke-model, name: Local test model, input: [text], contextWindow: 65536, maxTokens: 1024 }
`)
  active = spawn('dsh', ['--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: packageRoot, env: { ...process.env, DSH_HOME: root, BIZAGENT_HOME: join(root, 'bizagent'),
      BIZAGENT_SMOKE_KEY: 'local-only', BIZAGENT_LOCAL_HUMAN_ID: 'ui-test', DSH_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  active.stdout.on('data', chunk => { output += chunk })
  active.stderr.on('data', chunk => { output += chunk })
  await until(() => startupUrl(output), 'DSH startup')
  const url = startupUrl(output)
  const web = await signIn(url)
  const json = async (path, init) => {
    const response = await webFetch(web, path, init)
    const value = await response.json()
    assert.equal(response.status, 200, JSON.stringify(value))
    return value
  }
  const post = (path, value) => json(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
  await post('/api/bizagent/v1/organization', { id: 'ui-team', name: '数据核对团队', mission: '让每个结论有据可查',
    members: [{ id: 'lead', displayName: '增长负责人', roleId: 'analyst', roleName: '数据分析师', responsibility: '核对 GMV 和订单口径' }], capabilities: [] })
  const opened = await post('/api/bizagent/agent-session', { homeAddress: 'business:ui-team' })
  // Precompute the durable Work id so the worker can run immediately when dispatch wakes it.
  const { stableId } = await import('../lib/domain.js')
  workId = stableId('work', 'business:ui-team:session-ui-work')
  await prompt(web, opened.sessionId, 'SESSION_UI_CHECK\n@role:analyst\n[BIZAGENT_FRAME_REQUEST:role:analyst]')
  let context
  await until(async () => {
    context = await json(`/api/bizagent/v1/session-context?sessionId=${opened.sessionId}`)
    return context.work.some(item => item.status === 'completed') && context.activity.length >= 3
  }, 'Work completion and Session activity')
  assert.equal(context.summary.kind, 'principal')
  assert.equal(context.frames[0].address, 'role:analyst')
  assert.equal(context.projects[0].title, 'GMV 核对')
  assert.match(context.work[0].resultBody, /400.50/)
  assert.equal((await fetch(`${web.base}/api/bizagent/v1/sessions`)).status, 401)
  const catalog = await json('/api/bizagent/v1/sessions')
  assert.ok(catalog.sessions.some(item => item.kind === 'work' && item.workStatus === 'completed'))
  assert.equal(modelErrors.length, 0)
  // A fresh browser gets its own ordinary startup login; only this disposable profile is used.
  await writeFile(join(root, 'ready.json'), JSON.stringify({ url, base: web.base, sessionId: opened.sessionId,
    projectId, workId, workerSessionId: context.work[0].workerSessionId }))
  console.log(JSON.stringify({ ok: true, root, ready: join(root, 'ready.json'), modelCalls: modelRequests.length,
    activity: context.activity.length, workStatus: context.work[0].status }))
  if (process.argv.includes('--preview')) await new Promise(resolve => {
    process.once('SIGINT', resolve); process.once('SIGTERM', resolve)
  })
} finally { await stop() }
