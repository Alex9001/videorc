import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  createReleaseControlStore,
  probeControlStore,
  submitReleaseIntent
} from './release-control-store.mjs'
import { identity } from './release-test-fixtures.mjs'
const config = (name) => ({
  accessKeyId: 'test',
  secretAccessKey: 'test-only',
  bucket: name,
  region: 'test-1',
  endpointUrl: `https://${name}.example.invalid`,
  forcePathStyle: true
})
function transport({ denyWrites = false } = {}) {
  const objects = new Map(),
    calls = []
  return {
    objects,
    calls,
    close() {},
    async request(url, options) {
      calls.push({ url, ...options })
      const target = new URL(url)
      const key = decodeURIComponent(target.pathname.split('/').slice(2).join('/'))
      if (target.searchParams.has('list-type')) {
        const prefix = target.searchParams.get('prefix')
        const keys = [...objects.keys()].filter((entry) => entry.startsWith(prefix)).sort()
        const offset = Number(target.searchParams.get('continuation-token') ?? 0)
        const slice = keys.slice(offset, offset + 1)
        const next =
          offset + 1 < keys.length
            ? `<IsTruncated>true</IsTruncated><NextContinuationToken>${offset + 1}</NextContinuationToken>`
            : '<IsTruncated>false</IsTruncated>'
        return new Response(
          `<ListBucketResult>${slice.map((entry) => `<Contents><Key>${encodeURIComponent(entry)}</Key></Contents>`).join('')}${next}</ListBucketResult>`
        )
      }
      const old = objects.get(key)
      if (options.method === 'PUT') {
        if (denyWrites) return new Response('', { status: 403 })
        const headers = new Headers(options.headers)
        if (
          (headers.get('if-none-match') === '*' && old) ||
          (headers.get('if-match') && headers.get('if-match') !== old?.etag)
        )
          return new Response('', { status: 412 })
        const body = String(options.body)
        const etag = `"${createHash('sha256').update(body).digest('hex')}"`
        objects.set(key, { body, etag })
        return new Response('', { headers: { etag } })
      }
      return old
        ? new Response(old.body, { headers: { etag: old.etag } })
        : new Response('', { status: 404 })
    }
  }
}
test('real signed adapter routes state authority and intent data to different stores', async () => {
  const state = transport(),
    data = transport()
  const store = createReleaseControlStore({
    config: config('state'),
    dataConfig: config('data'),
    prefix: 'videorc-release-control/staging-test',
    transport: state,
    dataTransport: data
  })
  await probeControlStore(store)
  for (const id of ['operation-one', 'operation-two'])
    await submitReleaseIntent(store, {
      id,
      type: 'activate',
      expectedRevision: 0,
      identity: identity()
    })
  assert.deepEqual(await store.list('intents/'), [
    'intents/operation-one.json',
    'intents/operation-two.json'
  ])
  assert.equal(
    [...state.objects.keys()].some((key) => key.includes('/intents/')),
    false
  )
  assert.equal(
    [...data.objects.keys()].some((key) => key.endsWith('/capability.json')),
    false
  )
  assert.ok(
    data.calls.some(({ url }) => new URL(url).searchParams.get('continuation-token') === '1')
  )
})
test('worker state key cannot write state while its separate inbox key can append intent', async () => {
  const state = transport({ denyWrites: true }),
    data = transport()
  const store = createReleaseControlStore({
    config: config('state'),
    dataConfig: config('data'),
    prefix: 'videorc-release-control/staging-test',
    transport: state,
    dataTransport: data
  })
  await submitReleaseIntent(store, {
    id: 'operation-one',
    type: 'activate',
    expectedRevision: 0,
    identity: identity()
  })
  await assert.rejects(store.write('state.json', { revision: 999 }), { code: 'control-write' })
  assert.equal(data.objects.size, 1)
})
