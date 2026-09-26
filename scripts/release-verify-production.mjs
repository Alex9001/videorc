import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { createReleaseClient } from './lib/release-client.mjs'
import { requireRelease } from './lib/release-github.mjs'
import { verifyProductionDownload, productionRoutes } from './lib/release-production.mjs'
async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: { request: { type: 'string' }, platform: { type: 'string' } }
  })
  const client = createReleaseClient()
  const requestId = values.request ?? process.env.RELEASE_REQUEST_ID
  const platform = values.platform ?? process.env.RELEASE_PLATFORM
  const state = await client.snapshot()
  const request = state.requests[requestId]
  const phase = request?.platforms[platform]
  requireRelease(
    phase?.publication && phase.publication.generation === state.lastPublished?.[platform],
    'production-generation',
    'Production verification requires latest published generation.'
  )
  const artifacts = phase.publication.artifacts
  const routes = []
  for (const route of productionRoutes({ platform, artifacts }))
    routes.push({ label: route.label, ...(await verifyProductionDownload(route)) })
  const installer = artifacts.find(
    (artifact) => artifact.label === (platform === 'windows' ? 'installer' : 'dmg')
  )
  requireRelease(
    installer && process.env.VIDEORC_RELEASE_VERIFICATION_COOKIE,
    'signed-in-verification',
    'Provide an authorized signed-in verification session through the environment; never commit it.'
  )
  routes.push({
    label: 'signed-in-download',
    ...(await verifyProductionDownload({
      ...installer,
      url: `https://www.videorc.com/api/downloads/${platform}/latest`,
      cookie: process.env.VIDEORC_RELEASE_VERIFICATION_COOKIE
    }))
  })
  const page = await fetch(
    `https://www.videorc.com/releases/${request.identity.releaseIds[platform]}`,
    { signal: AbortSignal.timeout(30_000) }
  )
  requireRelease(
    page.ok && (await page.text()).includes(request.identity.releaseIds[platform]),
    'release-page',
    'Exact release page is unavailable.'
  )
  let mirrorRoute = phase.publication.pendingOrigins.length ? 'pending' : 'not-configured'
  if (phase.publication.origins.length > 1) {
    for (const route of productionRoutes({ platform, artifacts }))
      await verifyProductionDownload({
        ...route,
        url: route.url.replace('/api/updates/', '/api/updates/mirror/')
      })
    mirrorRoute = 'PASS'
  }
  const receipt = {
    requestId,
    platform,
    generation: phase.publication.generation,
    complete: true,
    routes,
    releasePage: 'PASS',
    origins: phase.publication.origins,
    mirrorRoute
  }
  await client.submit({
    id: randomUUID(),
    type: 'production',
    requestId,
    platform,
    expectedRevision: state.revision,
    production: receipt
  })
  console.log(
    JSON.stringify({
      requestId,
      platform,
      phase: 'live',
      pendingOrigins: phase.publication.pendingOrigins
    })
  )
}
main().catch((error) => {
  console.error(`production-verification: ${error.code ?? 'error'}: ${error.message}`)
  process.exitCode = 1
})
