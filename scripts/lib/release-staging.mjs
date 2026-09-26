import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import {
  buildSignedS3Request,
  createReleaseUploadS3Transport,
  publishReleaseUploadArtifact
} from './release-upload-s3.mjs'
import { requireRelease } from './release-github.mjs'
import { releaseDigest, RELEASE_POLICY_VERSION } from './release-state.mjs'

export async function stagePrivateBundle({
  store,
  config,
  prefix,
  identity,
  platform,
  artifacts,
  canonicalEntry,
  acceptance,
  manifestHash
}) {
  const staged = []
  for (const artifact of artifacts) {
    const objectKey = `${prefix}/payload/${identity.id}/${platform}/${artifact.sha256}`
    await publishReleaseUploadArtifact({
      artifact: { ...artifact, label: 'private-payload', immutable: true, objectKey },
      config
    })
    staged.push({
      label: artifact.label,
      objectKey: artifact.objectKey,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      contentType: artifact.contentType,
      immutable: artifact.immutable,
      privateKey: objectKey
    })
  }
  const document = {
    schemaVersion: 1,
    policyVersion: RELEASE_POLICY_VERSION,
    requestId: identity.id,
    sourceSha: identity.sourceSha,
    releaseId: identity.releaseIds[platform],
    platform,
    manifestHash,
    canonicalEntry,
    artifacts: staged
  }
  await store.write(`bundles/${identity.id}/${platform}.json`, document)
  if (acceptance)
    await store.write(`evidence/${identity.id}/${platform}/acceptance.json`, acceptance)
  return document
}

export async function downloadStagedBundle({ document, config, outputDir, prefix, request }) {
  requireRelease(
    document.schemaVersion === 1 &&
      document.requestId === request.id &&
      document.sourceSha === request.sourceSha &&
      document.releaseId === request.releaseIds[document.platform],
    'bundle-identity',
    'Private staging bundle differs from frozen request.'
  )
  requireRelease(
    document.canonicalEntry?.version === document.releaseId &&
      document.canonicalEntry.platforms.includes(document.platform),
    'bundle-changelog',
    'Staged changelog entry must be exact.'
  )
  const transport = createReleaseUploadS3Transport({ config })
  const files = []
  try {
    for (const artifact of document.artifacts) {
      requireRelease(
        artifact.privateKey ===
          `${prefix}/payload/${request.id}/${document.platform}/${artifact.sha256}` &&
          /^[a-f0-9]{64}$/.test(artifact.sha256) &&
          Number.isSafeInteger(artifact.sizeBytes) &&
          artifact.sizeBytes > 0 &&
          artifact.sizeBytes <= 4 * 1024 ** 3,
        'bundle-artifact',
        'Invalid staged artifact identity.'
      )
      const path = join(outputDir, artifact.sha256)
      await mkdir(dirname(path), { recursive: true })
      const signed = buildSignedS3Request({ config, method: 'GET', objectKey: artifact.privateKey })
      const response = await transport.request(signed.url, {
        method: 'GET',
        headers: signed.headers
      })
      requireRelease(
        response.ok,
        'bundle-download',
        `Staging download failed with HTTP ${response.status}.`
      )
      const output = createWriteStream(path)
      const hash = createHash('sha256')
      let size = 0
      const deadline = setTimeout(() => {
        response.body?.destroy?.(new Error('Staging download deadline exceeded.'))
        output.destroy(new Error('Staging download deadline exceeded.'))
      }, 600_000)
      try {
        for await (const chunk of response.body) {
          size += chunk.byteLength
          requireRelease(
            size <= artifact.sizeBytes,
            'bundle-size',
            'Staged artifact is larger than manifest.'
          )
          hash.update(chunk)
          if (!output.write(chunk)) await once(output, 'drain')
        }
        output.end()
        await once(output, 'finish')
        requireRelease(
          size === artifact.sizeBytes && hash.digest('hex') === artifact.sha256,
          'bundle-hash',
          'Staged bytes do not match the signed candidate.'
        )
      } catch (error) {
        output.destroy()
        await rm(path, { force: true })
        throw error
      } finally {
        clearTimeout(deadline)
      }
      files.push({ ...artifact, path })
    }
  } finally {
    transport.close()
  }
  return files
}

export async function publicationPlanDocument({
  requestId,
  platform,
  manifestHash,
  artifacts,
  canonicalEntry,
  immutableReceipts
}) {
  const descriptors = []
  for (const artifact of artifacts) {
    const { label, objectKey, sha256, sizeBytes, immutable, contentType } = artifact
    const descriptor = { label, objectKey, sha256, sizeBytes, immutable, contentType }
    if (!immutable) {
      requireRelease(
        sizeBytes <= 2 * 1024 * 1024,
        'pointer-size',
        'Pointer exceeds bounded finalization size.'
      )
      descriptor.bodyBase64 = (artifact.body ?? (await readFile(artifact.path))).toString('base64')
    }
    descriptors.push(descriptor)
  }
  return {
    schemaVersion: 1,
    requestId,
    platform,
    manifestHash,
    artifacts: descriptors,
    canonicalEntry,
    immutableReceipts,
    digest: releaseDigest(descriptors)
  }
}

export function restorePublicationPlan(document) {
  requireRelease(
    releaseDigest(document.artifacts) === document.digest,
    'publication-plan-digest',
    'Durable publication plan changed.'
  )
  return document.artifacts.map((artifact) => {
    if (artifact.immutable) return artifact
    const body = Buffer.from(artifact.bodyBase64, 'base64')
    requireRelease(
      body.byteLength === artifact.sizeBytes &&
        createHash('sha256').update(body).digest('hex') === artifact.sha256,
      'publication-plan-body',
      'Durable pointer bytes changed.'
    )
    return { ...artifact, body }
  })
}
