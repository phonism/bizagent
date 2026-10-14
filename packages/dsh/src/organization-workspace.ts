import { realpathSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { BizAgentService } from './service.js'

/** The slice of DSH's host `workspaceRegistry` BizAgent uses to show its folders in the sidebar. */
export interface WorkspaceRegistryLike {
  list(): ReadonlyArray<{ readonly id: string; readonly path: string }>
  create(path: string, title?: string): Promise<{ readonly id: string; attachSession(sessionId: string): Promise<void> }>
  insertBefore(id: string, beforeId?: string): Promise<readonly string[]>
}

/** DSH's Workspace registry when this host composes one. */
export function workspaceRegistry(ctx: Context): WorkspaceRegistryLike | undefined {
  return (ctx as unknown as { get(name: string): unknown }).get('workspaceRegistry') as WorkspaceRegistryLike | undefined
}

/**
 * Show the active organization's folder as a DSH Workspace named after the organization. The first
 * time it is added it goes to the top of the sidebar; after that its place is the person's choice.
 */
export async function showOrganizationWorkspace(ctx: Context, service: BizAgentService): Promise<void> {
  const root = service.store.organizationRoot
  const organization = service.store.getOrganization()
  const registry = workspaceRegistry(ctx)
  if (root === undefined || organization === undefined || registry === undefined) return
  // The registry keeps canonical paths; a temporary folder may sit behind a symlink.
  let canonical = root
  try { canonical = realpathSync.native(root) } catch { /* created on registration */ }
  if (registry.list().some(workspace => workspace.path === canonical)) return
  const known = new Set(registry.list().map(workspace => workspace.id))
  const workspace = await registry.create(root, organization.name)
  if (known.has(workspace.id)) return
  const first = registry.list()[0]
  if (first !== undefined && first.id !== workspace.id) await registry.insertBefore(workspace.id, first.id)
}
