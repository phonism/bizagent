import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import { nowIso } from './domain.js'
import { writeFileDurably } from './safe-file.js'

const ORGANIZATION_ID = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)

export const ActiveOrganizationLocationSchema = z.object({
  schemaVersion: z.literal(1),
  workspacePath: z.string().min(1),
  organizationId: ORGANIZATION_ID,
  organizationRoot: z.string().min(1),
  updatedAt: z.string().min(1),
})

export type ActiveOrganizationLocation = z.infer<typeof ActiveOrganizationLocationSchema>

export function activeOrganizationLocationPath(registryRoot: string): string {
  return join(resolve(registryRoot), 'active-organization.yaml')
}

export function organizationLocation(workspacePath: string, organizationId: string): ActiveOrganizationLocation {
  const trimmedWorkspace = workspacePath.trim()
  if (!isAbsolute(trimmedWorkspace)) throw new Error('DSH Workspace path must be absolute')
  const workspace = resolve(trimmedWorkspace)
  const id = ORGANIZATION_ID.parse(organizationId.trim().toLocaleLowerCase())
  const organizationRoot = resolve(workspace, 'bizagent', id)
  const rel = relative(workspace, organizationRoot)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('organization directory escapes the DSH Workspace')
  return ActiveOrganizationLocationSchema.parse({
    schemaVersion: 1,
    workspacePath: workspace,
    organizationId: id,
    organizationRoot,
    updatedAt: nowIso(),
  })
}

export async function loadActiveOrganizationLocation(registryRoot: string): Promise<ActiveOrganizationLocation | undefined> {
  let raw: unknown
  try {
    raw = YAML.parse(await readFile(activeOrganizationLocationPath(registryRoot), 'utf8'))
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
  const location = ActiveOrganizationLocationSchema.parse(raw)
  const expected = organizationLocation(location.workspacePath, location.organizationId)
  if (expected.organizationRoot !== resolve(location.organizationRoot)) {
    throw new Error(`active organization root does not match its Workspace and id: ${location.organizationRoot}`)
  }
  return { ...location, organizationRoot: expected.organizationRoot, workspacePath: expected.workspacePath }
}

export async function saveActiveOrganizationLocation(
  registryRoot: string,
  location: ActiveOrganizationLocation,
): Promise<void> {
  await writeFileDurably(activeOrganizationLocationPath(registryRoot), YAML.stringify(location, { lineWidth: 0 }))
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
