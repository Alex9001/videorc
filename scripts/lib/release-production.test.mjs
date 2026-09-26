import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { verifyProductionDownload } from './release-production.mjs'
const body = Buffer.from('exact signed bytes')
const expected = {
  url: 'https://www.videorc.com/api/downloads/windows/latest',
  sha256: createHash('sha256').update(body).digest('hex'),
  sizeBytes: body.length
}
test('production redirect verifies exact bytes and never forwards the website cookie to storage', async () => {
  const calls = []
  const result = await verifyProductionDownload({
    ...expected,
    cookie: 'private-session',
    fetchImpl: async (url, options) => {
      calls.push([url.toString(), options.headers])
      return calls.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://storage.example/artifact?signature=secret' }
          })
        : new Response(body)
    }
  })
  assert.equal(result.status, 'PASS')
  assert.deepEqual(calls[1][1], {})
  assert.equal(JSON.stringify(result).includes('secret'), false)
})
test('production refuses insecure redirect and byte changes', async () => {
  await assert.rejects(
    verifyProductionDownload({
      ...expected,
      fetchImpl: async () =>
        new Response(null, { status: 302, headers: { location: 'http://storage.example/a' } })
    }),
    { code: 'production-tls' }
  )
  await assert.rejects(
    verifyProductionDownload({ ...expected, fetchImpl: async () => new Response('different') }),
    { code: 'production-bytes' }
  )
})
