import { parseHomeAddress, stableId, type HomeAddress } from './domain.js'

/** One durable Principal per long-term Home. Ordinary DSH Sessions are not Principals. */
export function principalSessionId(address: string): string {
  return stableId('principal-session', parseHomeAddress(address))
}

export function projectMainAddress(projectId: string): `project:${string}` {
  if (!/^project-[a-f0-9]{20}$/.test(projectId)) throw new Error('invalid Project ID')
  return `project:${projectId}`
}

/** The Main is a separate Session and reuses the lead Agent's Home. */
export function projectMainSessionId(projectId: string): string {
  return stableId('project-main-session', projectMainAddress(projectId))
}

export interface AgentSessionAddress {
  kind: 'principal' | 'project-main'
  homeAddress: HomeAddress
  sessionId: string
  logicalAddress: string
  projectId?: string
}
