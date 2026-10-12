import { createServer } from 'node:http'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = await mkdtemp(join(await realpath(tmpdir()), 'bizagent-node-review-ui-'))
const bundle = join(root, 'bundle.js')
await build({ entryPoints: [new URL('./project-node-review-browser-fixture.tsx', import.meta.url).pathname],
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: bundle })
const script = await readFile(bundle)
const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Node review UI test</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>')
  } else if (pathname === '/bundle.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
    res.end(script)
  } else { res.writeHead(404); res.end() }
})
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`http://127.0.0.1:${server.address().port}\n`)
})
process.on('SIGINT', () => { server.close(); void rm(root, { recursive: true, force: true }) })
