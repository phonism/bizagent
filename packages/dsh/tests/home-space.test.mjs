import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { HomeSpace } from '../lib/home-space.js'
import { HomeStore } from '../lib/home-store.js'
import { loadActiveOrganizationLocation, organizationLocation,
  saveActiveOrganizationLocation } from '../lib/organization-location.js'
import { makeTempDir } from './temp-dir.mjs'

test('the personal space and the organization share one view, and the organization wins a shared address', async t => {
  const root = await makeTempDir('bizagent-home-space-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const personal = new HomeStore(root)
  const organization = new HomeStore(join(root, 'orgs', 'acme'))
  const space = new HomeSpace(personal, organization)
  await space.initialize()
  await space.createHome({ address: 'personal:me' }, 'personal')
  await space.createHome({ address: 'role:analyst' })
  assert.equal(personal.hasHome('personal:me'), true)
  assert.equal(organization.hasHome('role:analyst'), true)
  assert.deepEqual(space.listHomes().map(home => home.address), ['personal:me', 'role:analyst'])
  assert.equal(space.rootFor('personal:me'), root)
  assert.equal(space.rootFor('role:analyst'), organization.root)
  await assert.rejects(() => space.createHome({ address: 'role:analyst' }, 'personal'), /already exists outside/)
  assert.equal((await space.doctor()).ok, true)

  // A personal Home that arrives with the same address as an organization Home stays hidden.
  await personal.createHome({ address: 'role:analyst' })
  assert.equal(space.listHomes().length, 2)
  assert.equal(space.isPersonalHome('role:analyst'), false)
  const report = await space.doctor()
  assert.equal(report.ok, false)
  assert.match(report.issues.join('\n'), /personal Home role:analyst is hidden by the organization Home/)
})

test('organization locations: version 2 lives under orgs/, version 1 still loads, newer is refused', async t => {
  const root = await makeTempDir('bizagent-location-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const current = organizationLocation(root, 'Acme')
  assert.deepEqual({ ...current, updatedAt: undefined },
    { schemaVersion: 2, organizationId: 'acme', organizationRoot: join(root, 'orgs', 'acme'), updatedAt: undefined })
  await saveActiveOrganizationLocation(root, current)
  assert.deepEqual(await loadActiveOrganizationLocation(root), current)

  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const legacy = { schemaVersion: 1, workspacePath: workspace, organizationId: 'acme',
    organizationRoot: join(workspace, 'bizagent', 'acme'), updatedAt: '2026-09-03T00:00:00.000Z' }
  await saveActiveOrganizationLocation(root, legacy)
  assert.deepEqual(await loadActiveOrganizationLocation(root), legacy)

  await saveActiveOrganizationLocation(root, { ...current, organizationRoot: join(root, 'elsewhere') })
  await assert.rejects(() => loadActiveOrganizationLocation(root), /does not match its expected location/)
  await writeFile(join(root, 'active-organization.yaml'), 'schemaVersion: 3\norganizationId: acme\n')
  await assert.rejects(() => loadActiveOrganizationLocation(root), /format 3, written by a newer BizAgent/)
})
