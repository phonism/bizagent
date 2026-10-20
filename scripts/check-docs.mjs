// Check local inline Markdown file links in public docs, without network access.
// Heading anchors, external URLs, reference-style links, and runtime files are out of scope.
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const files = [
  'README.md', 'README.en.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'SECURITY.md',
  'packages/dsh/README.md', 'packages/dsh/README.en.md',
  'packages/dsh/CHANGELOG.md',
].map(path => join(root, path))
for (const directory of [
  'packages/dsh/docs', 'packages/dsh/examples', 'assets/demo', '.github',
]) await collect(join(root, directory))

const failures = []
let checked = 0
for (const file of files) {
  const source = await readFile(file, 'utf8')
  let fence
  for (const [index, line] of source.split('\n').entries()) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined
      continue
    }
    if (fence) continue
    for (const match of line.matchAll(/!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g)) {
      const target = match[1] ?? match[2]
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue
      const path = target.split(/[?#]/, 1)[0]
      if (!path) continue
      checked++
      try {
        await access(resolve(dirname(file), decodeURIComponent(path)))
      } catch {
        failures.push(`${relative(root, file)}:${index + 1}: missing local target ${target}`)
      }
    }
  }
}
if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`Documentation links passed: ${checked} local targets in ${files.length} Markdown files.\n`)
}

async function collect(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await collect(path)
    else if (extname(entry.name) === '.md') files.push(path)
  }
}
