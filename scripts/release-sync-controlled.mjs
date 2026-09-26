import { workerOperation } from './lib/release-control-client.mjs'
import { createReleaseGithub } from './lib/release-github.mjs'
import { createReleaseControlStore, controlStoreConfig } from './lib/release-control-store.mjs'
import { requireRelease } from './lib/release-github.mjs'
import { resolveReleaseUploadOrigins } from './lib/release-upload-origins.mjs'
import { copyObjects } from './sync-release-origins.mjs'
import { readRemoteTextObject } from './lib/windows-release-publication.mjs'
import { buildSignedS3Request, createReleaseUploadS3Transport } from './lib/release-upload-s3.mjs'
import { releaseDigest } from './lib/release-state.mjs'

async function main() {
  const phase = process.argv[2]
  requireRelease(
    process.env.GITHUB_REF === 'refs/heads/main' &&
      process.env.VIDEORC_RELEASE_CONTROLLER_ENABLED === 'true' &&
      process.env.GITHUB_WORKFLOW === 'Reconcile release origins',
    'sync-coordinator',
    'Mirror catch-up requires the protected shared publication lane.'
  )
  const store = createReleaseControlStore(controlStoreConfig())
  try {
    const state = (await store.read('state.json')).value
    requireRelease(
      !state.publication,
      'sync-publication-unresolved',
      'Reconcile the active or unknown publication generation before mirrors.'
    )
    const { origins, primaryName } = resolveReleaseUploadOrigins()
    const primary = origins.find(({ name }) => name === primaryName)
    const history = new Map()
    const pointers = new Map()
    for (const request of Object.values(state.requests))
      for (const [platform, phase] of Object.entries(request.platforms)) {
        if (!phase.publication) continue
        const document = (
          await store.read(`publication-plans/${request.identity.id}/${platform}-public.json`)
        ).value
        for (const artifact of document.artifacts) {
          if (artifact.immutable) history.set(artifact.objectKey, artifact.sha256)
          else if (
            phase.publication.generation === state.lastPublished[platform] &&
            artifact.objectKey !== 'changelog/changelog.json'
          )
            pointers.set(artifact.objectKey, artifact.sha256)
        }
      }
    requireRelease(
      pointers.size > 0,
      'sync-history',
      'No verified public generation exists to synchronize.'
    )
    const changelog = await readRemoteTextObject({
      config: primary.config,
      objectKey: 'changelog/changelog.json'
    })
    requireRelease(changelog, 'sync-changelog', 'Primary changelog is missing.')
    const { createHash } = await import('node:crypto')
    pointers.set('changelog/changelog.json', createHash('sha256').update(changelog).digest('hex'))
    for (const mirror of origins.filter(({ name }) => name !== primaryName)) {
      // Copy all missed immutable history first. Pointer bytes are selected from
      // the current published generation, never an old pending receipt.
      const preparedKey = `mirror-prepared/${mirror.name}/${releaseDigest({ generations: state.lastPublished, history: [...history] })}.json`
      if (phase === 'prepare') {
        await copyObjects({
          expected: history,
          immutableKeys: new Set(history.keys()),
          from: primary,
          to: mirror,
          objectKeys: [...history.keys()],
          strict: true
        })
        await store.write(preparedKey, { verified: true, generations: state.lastPublished })
        continue
      }
      requireRelease(
        phase === 'pointers' && (await store.read(preparedKey))?.value.verified,
        'mirror-preparation-stale',
        'Public generation changed or immutable catch-up is incomplete; rerun preparation outside the publication lane.'
      )
      const transport = createReleaseUploadS3Transport({ config: mirror.config })
      try {
        for (const [objectKey, sha256] of history) {
          const signed = buildSignedS3Request({ config: mirror.config, method: 'HEAD', objectKey })
          const response = await transport.request(signed.url, {
            method: 'HEAD',
            headers: signed.headers
          })
          response.body?.destroy?.()
          requireRelease(
            response.ok && response.headers.get('x-amz-meta-videorc-sha256') === sha256,
            'mirror-immutable-changed',
            'Prepared immutable history changed. Repeat preparation outside the lock.'
          )
        }
      } finally {
        transport.close()
      }
      await copyObjects({
        expected: pointers,
        from: primary,
        to: mirror,
        objectKeys: [...pointers.keys()],
        strict: true
      })
      const receipt = { origin: mirror.name, generations: state.lastPublished, verified: true }
      await store.write(`mirror-sync/${mirror.name}/${releaseDigest(receipt)}.json`, receipt)
      for (const request of Object.values(state.requests))
        for (const [platform, entry] of Object.entries(request.platforms)) {
          const generation = entry.publication?.generation
          if (!generation || generation !== state.lastPublished[platform]) continue
          await store.write(
            `evidence/${request.identity.id}/${platform}/mirror-${mirror.name}-${generation}.json`,
            { requestId: request.identity.id, generation, origin: mirror.name, verified: true }
          )
          await workerOperation(store, createReleaseGithub(), {
            type: 'mirror-synced',
            requestId: request.identity.id,
            platform,
            generation,
            origin: mirror.name
          })
        }
    }
    console.log('release-sync-controlled: PASS')
  } finally {
    store.close()
  }
}
main().catch((error) => {
  console.error(`release-sync-controlled: ${error.code ?? 'error'}: ${error.message}`)
  process.exitCode = 1
})
