import { load } from 'js-yaml'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { requireRelease } from './release-github.mjs'
import {
  publishReleaseUploadArtifact,
  inspectReleaseUploadArtifact,
  partitionReleaseUploadArtifacts,
  orderReleaseUploadArtifacts
} from './release-upload-s3.mjs'
import { mergeChangelogDocuments } from './changelog.mjs'
import { compareNumericVersions, updateFeedVersionFromYml } from './windows-alpha-release.mjs'

export async function publishImmutableWithRetry({
  artifact,
  config,
  publish = publishReleaseUploadArtifact,
  inspect = inspectReleaseUploadArtifact,
  sleep = delay
}) {
  requireRelease(
    artifact.immutable === true,
    'immutable-required',
    'Retry helper accepts only immutable objects.'
  )
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await publish({ artifact, config })
    } catch (error) {
      if (['immutable-artifact-collision', 'invalid-upload-object-key'].includes(error.code))
        throw error
      // A lost PUT response may mean success. Inspect the exact bytes before any
      // bounded retry; a different object never gets overwritten.
      const remote = await inspect({ artifact, config })
      if (remote.state === 'identical') return { action: 'reconciled', verification: remote }
      requireRelease(
        remote.state === 'missing',
        'immutable-collision',
        'Uncertain upload found different immutable bytes.'
      )
      if (attempt === 2) throw error
      await sleep(500 * 2 ** attempt)
    }
  }
}

export async function stageImmutableArtifacts({
  artifacts,
  origins,
  publish = publishImmutableWithRetry,
  concurrency = 3,
  onVerified = () => {}
}) {
  requireRelease(
    Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 3,
    'upload-concurrency',
    'Immutable uploads allow one to three concurrent files.'
  )
  const { immutableArtifacts } = partitionReleaseUploadArtifacts(artifacts)
  const results = []
  for (const origin of origins) {
    let cursor = 0
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (cursor < immutableArtifacts.length) {
          const artifact = immutableArtifacts[cursor++]
          const result = await publish({ artifact, config: origin.config })
          requireRelease(
            result.verification?.state === 'identical',
            'immutable-unverified',
            'Immutable upload lacks exact verification.'
          )
          const receipt = {
            origin: origin.name,
            objectKey: artifact.objectKey,
            sha256: artifact.sha256,
            sizeBytes: artifact.sizeBytes,
            etag: result.verification.etag ?? null
          }
          results.push(receipt)
          await onVerified(receipt)
        }
      })
    )
  }
  return results
}

export function publicationPlatformMap(state, requestId, platform) {
  const request = state.requests[requestId]
  const releaseId = request.identity.releaseIds[platform]
  const platforms = new Set([platform])
  for (const candidate of Object.values(state.requests))
    for (const [name, phase] of Object.entries(candidate.platforms)) {
      if (
        candidate.identity.releaseIds[name] === releaseId &&
        phase.publication?.primaryVerified === true
      )
        platforms.add(name)
    }
  return { [releaseId]: [...platforms] }
}

export function exactPublishedChangelog({
  canonicalEntry,
  remoteDocument,
  verifiedPlatforms,
  generatedAt
}) {
  return mergeChangelogDocuments({
    localEntries: [canonicalEntry],
    publishingPlatform: verifiedPlatforms[0],
    publishingReleaseId: canonicalEntry.version,
    publicationPlatforms: { [canonicalEntry.version]: verifiedPlatforms },
    remoteDocument,
    generatedAt
  })
}

export function assertMonotonicPointer({ current, next, objectKey }) {
  if (!current) return
  const version = (bytes) =>
    objectKey.endsWith('.yml')
      ? load(bytes.toString())?.version
      : (JSON.parse(bytes.toString()).bundleVersion ?? JSON.parse(bytes.toString()).version)
  const before = version(current)
  const after = version(next)
  requireRelease(
    /^\d+\.\d+\.\d+$/.test(before) && /^\d+\.\d+\.\d+$/.test(after),
    'pointer-version',
    'Every origin pointer must expose its numeric version.'
  )
  const comparison = compareNumericVersions(after, before)
  requireRelease(comparison >= 0, 'pointer-regression', 'An origin pointer cannot move backward.')
  requireRelease(
    comparison !== 0 || Buffer.from(current).equals(Buffer.from(next)),
    'pointer-identity',
    'Same-version pointer bytes must be identical.'
  )
}

