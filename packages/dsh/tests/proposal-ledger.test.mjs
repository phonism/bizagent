import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LearningLedger } from '../lib/ledger.js'

class Table {
  values = new Map()
  get(key) { return this.values.get(key) }
  entries() { return new Map(this.values).entries() }
  async put(key, value) { this.values.set(key, structuredClone(value)) }
}
class Domain {
  tables = new Map()
  table(name) {
    if (!this.tables.has(name)) this.tables.set(name, new Table())
    return this.tables.get(name)
  }
  async close() {}
}

test('memory proposal freezes its target baseline and first decision in the durable ledger', async () => {
  const domain = new Domain()
  const ledger = await LearningLedger.open({ async open() { return domain } })
  const pending = { id: 'proposal-1', fromAddress: 'personal:alice', toAddress: 'role:analyst',
    proposedKind: 'knowledge', description: 'Use matched cohorts', body: 'Match cohorts by signup week.',
    tags: ['cohort'], sourceRefs: [{ type: 'artifact', uri: 'test:cohort', digest: 'source-1' }],
    baseAsset: { id: 'asset-1', revision: 2, bodySha256: 'a'.repeat(64) },
    status: 'pending', createdAt: '2026-09-27T00:00:00.000Z' }
  await ledger.putProposal(pending)
  await ledger.putProposal(pending)
  await assert.rejects(() => ledger.putProposal({ ...pending,
    baseAsset: { ...pending.baseAsset, revision: 3 } }), /identity changed/)
  const accepted = { ...pending, status: 'accepted', targetAssetId: 'asset-1',
    appliedAssetRevision: 3, appliedBodySha256: 'b'.repeat(64),
    decidedAt: '2026-09-27T01:00:00.000Z' }
  await ledger.putProposal(accepted)
  await ledger.putProposal(accepted)
  await assert.rejects(() => ledger.putProposal({ ...accepted, decision: 'changed later' }), /decision is immutable/)
  assert.deepEqual(ledger.getProposal(pending.id), accepted)
})

test('human publication review is durable before asset application and cannot be replaced', async () => {
  const ledger = await LearningLedger.open({ async open() { return new Domain() } })
  const pending = { id: 'proposal-human', fromAddress: 'personal:alice', toAddress: 'role:analyst',
    proposedKind: 'method', description: 'Matched cohorts', body: 'Match signup week.', tags: [],
    sourceRefs: [{ type: 'artifact', uri: 'test:cohort', digest: 'source-1' }],
    status: 'pending', createdAt: '2026-09-27T00:00:00.000Z' }
  const humanReview = { reviewerId: 'reviewer-1', authorityRef: 'role-owner:reviewer-1',
    action: 'accept', decision: 'Reviewed.', reviewedAt: '2026-09-27T01:00:00.000Z' }
  await ledger.putProposal(pending)
  await ledger.putProposal({ ...pending, humanReview })
  await assert.rejects(() => ledger.putProposal({ ...pending, humanReview: {
    ...humanReview, reviewerId: 'reviewer-2' } }), /human review is immutable/)
  await assert.rejects(() => ledger.putProposal(pending), /human review is immutable/)
  const accepted = { ...pending, humanReview, status: 'accepted', targetAssetId: 'method-human',
    appliedAssetRevision: 1, appliedBodySha256: 'a'.repeat(64),
    decision: humanReview.decision, decidedAt: humanReview.reviewedAt }
  await ledger.putProposal(accepted)
  assert.deepEqual(ledger.getProposal(pending.id), accepted)
})
