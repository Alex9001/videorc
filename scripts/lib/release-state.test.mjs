import test from 'node:test'
import assert from 'node:assert/strict'
import { newReleaseState, applyReleaseOperation, RELEASE_POLICY_VERSION } from './release-state.mjs'
import { validateReleaseOperation } from './release-operation.mjs'
import { identity, harness, ready } from './release-test-fixtures.mjs'
test('duplicate operation is idempotent; reused IDs and versions fail closed', () => {
  const h = harness()
  const first = h.activate()
  const op = {
    id: 'operation-1',
    expectedRevision: 0,
    type: 'activate',
    requestId: 'request-one',
    platform: 'windows',
    identity: identity()
  }
  assert.equal(applyReleaseOperation(h.state, op, { identity: identity() }).replay, true)
  assert.throws(() => applyReleaseOperation(h.state, { ...op, expectedRevision: 9 }), {
    code: 'operation-id-reused'
  })
  assert.equal(h.activate('request-two').result.code, 'same-version-conflict')
  assert.equal(first.result.status, 'applied')
})
test('stale callback is durable rejection, never applied to a newer request', () => {
  const h = harness()
  h.activate()
  const result = h.apply('dispatch', { stage: 'build', expectedRevision: 0 })
  assert.equal(result.result.code, 'stale-revision')
  assert.equal(h.state.requests['request-one'].platforms.windows.phase, 'preparing')
})
test('activation before claim blocks old publication', () => {
  const h = harness()
  ready(h)
  h.activate('request-two', '1.2.4')
  assert.equal(h.apply('claim', {}, { eligible: true }).result.code, 'superseded')
})
test('activation after claim preserves transaction through verified production', () => {
  const h = harness()
  ready(h)
  h.apply('claim', {}, { eligible: true })
  h.activate('request-two', '1.2.4')
  assert.equal(h.state.publication.requestId, 'request-one')
  assert.equal(h.apply('cancel').result.code, 'publication-in-progress')
  h.apply('published', {}, { publication: { generation: 1 } })
  h.apply('production', {}, { production: { complete: true } })
  assert.equal(h.state.requests['request-one'].platforms.windows.phase, 'live')
  assert.equal(h.state.active.windows, 'request-two')
})
test('unknown publication blocks every next generation', () => {
  const h = harness()
  ready(h)
  h.apply('claim', {}, { eligible: true })
  h.apply('publication-unknown')
  assert.equal(h.apply('claim', {}, { eligible: true }).result.code, 'publication-unreconciled')
})
test('only one caller obtains dispatch side-effect lease', () => {
  const h = harness()
  h.activate()
  h.apply('dispatch', { stage: 'build' })
  assert.equal(h.apply('dispatch-start', { stage: 'build' }).result.status, 'applied')
  assert.equal(h.apply('dispatch-start', { stage: 'build' }).result.status, 'duplicate')
})
test('rejects credential-shaped or unbounded fields before persisting an intent', () => {
  const op = { id: 'operation-good', type: 'activate', expectedRevision: 0, identity: identity() }
  assert.doesNotThrow(() => validateReleaseOperation(op))
  assert.throws(() => validateReleaseOperation({ ...op, token: 'secret' }), {
    code: 'operation-fields'
  })
  assert.throws(
    () => validateReleaseOperation({ ...op, identity: { ...op.identity, token: 'secret' } }),
    { code: 'request-fields' }
  )
})
test('late candidate and acceptance callbacks do not regress verified live platform', () => {
  const h = harness()
  ready(h)
  h.apply('claim', {}, { eligible: true })
  h.apply('published', {}, { publication: { generation: 1 } })
  h.apply('production', {}, { production: { complete: true } })
  assert.equal(
    h.apply('signed', {}, { manifestHash: 'c'.repeat(64), artifacts: [{}] }).result.status,
    'duplicate'
  )
  assert.equal(
    h.apply(
      'acceptance',
      {},
      { status: 'PASS', sourceSha: 'a'.repeat(40), releaseId: '1.2.3-alpha.1' }
    ).result.status,
    'duplicate'
  )
  assert.equal(h.state.requests['request-one'].platforms.windows.phase, 'live')
  assert.throws(() => h.apply('claim', {}, { eligible: true }), { code: 'publication-ineligible' })
})
test('new activation after publish preserves old production verification until newer publication', () => {
  const h = harness()
  ready(h)
  h.apply('claim', {}, { eligible: true })
  h.apply('published', {}, { publication: { generation: 1 } })
  h.activate('request-two', '1.2.4')
  h.apply('production', {}, { production: { complete: true } })
  assert.equal(h.state.requests['request-one'].platforms.windows.phase, 'live')
})
test('explicit unsigned retry abandons ambiguous send without permitting another signing identity', () => {
  const h = harness()
  h.activate()
  h.apply('dispatch', { stage: 'build' })
  h.apply('dispatch-start', { stage: 'build' })
  h.apply('retry-build')
  assert.equal(
    h.state.requests['request-one'].platforms.windows.dispatches.build.correlation,
    'request-one-build-2'
  )
  h.apply('dispatch', { stage: 'sign' })
  assert.throws(() => h.apply('retry-build'), { code: 'retry-build-ineligible' })
})

test('cancel does not undo a public generation awaiting route verification', () => {
  const h = harness()
  ready(h)
  h.apply('claim', {}, { eligible: true })
  h.apply('published', {}, { publication: { generation: 1 } })
  h.apply('cancel')
  assert.equal(h.state.requests['request-one'].platforms.windows.phase, 'verifying')
  h.apply('production', {}, { production: { complete: true } })
  assert.equal(h.state.requests['request-one'].platforms.windows.phase, 'live')
})
