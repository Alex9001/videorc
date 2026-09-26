import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { requireRelease } from './release-github.mjs'
import { createReleaseControlStore } from './release-control-store.mjs'
import {
  publishReleaseUploadArtifact,
  inspectReleaseUploadArtifact,
  createReleaseUploadS3Transport
} from './release-upload-s3.mjs'
import {
  inlinePublicationArtifact,
  stageImmutableArtifacts,
  finalizePublication,
  assertMonotonicPointer
} from './release-publication.mjs'
import { readRemoteTextObject } from './windows-release-publication.mjs'

// Real isolated S3 transfers, not a mock provider. The CLI denies production
// destinations before invoking this helper; every key stays under its staging
// prefix. Dummy payloads cannot be mistaken for signed candidates.
export async function rehearseRemotePublication(configured) {
  const run = randomUUID()
  const origins = [
    { name: 'mirror', config: configured.dataConfig },
    { name: 'primary', config: configured.config }
  ]
  let faults = 0
  for (let failAfter = 1; failAfter <= 4; failAfter++) {
    const prefix = `${configured.prefix}/publication-rehearsal/${run}/put-${failAfter}`
    const payloadBody = Buffer.from('isolated rehearsal payload\n')
    const immutable = {
      label: 'dummy-payload',
      objectKey: `${prefix}/payload.bin`,
      body: payloadBody,
      sha256: createHash('sha256').update(payloadBody).digest('hex'),
      sizeBytes: payloadBody.byteLength,
      contentType: 'application/octet-stream',
      immutable: true
    }
    const pointers = ['feed', 'latest'].map((name) =>
      inlinePublicationArtifact({
        label: 'latest-manifest',
        objectKey: `${prefix}/${name}/release.json`,
        value: { bundleVersion: '999.0.1', payloadSha256: immutable.sha256 }
      })
    )
    const artifacts = [immutable, ...pointers]
    await stageImmutableArtifacts({ origins, artifacts })
    const store = createReleaseControlStore(configured)
    const claimKey = `rehearsals/${run}/put-${failAfter}-claim.json`
    let puts = 0
    let inject = true
    const callbacks = {
      claim: async () => {
        const current = await store.read(claimKey)
        requireRelease(
          !current || current.value.status === 'active',
          'rehearsal-claim-unknown',
          'Unknown generation must be inspected before resume.'
        )
        if (!current) await store.write(claimKey, { generation: 1, status: 'active' })
        return { generation: 1 }
      },
      readRemote: (origin, objectKey) => readRemoteTextObject({ config: origin.config, objectKey }),
      writeIntent: async (receipt) => {
        await store.write(
          `rehearsals/${run}/put-${failAfter}/${receipt.origin}-${receipt.objectKey.endsWith('/feed/release.json') ? 'feed' : 'latest'}-intent.json`,
          receipt
        )
      },
      writeComplete: async () => {},
      complete: async (receipt) => {
        const current = await store.read(claimKey)
        await store.write(claimKey, { generation: 1, status: 'complete', receipt }, current.etag)
      },
      unknown: async () => {
        const current = await store.read(claimKey)
        await store.write(claimKey, { generation: 1, status: 'unknown' }, current.etag)
      },
      publish: async (args) => {
        const result = await publishReleaseUploadArtifact(args)
        if (inject && ++puts === failAfter)
          throw new Error('Injected lost PUT response after server committed.')
        return result
      }
    }
    try {
      let interrupted = false
      try {
        await finalizePublication({
          requestId: `rehearsal-${run}`,
          platform: 'windows',
          artifacts,
          origins,
          primaryName: 'primary',
          ...callbacks
        })
      } catch (error) {
        requireRelease(
          error.message.includes('Injected lost PUT'),
          'rehearsal-unexpected-failure',
          'Remote rehearsal failed before its intended fault.'
        )
        interrupted = true
        faults++
      }
      requireRelease(
        interrupted && (await store.read(claimKey)).value.status === 'unknown',
        'rehearsal-interruption',
        'Fault did not leave a durable unknown generation.'
      )
      // A fresh process only needs private durable state and remote objects.
      for (const origin of origins)
        for (const artifact of pointers) {
          const remote = await readRemoteTextObject({
            config: origin.config,
            objectKey: artifact.objectKey
          })
          requireRelease(
            remote === null || Buffer.from(remote).equals(artifact.body),
            'rehearsal-recovery-conflict',
            'Remote pointer is neither absent nor exact intended bytes.'
          )
        }
      const current = await store.read(claimKey)
      await store.write(claimKey, { generation: 1, status: 'active' }, current.etag)
      inject = false
      await finalizePublication({
        requestId: `rehearsal-${run}`,
        platform: 'windows',
        artifacts,
        origins,
        primaryName: 'primary',
        ...callbacks
      })
      for (const origin of origins)
        for (const artifact of artifacts)
          requireRelease(
            (await inspectReleaseUploadArtifact({ config: origin.config, artifact })).state ===
              'identical',
            'rehearsal-publication',
            'Recovered generation has missing or changed bytes.'
          )
    } finally {
      store.close()
    }
  }
  // Exercise a real stale ETag on the provider by changing the object after GET
  // and before the conditional PUT. The original publisher must refuse it.
  const config = configured.config
  const key = `${configured.prefix}/publication-rehearsal/${run}/etag/release.json`
  const initial = inlinePublicationArtifact({ objectKey: key, value: { bundleVersion: '999.0.1' } })
  const next = inlinePublicationArtifact({ objectKey: key, value: { bundleVersion: '999.0.2' } })
  const overtaking = inlinePublicationArtifact({
    objectKey: key,
    value: { bundleVersion: '999.0.3' }
  })
  await publishReleaseUploadArtifact({ config, artifact: initial })
  const transport = createReleaseUploadS3Transport({ config })
  let raced = false
  try {
    let refused = false
    try {
      await publishReleaseUploadArtifact({
        config,
        artifact: next,
        transport: {
          request: async (url, options) => {
            if (options.method === 'PUT' && !raced) {
              raced = true
              await publishReleaseUploadArtifact({ config, artifact: overtaking })
            }
            return transport.request(url, options)
          }
        }
      })
    } catch (error) {
      refused = error.code === 'pointer-write-conflict'
    }
    requireRelease(
      refused &&
        (await inspectReleaseUploadArtifact({ config, artifact: overtaking })).state ===
          'identical',
      'rehearsal-etag',
      'Provider did not preserve the overtaking generation.'
    )
  } finally {
    transport.close()
  }
  // Mirror missed two generations: copy versioned history, then only current
  // generation 3. A delayed generation 2 is rejected before any pointer write.
  const mirrorConfig = configured.dataConfig
  for (const version of [1, 2, 3]) {
    const artifact = {
      ...inlinePublicationArtifact({
        objectKey: `${configured.prefix}/publication-rehearsal/${run}/history/${version}.json`,
        value: { bundleVersion: `999.0.${version}` }
      }),
      immutable: true
    }
    await publishReleaseUploadArtifact({ config, artifact })
    await publishReleaseUploadArtifact({ config: mirrorConfig, artifact })
  }
  await publishReleaseUploadArtifact({ config: mirrorConfig, artifact: overtaking })
  let regressionRefused = false
  try {
    assertMonotonicPointer({
      current: await readRemoteTextObject({ config: mirrorConfig, objectKey: key }),
      next: next.body,
      objectKey: key
    })
  } catch (error) {
    regressionRefused = error.code === 'pointer-regression'
  }
  requireRelease(
    regressionRefused,
    'rehearsal-mirror-regression',
    'Delayed mirror replay was not refused.'
  )
  return {
    lostPutResponsesRecovered: faults,
    staleEtag: 'PASS',
    missedTwoVersions: 'PASS',
    referencedArtifacts: 'PASS',
    signedBytes: 'dummy-only; real candidate rehearsal remains required'
  }
}
