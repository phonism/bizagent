import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { BizAgentUiPort } from './api.js'
import { frameReference } from '../frame-reference.js'

const SOURCE = 'bizagent-agent'
const HOME_ADDRESS = /^(business|role|capability):[a-z0-9][a-z0-9._/-]*$/i

type AgentReference = { sessionId: string; address: string }

function decodeReference(value: string): AgentReference {
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid Agent reference')
  const ref = parsed as Partial<AgentReference>
  if (typeof ref.sessionId !== 'string' || !ref.sessionId || typeof ref.address !== 'string'
    || !HOME_ADDRESS.test(ref.address)) throw new Error('Invalid Agent reference')
  return { sessionId: ref.sessionId, address: ref.address }
}

export function createAgentMentionSource(api: Pick<BizAgentUiPort, 'agentDirectory' | 'resolveAgentTarget'>): InputTriggerSource {
  return {
    trigger: '@', name: SOURCE, order: -10,
    async candidates(session, { query, signal }) {
      const directory = await api.agentDirectory(String(session.sessionId), query, signal)
      if (signal.aborted) return []
      const shared = directory.homes.filter(home => home.type !== 'personal')
      const names = new Map<string, number>()
      for (const home of shared) {
        const key = home.displayName.normalize('NFKC').toLowerCase()
        names.set(key, (names.get(key) ?? 0) + 1)
      }
      return shared.map(home => ({
        name: (names.get(home.displayName.normalize('NFKC').toLowerCase()) ?? 0) > 1
          ? home.address : home.displayName,
        description: `${home.type} · ${home.address}`,
        value: home.address,
      }))
    },
    onPick({ candidate, session }) {
      const address = candidate.value
      if (address === undefined || !HOME_ADDRESS.test(address)) return undefined
      const ref = JSON.stringify({ sessionId: String(session.sessionId), address })
      return { insert: {
        source: SOURCE,
        ref,
        label: candidate.name,
        clipboardText: `@${address}`,
      } }
    },
    codec: {
      clipboardText(ref) { return `@${decodeReference(ref).address}` },
      async serialize(ref, signal) {
        const { sessionId, address } = decodeReference(ref)
        const current = await api.resolveAgentTarget(sessionId, address, signal)
        if (current.address !== address || current.type === 'personal') throw new Error('Agent target is no longer available')
        return `@${address}\n${frameReference(address)}`
      },
    },
  }
}
