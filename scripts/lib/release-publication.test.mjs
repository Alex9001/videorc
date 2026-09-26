import test from 'node:test'
import assert from 'node:assert/strict'
import {
  finalizePublication,
  inlinePublicationArtifact,
  stageImmutableArtifacts,
  publishImmutableWithRetry,
  exactPublishedChangelog,
  assertMonotonicPointer
} from './release-publication.mjs'
import { harness, ready } from './release-test-fixtures.mjs'
import { applyReleaseOperation } from './release-state.mjs'
const entry = (version = '1.2.3-alpha.1') => ({
  version,
  date: '2026-09-26',
  channel: 'alpha',
  platforms: ['windows', 'linux'],
  title: 'Video release',
  summary: 'Useful video tools.',
  highlights: ['Smooth capture'],
  body: 'Improved video capture.'
})
test('exact changelog publishes Windows only, later widens Linux without changing copy', () => {
  const first = exactPublishedChangelog({
    canonicalEntry: entry(),
    verifiedPlatforms: ['windows'],
    generatedAt: '2026-09-26T00:00:00Z'
  })
  assert.deepEqual(first.entries[0].platforms, ['windows'])
  const next = exactPublishedChangelog({
    canonicalEntry: entry(),
    remoteDocument: first,
    verifiedPlatforms: ['linux', 'windows'],
    generatedAt: '2026-09-26T00:00:00Z'
  })
  assert.deepEqual(next.entries[0].platforms, ['windows', 'linux'])
  assert.equal(next.entries[0].body, first.entries[0].body)
  assert.deepEqual(
    exactPublishedChangelog({
      canonicalEntry: entry(),
      remoteDocument: next,
      verifiedPlatforms: ['windows', 'linux'],
      generatedAt: next.generatedAt
    }),
    next
  )
  assert.throws(
    () =>
      exactPublishedChangelog({
        canonicalEntry: entry(),
        remoteDocument: next,
        verifiedPlatforms: ['windows'],
        generatedAt: next.generatedAt
      }),
    /cannot be removed/
  )
  assert.throws(
    () =>
      exactPublishedChangelog({
        canonicalEntry: entry(),
        verifiedPlatforms: ['macos'],
        generatedAt: first.generatedAt
      }),
    /platform|platforms/
  )
  assert.throws(
    () =>
      exactPublishedChangelog({
        canonicalEntry: { ...entry(), body: 'Changed copy' },
        remoteDocument: first,
        verifiedPlatforms: ['windows'],
        generatedAt: first.generatedAt
      }),
    /conflicts/
  )
})
test('pointer checks reject delayed older release on a mirror, even if primary is older', () => {
  assert.throws(
    () =>
      assertMonotonicPointer({
        current: 'version: 1.2.4\n',
        next: 'version: 1.2.3\n',
        objectKey: 'updates/windows/latest.yml'
      }),
    { code: 'pointer-regression' }
  )
  assert.throws(
    () =>
      assertMonotonicPointer({
        current: '{"bundleVersion":"1.2.3","sha256":"a"}',
        next: '{"bundleVersion":"1.2.3","sha256":"b"}',
        objectKey: 'releases/windows/latest/release.json'
      }),
    { code: 'pointer-identity' }
  )
})
test('bounded immutable retry reconciles lost response and never retries changed bytes', async () => {
  let puts = 0
  const artifact = { immutable: true }
  const result = await publishImmutableWithRetry({
    artifact,
    config: {},
    publish: async () => {
      puts++
      throw new Error('response lost')
    },
    inspect: async () => ({ state: 'identical' })
  })
  assert.equal(result.action, 'reconciled')
  assert.equal(puts, 1)
  await assert.rejects(
    publishImmutableWithRetry({
      artifact,
      config: {},
      publish: async () => {
        throw new Error('response lost')
      },
      inspect: async () => ({ state: 'different' })
    }),
    { code: 'immutable-collision' }
  )
})
for (let failureAfter = 1; failureAfter <= 4; failureAfter++)
  test(`publication resumes same generation after uncertain PUT ${failureAfter}`, async () => {
    const h = harness()
    ready(h)
    const objects = new Map()
    const writes = []
    let count = 0
    let fail = true
    const artifacts = [
      inlinePublicationArtifact({
        objectKey: 'updates/windows/latest.yml',
        value: { fake: 'not yaml' },
        label: 'feed-manifest'
      }),
      inlinePublicationArtifact({
        objectKey: 'releases/windows/latest/release.json',
        value: { bundleVersion: '1.2.3' },
        label: 'latest-manifest'
      })
    ]
    artifacts[0] = { ...artifacts[0], body: Buffer.from('version: 1.2.3\n') }
    const options = {
      requestId: 'request-one',
      platform: 'windows',
      artifacts,
      origins: [
        { name: 'primary', config: { name: 'primary' } },
        { name: 'mirror', config: { name: 'mirror' } }
      ],
      primaryName: 'primary',
      claim: async () => h.apply('claim', {}, { eligible: true }).result.claim,
      readRemote: async (origin, key) => objects.get(`${origin.name}/${key}`) ?? null,
      writeIntent: async (receipt) => writes.push(receipt),
      writeComplete: async () => {},
      publish: async ({ artifact, config }) => {
        objects.set(`${config.name}/${artifact.objectKey}`, artifact.body)
        if (fail && ++count === failureAfter) throw new Error('lost PUT response')
        return { verification: { state: 'identical' } }
      },
      complete: async (publication) => h.apply('published', {}, { publication }),
      unknown: async () => h.apply('publication-unknown')
    }
    await assert.rejects(finalizePublication(options), /lost PUT/)
    assert.equal(h.state.publication.status, 'unknown')
    h.apply('recover-publication', {}, { inspected: true, generation: 1 })
    fail = false
    await finalizePublication(options)
    assert.equal(h.state.requests['request-one'].platforms.windows.publication.generation, 1)
    assert.equal(writes[0].origin, 'mirror')
    assert.equal(objects.size, 4)
  })
test('immutable staging never exceeds three concurrent uploads and verifies every file', async () => {
  let active = 0
  let max = 0
  let calls = 0
  const artifacts = Array.from({ length: 10 }, (_, i) => ({
    label: `file-${i}`,
    objectKey: `release/${i}`,
    immutable: true,
    sha256: 'a'.repeat(64),
    sizeBytes: 1
  }))
  await stageImmutableArtifacts({
    artifacts,
    origins: [{ name: 'primary', config: {} }],
    publish: async () => {
      active++
      max = Math.max(max, active)
      await new Promise((resolve) => setImmediate(resolve))
      active--
      calls++
      return { verification: { state: 'identical' } }
    }
  })
  assert.equal(max, 3)
  assert.equal(calls, 10)
})
