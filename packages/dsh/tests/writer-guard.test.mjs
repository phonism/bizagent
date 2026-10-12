import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { rm, readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { test } from 'node:test'
import { RuntimeWriterGuard } from '../lib/writer-guard.js'
import { makeTempDir } from './temp-dir.mjs'

test('only one process can own a BizAgent writer root at a time', async t => {
  const root = await makeTempDir('bizagent-writer-')
  const profile = `${root}/profile`
  const homeA = `${root}/home-a`
  const homeB = `${root}/home-b`
  const otherProfile = `${root}/other-profile`
  const moduleUrl = new URL('../lib/writer-guard.js', import.meta.url).href
  const script = `import { RuntimeWriterGuard } from ${JSON.stringify(moduleUrl)};
const guard = await RuntimeWriterGuard.acquire([process.argv[1], process.argv[2]]);
process.stdout.write('ready\\n');
process.stdin.once('end', async () => { await guard.release(); process.exit(0) });
process.stdin.resume();`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, profile, homeA], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  })
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('writer child did not start')), 5000)
    child.once('error', error => { clearTimeout(timer); rejectReady(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      rejectReady(new Error(`writer child exited before ready: ${code ?? signal}`))
    })
    child.stdout.once('data', data => {
      clearTimeout(timer)
      assert.match(String(data), /ready/)
      resolveReady()
    })
  })

  const owner = JSON.parse(await readFile(`${profile}/.bizagent-writer.lock`, 'utf8'))
  assert.equal(owner.pid, child.pid)
  await assert.rejects(RuntimeWriterGuard.acquire([profile, homeB]), /writer is already reserved/)
  await assert.rejects(RuntimeWriterGuard.acquire([otherProfile, homeA]), /writer is already reserved/)
  await assert.rejects(readFile(`${homeB}/.bizagent-writer.lock`), /ENOENT/)

  const exited = new Promise((resolveExit, rejectExit) => {
    child.once('exit', (code, signal) => {
      if (code === 0) resolveExit()
      else rejectExit(new Error(`writer child exit: ${code ?? signal}`))
    })
  })
  child.stdin.end()
  await exited
  const next = await RuntimeWriterGuard.acquire([profile, homeB])
  await next.release()
})

test('an abrupt exit is recovered by one of two simultaneous writer processes', async t => {
  const root = await makeTempDir('bizagent-writer-recover-')
  let contenders = []
  t.after(async () => {
    for (const child of contenders) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    await rm(root, { recursive: true, force: true })
  })
  const moduleUrl = new URL('../lib/writer-guard.js', import.meta.url).href
  const crashScript = `import { RuntimeWriterGuard } from ${JSON.stringify(moduleUrl)};
await RuntimeWriterGuard.acquire([process.argv[1]]);
process.exit(17);`
  const crashed = spawn(process.execPath, ['--input-type=module', '-e', crashScript, root])
  assert.equal(await new Promise(resolveExit => crashed.once('exit', resolveExit)), 17)
  const stale = JSON.parse(await readFile(`${root}/.bizagent-writer.lock`, 'utf8'))
  assert.equal(stale.pid, crashed.pid)

  const contenderScript = `import { RuntimeWriterGuard } from ${JSON.stringify(moduleUrl)};
try {
  const guard = await RuntimeWriterGuard.acquire([process.argv[1]]);
  process.stdout.write('ACQUIRED\\n');
  process.stdin.once('end', async () => { await guard.release(); process.exit(0) });
  process.stdin.resume();
} catch (error) {
  process.stdout.write('BLOCKED: ' + error.message + '\\n');
  process.exitCode = 2;
}`
  contenders = [0, 1].map(() => spawn(process.execPath,
    ['--input-type=module', '-e', contenderScript, root], { stdio: ['pipe', 'pipe', 'pipe'] }))
  const firstLines = await Promise.all(contenders.map(child => new Promise((resolveLine, rejectLine) => {
    const timer = setTimeout(() => rejectLine(new Error('writer contender did not respond')), 5000)
    child.once('error', error => { clearTimeout(timer); rejectLine(error) })
    child.stdout.once('data', data => { clearTimeout(timer); resolveLine(String(data).trim()) })
  })))
  assert.equal(firstLines.filter(line => line === 'ACQUIRED').length, 1, firstLines.join(' | '))
  assert.equal(firstLines.filter(line => line.includes('BLOCKED: BizAgent writer is already reserved')).length, 1,
    firstLines.join(' | '))
  const winner = contenders[firstLines.indexOf('ACQUIRED')]
  const winnerExit = new Promise(resolveExit => winner.once('exit', resolveExit))
  winner.stdin.end()
  assert.equal(await winnerExit, 0)
  const next = await RuntimeWriterGuard.acquire([root])
  await next.release()

  await writeFile(`${root}/.bizagent-writer-claim.lock`, JSON.stringify({
    pid: 2147483647, hostname: hostname(), createdAt: new Date().toISOString(), token: 'stale',
  }))
  await assert.rejects(RuntimeWriterGuard.acquire([root]), /recovery claim is stale/)
})
