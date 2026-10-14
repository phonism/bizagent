import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import { nowIso } from './domain.js'
import { assertKnownFormat } from './known-format.js'
import { writeFileDurably } from './safe-file.js'

const ORGANIZATION_ID = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)

/** Version 1 placed an organization at `<workspacePath>/bizagent/<id>` inside a DSH Workspace. */
const LocationV1Schema = z.object({
  schemaVersion: z.literal(1),
  workspacePath: z.string().min(1),
  organizationId: ORGANIZATION_ID,
  organizationRoot: z.string().min(1),
  updatedAt: z.string().min(1),
})

/** Version 2 places every organization at `<data root>/orgs/<id>`. */
const LocationV2Schema = z.object({
  schemaVersion: z.literal(2),
  organizationId: ORGANIZATION_ID,
  organizationRoot: z.string().min(1),
  updatedAt: z.string().min(1),
})

export const ActiveOrganizationLocationSchema = z.discriminatedUnion('schemaVersion', [LocationV1Schema, LocationV2Schema])

export type ActiveOrganizationLocation = z.infer<typeof ActiveOrganizationLocationSchema>

export function activeOrganizationLocationPath(registryRoot: string): string {
  return join(resolve(registryRoot), 'active-organization.yaml')
}

/** Where a new organization lives: `<data root>/orgs/<id>`. */
export function organizationLocation(registryRoot: string, organizationId: string): ActiveOrganizationLocation {
  const root = resolve(registryRoot)
  if (!isAbsolute(root)) throw new Error('BizAgent data root must be absolute')
  const id = ORGANIZATION_ID.parse(organizationId.trim().toLocaleLowerCase())
  return LocationV2Schema.parse({
    schemaVersion: 2,
    organizationId: id,
    organizationRoot: join(root, 'orgs', id),
    updatedAt: nowIso(),
  })
}

function legacyOrganizationRoot(workspacePath: string, organizationId: string): string {
  const trimmedWorkspace = workspacePath.trim()
  if (!isAbsolute(trimmedWorkspace)) throw new Error('DSH Workspace path must be absolute')
  const workspace = resolve(trimmedWorkspace)
  const organizationRoot = resolve(workspace, 'bizagent', organizationId)
  const rel = relative(workspace, organizationRoot)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('organization directory escapes the DSH Workspace')
  return organizationRoot
}

export async function loadActiveOrganizationLocation(registryRoot: string): Promise<ActiveOrganizationLocation | undefined> {
  let raw: unknown
  try {
    raw = YAML.parse(await readFile(activeOrganizationLocationPath(registryRoot), 'utf8'))
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
  assertKnownFormat(raw, 2, 'active-organization.yaml')
  const location = ActiveOrganizationLocationSchema.parse(raw)
  const expected = location.schemaVersion === 1
    ? legacyOrganizationRoot(location.workspacePath, location.organizationId)
    : organizationLocation(registryRoot, location.organizationId).organizationRoot
  if (expected !== resolve(location.organizationRoot)) {
    throw new Error(`active organization root does not match its expected location: ${location.organizationRoot}`)
  }
  return location.schemaVersion === 1
    ? { ...location, organizationRoot: expected, workspacePath: resolve(location.workspacePath) }
    : { ...location, organizationRoot: expected }
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
