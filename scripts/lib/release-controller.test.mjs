import test from 'node:test'
import assert from 'node:assert/strict'
import {
  reconcileReleaseIntents,
  submitReleaseIntent,
  probeControlStore
} from './release-control-store.mjs'
import { releaseDigest } from './release-state.mjs'
import { ReleaseError } from './release-github.mjs'
import { identity, memoryStore } from './release-test-fixtures.mjs'
import { reconcileDispatch, reconcileSupersededBuilds } from './release-controller.mjs'
test('fresh controller resumes after state write, preserving one activation', async () => {
  const store = memoryStore({ crashAfterState: true })
  await probeControlStore(store)
  const operation = {
    id: 'operation-one',
    type: 'activate',
    expectedRevision: 0,
    identity: identity()
  }
  await submitReleaseIntent(store, operation)
  const verifyOperation = async () => ({ identity: identity() })
  await assert.rejects(reconcileReleaseIntents({ store, verifyOperation }), /process died/)
  const resumed = await reconcileReleaseIntents({
    store,
    verifyOperation: () => assert.fail('must reuse durable result')
  })
  assert.equal(resumed.revision, 1)
  assert.equal((await store.read('results/operation-one.json')).value.status, 'applied')
})
test('displaced pending apply keeps immutable intent available to reconciler', async () => {
  const store = memoryStore()
  await probeControlStore(store)
  const op = { id: 'operation-one', type: 'activate', expectedRevision: 0, identity: identity() }
  await submitReleaseIntent(store, op)
  await submitReleaseIntent(store, op)
  await assert.rejects(submitReleaseIntent(store, { ...op, expectedRevision: 4 }), {
    code: 'operation-id-reused'
  })
  const state = await reconcileReleaseIntents({
    store,
    verifyOperation: async () => ({ identity: identity() })
  })
  assert.equal(state.revision, 1)
})
test('concurrent platform callbacks record stale precondition for retry', async () => {
  const store = memoryStore()
  await probeControlStore(store)
  await submitReleaseIntent(store, {
    id: 'operation-activate',
    type: 'activate',
    expectedRevision: 0,
    identity: identity()
  })
  await reconcileReleaseIntents({ store, verifyOperation: async () => ({ identity: identity() }) })
  for (const platform of ['windows', 'macos'])
    await submitReleaseIntent(store, {
      id: `operation-${platform}`,
      type: 'dispatch',
      expectedRevision: 1,
      requestId: 'request-one',
      platform,
      stage: 'build'
    })
  const state = await reconcileReleaseIntents({ store, verifyOperation: async () => ({}) })
  assert.equal(
    Object.values(state.operations).filter((op) => op.code === 'stale-revision').length,
    1
  )
})
test('lost dispatch response is reconciled by correlation without another dispatch', async () => {
  const request = {
    identity: identity(),
    platforms: {
      windows: { dispatches: { build: { correlation: 'request-one-build', state: 'unknown' } } }
    }
  }
  const writes = []
  const github = {
    api: async (path, options) => {
      assert.equal(options, undefined)
      return { workflow_runs: [{ id: 99, run_attempt: 1, display_title: 'request-one-build' }] }
    }
  }
  const result = await reconcileDispatch({
    github,
    request,
    platform: 'windows',
    stage: 'build',
    stateRevision: 2,
    submit: async (operation) => writes.push(operation)
  })
  assert.equal(result.run.id, 99)
  assert.equal(writes[0].type, 'run')
})
test('unknown dispatch with no observed run never resends blindly', async () => {
  const request = {
    identity: identity(),
    platforms: {
      windows: { dispatches: { build: { correlation: 'request-one-build', state: 'unknown' } } }
    }
  }
  await assert.rejects(
    reconcileDispatch({
      github: { api: async () => ({ workflow_runs: [] }) },
      request,
      platform: 'windows',
      stage: 'build',
      submit: () => assert.fail(),
      stateRevision: 1
    }),
    { code: 'dispatch-missing' }
  )
})

