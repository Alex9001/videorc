import { createHash } from 'node:crypto'
import { requireRelease } from './release-github.mjs'

export async function verifyProductionDownload({
  url,
  sha256,
  sizeBytes,
  cookie = null,
  fetchImpl = fetch
}) {
  let target = new URL(url)
  requireRelease(
    target.origin === 'https://www.videorc.com',
    'production-origin',
    'Production verification starts at the canonical website.'
  )
  let response
  for (let redirects = 0; redirects <= 10; redirects++) {
    response = await fetchImpl(target, {
      redirect: 'manual',
      signal: AbortSignal.timeout(600_000),
      headers: cookie && target.origin === 'https://www.videorc.com' ? { Cookie: cookie } : {}
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    requireRelease(location, 'production-redirect', 'Download redirect has no target.')
    target = new URL(location, target)
    requireRelease(
      target.protocol === 'https:',
      'production-tls',
      'Production download redirected away from HTTPS.'
    )
    await response.body?.cancel?.()
  }
  requireRelease(
    response.ok && response.body,
    'production-download',
    'Production route did not return downloadable bytes.'
  )
  let size = 0
  const hash = createHash('sha256')
  for await (const chunk of response.body) {
    size += chunk.byteLength
    requireRelease(size <= sizeBytes, 'production-size', 'Production bytes exceed expected size.')
    hash.update(chunk)
  }
  requireRelease(
    size === sizeBytes && hash.digest('hex') === sha256,
    'production-bytes',
    'Production route resolves to different bytes.'
  )
  return { status: 'PASS', sha256, sizeBytes } // Never persist final presigned URLs or cookies.
}

export function productionRoutes({ platform, artifacts }) {
  return artifacts
    .filter((artifact) =>
      ['feed-installer', 'feed-zip', 'feed-blockmap', 'feed-manifest'].includes(artifact.label)
    )
    .map((artifact) => ({
      ...artifact,
      url: `https://www.videorc.com/api/updates/${artifact.objectKey.split('/').at(-1)}`
    }))
}
