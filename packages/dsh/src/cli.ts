#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { HomeStore } from './home-store.js'

const args = process.argv.slice(2)

try {
  await main(args)
} catch (error) {
  process.stderr.write(`bizagent: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseGlobalOptions(argv)
  const [command, ...rest] = parsed.args
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return
  }
  const store = new HomeStore(parsed.root)
  await store.initialize()

  switch (command) {
    case 'init': {
      const address = option(rest, '--default-home') ?? 'personal:default'
      const identityFile = option(rest, '--identity-file')
      const identity = identityFile === undefined ? undefined : await readFile(resolve(identityFile), 'utf8')
      const home = await store.createHome({ address, ...(identity !== undefined ? { identity } : {}) })
      print({ root: store.root, home })
      return
    }
    case 'home': {
      await homeCommand(store, rest)
      return
    }
    case 'doctor': {
      const report = await store.doctor()
      print(report)
      if (!report.ok) process.exitCode = 2
      return
    }
    case 'reindex': {
      await store.reload()
      print({ reindexed: true, root: store.root, homes: store.listHomes().length })
      return
    }
    default:
      throw new Error(`unknown command: ${command}`)
  }
}

async function homeCommand(store: HomeStore, argv: string[]): Promise<void> {
  const [subcommand, address] = argv
  switch (subcommand) {
    case 'list':
      print({ homes: store.listHomes() })
      return
    case 'create': {
      if (address === undefined || address.startsWith('--')) {
        throw new Error('home create requires a canonical address')
      }
      const name = option(argv.slice(2), '--name')
      const owner = option(argv.slice(2), '--owner')
      const identityFile = option(argv.slice(2), '--identity-file')
      const identity = identityFile === undefined ? undefined : await readFile(resolve(identityFile), 'utf8')
      const home = await store.createHome({
        address,
        ...(name !== undefined ? { displayName: name } : {}),
        ...(owner !== undefined ? { owner } : {}),
        ...(identity !== undefined ? { identity } : {}),
      })
      print({ home })
      return
    }
    default:
      throw new Error(`unknown home command: ${subcommand ?? '(missing)'}`)
  }
}

function parseGlobalOptions(argv: string[]): { root: string; args: string[] } {
  const result: string[] = []
  let root: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--root') {
      root = argv[index + 1]
      if (root === undefined) throw new Error('--root requires a path')
      index += 1
    } else if (value !== undefined) {
      result.push(value)
    }
  }
  const dshRoot = process.env['DSH_HOME']?.trim() || join(homedir(), '.dsh')
  return { root: resolve(root ?? join(dshRoot, 'bizagent')), args: result }
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printHelp(): void {
  process.stdout.write(`BizAgent v0.1-alpha.2\n\n`)
  process.stdout.write(`Usage:\n`)
  process.stdout.write(`  bizagent [--root PATH] init [--default-home ADDRESS] [--identity-file FILE]\n`)
  process.stdout.write(`  bizagent [--root PATH] home create ADDRESS [--name NAME] [--owner OWNER] [--identity-file FILE]\n`)
  process.stdout.write(`  bizagent [--root PATH] home list\n`)
  process.stdout.write(`  bizagent [--root PATH] doctor\n`)
  process.stdout.write(`  bizagent [--root PATH] reindex\n`)
}