test('explicit cancellation cleans only its exact unsigned workflow', async () => {
  const writes = []
  const run = {
    id: 42,
    run_attempt: 1,
    path: '.github/workflows/release-windows-alpha.yml',
    repository: { full_name: 'TheOrcDev/videorc' },
    event: 'workflow_dispatch',
    head_branch: 'main',
    display_title: 'request-one-build',
    status: 'in_progress'
  }
  const github = {
    api: async (path, options) => {
      if (options) {
        writes.push(path)
        return {}
      }
      if (path.endsWith('/jobs?per_page=100&page=1')) return { jobs: [] }
      if (path.endsWith('/pending_deployments')) return []
      return run
    }
  }
  await reconcileSupersededBuilds(github, {
    active: {},
    requests: {
      'request-one': {
        identity: identity(),
        platforms: {
          windows: {
            phase: 'superseded',
            dispatches: { build: { runId: 42, attempt: 1, correlation: 'request-one-build' } }
          }
        }
      }
    }
  })
  assert.deepEqual(writes, ['/repos/TheOrcDev/videorc/actions/runs/42/cancel'])
})

test('authoritative verifier permits recovery of the exact owned generation after supersession', async () => {
  const { createOperationVerifier } = await import('./release-controller.mjs')
  const { harness, ready } = await import('./release-test-fixtures.mjs')
  const h = harness()
  ready(h)
  h.apply('claim', {}, { eligible: true })
  h.apply('publication-unknown')
  h.activate('request-two', '1.2.4')
  h.apply('recover-publication', {}, { inspected: true, generation: 1 })
  const verify = createOperationVerifier({
    github: {
      api: async (path) =>
        path.includes('/compare/')
          ? { status: 'identical', merge_base_commit: { sha: 'a'.repeat(40) } }
          : { sha: 'a'.repeat(40) }
    },
    originIdentity: 'b'.repeat(64),
    readEvidence: async () => ({
      manifestHash: 'c'.repeat(64),
      sourceSha: 'a'.repeat(40),
      validated: true
    })
  })
  const operation = {
    type: 'claim',
    requestId: 'request-one',
    platform: 'windows',
    stage: 'public'
  }
  const verified = await verify(operation, h.state)
  assert.equal(h.apply('claim', { stage: 'public' }, verified).result.status, 'duplicate')
  assert.equal(h.state.publication.generation, 1)
  await assert.rejects(verify({ ...operation, stage: 'pilot' }, h.state), { code: 'superseded' })
})

test('malformed DATA inbox is quarantined before authority lookup and does not poison reconciliation', async () => {
  const store = memoryStore()
  await probeControlStore(store)
  await store.write('intents/000-invalid.json', { id: '../state', credential: 'never-in-snapshot' })
  const operation = {
    id: 'operation-valid',
    type: 'activate',
    expectedRevision: 0,
    identity: identity()
  }
  await submitReleaseIntent(store, operation)
  const state = await reconcileReleaseIntents({
    store,
    verifyOperation: async () => ({ identity: identity() })
  })
  assert.equal(state.revision, 1)
  assert.equal(JSON.stringify(state).includes('never-in-snapshot'), false)
  assert.equal((await store.list('results/')).length, 2)
})

test('mirror receipt applies only to current generation and clears durable pending origin', async () => {
  const { createOperationVerifier } = await import('./release-controller.mjs')
  const { harness, ready } = await import('./release-test-fixtures.mjs')
  const h = harness()
  ready(h)
  h.apply('claim', {}, { eligible: true })
  h.apply(
    'published',
    {},
    { publication: { generation: 1, origins: ['r2'], pendingOrigins: ['neon'] } }
  )
  const verify = createOperationVerifier({
    github: {
      api: async (path) =>
        path.includes('/compare/')
          ? { status: 'identical', merge_base_commit: { sha: 'a'.repeat(40) } }
          : { sha: 'a'.repeat(40) }
    },
    readEvidence: async () => ({
      verified: true,
      origin: 'neon',
      generation: 1,
      requestId: 'request-one'
    })
  })
  const op = {
    type: 'mirror-synced',
    requestId: 'request-one',
    platform: 'windows',
    generation: 1,
    origin: 'neon'
  }
  const verified = await verify(op, h.state)
  h.apply('mirror-synced', { generation: 1, origin: 'neon' }, verified)
  assert.deepEqual(h.state.requests['request-one'].platforms.windows.publication.pendingOrigins, [])
  assert.deepEqual(h.state.requests['request-one'].platforms.windows.publication.origins, [
    'r2',
    'neon'
  ])
  await assert.rejects(verify({ ...op, generation: 2 }, h.state), { code: 'mirror-stale' })
})
