import { type AgentHome, type HomeAddress, isHomeAddress } from './domain.js'

export type HomeDirectoryEntry = Pick<AgentHome, 'address' | 'type' | 'displayName'>

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

export function visibleHomeDirectory(homes: readonly AgentHome[], primaryHome: HomeAddress): HomeDirectoryEntry[] {
  return homes
    .filter(home => home.status === 'active' && (home.type !== 'personal' || home.address === primaryHome))
    .map(({ address, type, displayName }) => ({ address, type, displayName }))
    .sort((a, b) => a.address.localeCompare(b.address))
}

export function searchHomeDirectory(homes: readonly AgentHome[], primaryHome: HomeAddress,
  query = '', limit = 20): HomeDirectoryEntry[] {
  const needle = normalize(query)
  return visibleHomeDirectory(homes, primaryHome)
    .filter(home => !needle || normalize(home.address).includes(needle)
      || normalize(home.displayName).includes(needle) || normalize(home.type).includes(needle))
    .slice(0, limit)
}

export function resolveHomeDirectoryTarget(homes: readonly AgentHome[], primaryHome: HomeAddress,
  target: string): HomeAddress {
  const visible = visibleHomeDirectory(homes, primaryHome)
  const name = normalize(target)
  if (!name) throw new Error('Home not found or inaccessible')
  // Canonical addresses take precedence over a Home with the same display name.
  const address = target.trim()
  if (isHomeAddress(address)) {
    if (visible.some(home => home.address === address)) return address
    throw new Error('Home not found or inaccessible')
  }
  const matches = visible.filter(home => normalize(home.displayName) === name)
  if (matches.length === 1) return matches[0]!.address
  if (matches.length > 1) {
    throw new Error(`ambiguous Home name; use a canonical address: ${matches.map(home => home.address).join(', ')}`)
  }
  throw new Error('Home not found or inaccessible')
}