// Invoked only after the Actions job owns release-publication. The injected
// claim is a durable single-writer control operation, not a local lockfile.
export async function finalizePublication({
  requestId,
  platform,
  artifacts,
  origins,
  primaryName,
  blockedOrigins = [],
  claim,
  readRemote,
  writeIntent,
  writeComplete,
  complete,
  unknown,
  publish = publishReleaseUploadArtifact,
  verifyImmutable = inspectReleaseUploadArtifact,
  buildChangelog = null
}) {
  const transaction = await claim()
  const generation = transaction.generation
  const { immutableArtifacts, pointerArtifacts } = partitionReleaseUploadArtifacts(artifacts)
  const receipts = []
  try {
    const orderedOrigins = [...origins].sort(
      (a, b) => Number(a.name === primaryName) - Number(b.name === primaryName)
    )
    for (const origin of orderedOrigins) {
      // Finalizers trust staging receipts only for identical immutable identities;
      // recheck referenced bytes on the chosen origin before mutating a pointer.
      for (const artifact of immutableArtifacts) {
        const verified = await verifyImmutable({ artifact, config: origin.config })
        requireRelease(
          verified.state === 'identical',
          'missing-public-artifact',
          'Public pointer references an absent or changed artifact.'
        )
      }
      let pointers = pointerArtifacts
      if (buildChangelog) {
        const changelog = await buildChangelog(origin)
        pointers = [
          ...pointerArtifacts.filter((entry) => entry.objectKey !== 'changelog/changelog.json'),
          changelog
        ]
      }
      for (const artifact of orderReleaseUploadArtifacts(pointers)) {
        const next = artifact.body ?? (await readFile(artifact.path))
        const current = await readRemote(origin, artifact.objectKey)
        if (artifact.objectKey !== 'changelog/changelog.json')
          assertMonotonicPointer({ current, next, objectKey: artifact.objectKey })
        const receipt = {
          origin: origin.name,
          objectKey: artifact.objectKey,
          sha256: artifact.sha256,
          generation,
          bodyBase64: Buffer.from(next).toString('base64')
        }
        await writeIntent(receipt)
        const result = await publish({ artifact, config: origin.config })
        requireRelease(
          result.verification?.state === 'identical',
          'pointer-unverified',
          'Pointer bytes were not verified.'
        )
        await writeComplete(receipt)
        const { bodyBase64, ...identityReceipt } = receipt
        receipts.push(identityReceipt)
      }
    }
    requireRelease(
      origins.some((origin) => origin.name === primaryName),
      'primary-unavailable',
      'Primary publication cannot be silently skipped.'
    )
    const publication = {
      requestId,
      platform,
      generation,
      primaryVerified: true,
      origins: origins.map(({ name }) => name),
      pendingOrigins: blockedOrigins.map(({ name }) => name),
      writes: receipts,
      artifacts: artifacts.map(
        ({ label, objectKey, sha256, sizeBytes, contentType, immutable }) => ({
          label,
          objectKey,
          sha256,
          sizeBytes,
          contentType,
          immutable
        })
      )
    }
    await complete(publication)
    return publication
  } catch (error) {
    await unknown({ requestId, platform, generation }).catch(() => {})
    throw error
  }
}

export function inlinePublicationArtifact({
  objectKey,
  value,
  label = 'changelog',
  contentType = 'application/json'
}) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  return {
    label,
    objectKey,
    body,
    immutable: false,
    contentType,
    sizeBytes: body.byteLength,
    sha256: createHash('sha256').update(body).digest('hex')
  }
}
