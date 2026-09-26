import { createHash } from 'node:crypto'
import { requireRelease } from './release-github.mjs'

export const RELEASE_POLICY_VERSION = 1
export const RELEASE_STATE_SCHEMA = 1
export const RELEASE_PHASES = Object.freeze([
  'preparing',
  'building',
  'signing',
  'awaiting-acceptance',
  'pilot',
  'ready-to-publish',
  'publishing',
  'verifying',
  'live',
  'superseded',
  'failed',
  'publication-unknown'
])
export const canonicalJson = (value) =>
  JSON.stringify(value, (_, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map((key) => [key, entry[key]])
        )
      : entry
  )
export const releaseDigest = (value) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex')
export const newReleaseState = () => ({
  schemaVersion: RELEASE_STATE_SCHEMA,
  revision: 0,
  requests: {},
  active: {},
  versions: {},
  publication: null,
  generation: 0,
  operations: {}
})

export function validateReleaseIdentity(value) {
  requireRelease(
    value && /^[a-z0-9][a-z0-9-]{7,79}$/.test(value.id),
    'request-id',
    'Request ID must contain 8–80 lowercase letters, digits or hyphens.'
  )
  requireRelease(
    /^\d+\.\d+\.\d+$/.test(value.version),
    'request-version',
    'Request needs a numeric version.'
  )
  for (const key of ['sourceSha', 'toolingSha'])
    requireRelease(
      /^[a-f0-9]{40}$/.test(value[key]),
      'request-source',
      `Request ${key} must be a full SHA.`
    )
  requireRelease(
    value.policyVersion === RELEASE_POLICY_VERSION,
    'request-policy',
    'Unsupported release policy.'
  )
  requireRelease(
    /^[a-f0-9]{64}$/.test(value.originIdentity),
    'request-origin',
    'Request must bind configured publication destinations.'
  )
  requireRelease(
    Array.isArray(value.platforms) &&
      value.platforms.length > 0 &&
      new Set(value.platforms).size === value.platforms.length &&
      value.platforms.every((platform) => ['windows', 'macos'].includes(platform)),
    'request-platform',
    'Select macOS and/or Windows.'
  )
  for (const platform of value.platforms)
    requireRelease(
      platform === 'windows'
        ? value.releaseIds?.windows === `${value.version}-alpha.1`
        : new RegExp(`^${value.version.replaceAll('.', '\\.')}\\-beta\\.[1-9][0-9]*$`).test(
            value.releaseIds?.macos
          ),
      'request-release-id',
      'Release IDs must match the frozen version.'
    )
  requireRelease(
    Object.keys(value).every((key) =>
      [
        'id',
        'version',
        'sourceSha',
        'toolingSha',
        'policyVersion',
        'originIdentity',
        'platforms',
        'releaseIds'
      ].includes(key)
    ),
    'request-fields',
    'Unexpected request identity field.'
  )
  requireRelease(
    Object.keys(value.releaseIds).every((key) => value.platforms.includes(key)),
    'request-release-ids',
    'Unexpected release ID.'
  )
  return structuredClone(value)
}

export function requestIsEligible(state, requestId, platform) {
  return (
    state.active[platform] === requestId &&
    state.requests[requestId]?.platforms[platform]?.phase !== 'superseded'
  )
}

// Pure single-writer state machine. The control service validates external facts
// before passing an operation here; caller-provided facts never become authority.
export function applyReleaseOperation(previous, operation, verified = {}) {
  requireRelease(
    previous.schemaVersion === RELEASE_STATE_SCHEMA,
    'state-schema',
    'Unsupported release state.'
  )
  requireRelease(
    /^[a-z0-9][a-z0-9-]{7,119}$/.test(operation.id),
    'operation-id',
    'Invalid operation ID.'
  )
  const digest = releaseDigest(operation)
  const existing = previous.operations[operation.id]
  if (existing) {
    requireRelease(
      existing.digest === digest,
      'operation-id-reused',
      'An operation ID cannot name different inputs.'
    )
    return { state: previous, result: existing, replay: true }
  }
  const state = structuredClone(previous)
  const reject = (code) => finish({ status: 'rejected', code })
  function finish(result) {
    state.revision++
    const receipt = { ...result, digest, revision: state.revision, operationId: operation.id }
    state.operations[operation.id] = receipt
    return { state, result: receipt, replay: false }
  }
  if (operation.expectedRevision !== previous.revision) return reject('stale-revision')
  if (operation.type === 'activate') {
    const identity = validateReleaseIdentity(verified.identity)
    requireRelease(
      releaseDigest(identity) === releaseDigest(operation.identity),
      'activation-proof',
      'Verified activation identity differs from request.'
    )
    const identityDigest = releaseDigest(identity)
    const old = state.requests[identity.id]
    if (old)
      return releaseDigest(old.identity) === identityDigest
        ? finish({ status: 'duplicate', requestId: identity.id })
        : reject('request-id-reused')
    const reserved = state.versions[identity.version]
    if (reserved && reserved !== identityDigest) return reject('same-version-conflict')
    state.versions[identity.version] = identityDigest
    const platforms = {}
    for (const platform of identity.platforms) {
      const predecessor = state.active[platform]
      if (predecessor) {
        const prior = state.requests[predecessor].platforms[platform]
        prior.supersededBy = identity.id
        // A durable claim survives a newer desired request. Never interrupt writes.
        if (
          !(
            state.publication?.requestId === predecessor && state.publication.platform === platform
          ) &&
          !['live', 'verifying'].includes(prior.phase)
        )
          prior.phase = 'superseded'
      }
      state.active[platform] = identity.id
      platforms[platform] = { phase: 'preparing', receipts: [], dispatches: {}, announcements: {} }
    }
    state.requests[identity.id] = { identity, platforms }
    return finish({ status: 'applied', requestId: identity.id })
  }
  const request = state.requests[operation.requestId]
  const platform = request?.platforms[operation.platform]
  requireRelease(platform, 'request-missing', 'Unknown request/platform.')
  const ownsClaim =
    state.publication?.requestId === operation.requestId &&
    state.publication?.platform === operation.platform
  if (operation.type === 'cancel') {
    if (ownsClaim) return reject('publication-in-progress')
    if (!['live', 'verifying'].includes(platform.phase)) platform.phase = 'superseded'
    if (state.active[operation.platform] === operation.requestId)
      delete state.active[operation.platform]
    return finish({ status: 'applied' })
  }
  const completingPublication =
    ['production', 'mirror-synced', 'announcement-intent', 'announcement-result'].includes(
      operation.type
    ) &&
    platform.publication &&
    platform.publication.generation === state.lastPublished?.[operation.platform]
  if (
    !requestIsEligible(state, operation.requestId, operation.platform) &&
    !ownsClaim &&
    !completingPublication
  )
    return reject('superseded')
  if (operation.type === 'retry-build') {
    requireRelease(
      operation.platform === 'windows' &&
        !platform.signing &&
        !platform.dispatches.sign &&
        ['preparing', 'building', 'failed'].includes(platform.phase),
      'retry-build-ineligible',
      'Only unsigned preparation can be retried; signing identity cannot be reset.'
    )
    const old = platform.dispatches.build
    platform.abandonedBuilds ??= []
    if (old) platform.abandonedBuilds.push(old)
    const sequence = platform.abandonedBuilds.length + 1
    platform.dispatches.build = {
      correlation: `${operation.requestId}-build-${sequence}`,
      state: 'intent'
    }
    platform.phase = 'building'
    return finish({ status: 'applied', dispatch: platform.dispatches.build })
  }
  if (operation.type === 'dispatch') {
    requireRelease(
      ['build', 'sign', 'pilot', 'public', 'macos-finalize'].includes(operation.stage),
      'dispatch-stage',
      'Invalid dispatch stage.'
    )
    if (platform.dispatches[operation.stage])
      return finish({ status: 'duplicate', dispatch: platform.dispatches[operation.stage] })
    const allowed = {
      build: ['preparing', 'building'],
      sign: ['building', 'signing'],
      pilot: ['awaiting-acceptance', 'pilot'],
      public: ['ready-to-publish'],
      'macos-finalize': ['ready-to-publish']
    }
    requireRelease(
      allowed[operation.stage].includes(platform.phase),
      'dispatch-transition',
      'Dispatch cannot regress a completed phase.'
    )
    const correlation = `${operation.requestId}-${operation.stage}`
    platform.dispatches[operation.stage] = { correlation, state: 'intent' }
    platform.phase =
      operation.stage === 'build'
        ? 'building'
        : operation.stage === 'sign'
          ? 'signing'
          : platform.phase
    return finish({ status: 'applied', dispatch: platform.dispatches[operation.stage] })
  }
  if (operation.type === 'dispatch-start') {
    const dispatch = platform.dispatches[operation.stage]
    requireRelease(dispatch, 'dispatch-missing', 'Dispatch intent is missing.')
    if (dispatch.state !== 'intent') return finish({ status: 'duplicate', dispatch })
    dispatch.state = 'unknown'
    dispatch.sendOperationId = operation.id
    return finish({ status: 'applied', dispatch })
  }
  if (operation.type === 'run') {
    const dispatch = platform.dispatches[operation.stage]
    requireRelease(
      dispatch && verified.run && verified.run.correlation === dispatch.correlation,
      'run-proof',
      'Run does not match the durable dispatch.'
    )
    if (dispatch.runId)
      requireRelease(
        dispatch.runId === verified.run.runId && dispatch.attempt === verified.run.attempt,
        'run-conflict',
        'Dispatch already has a different run identity.'
      )
    Object.assign(dispatch, verified.run, { state: 'observed' })
    return finish({ status: 'applied' })
  }
  if (operation.type === 'sign-start') {
    requireRelease(
      verified.unsigned && platform.dispatches.sign?.runId === verified.runId,
      'sign-proof',
      'Signing must bind a verified unsigned producer and registered signing run.'
    )
    if (platform.signing) {
      requireRelease(
        platform.signing.runId === verified.runId && platform.signing.attempt === verified.attempt,
        'signing-unknown',
        'Signing already started. Reconcile the original signed payload; never re-sign on retry.'
      )
    } else
      platform.signing = { ...verified.unsigned, runId: verified.runId, attempt: verified.attempt }
    return finish({ status: 'applied' })
  }
  if (operation.type === 'signed' || operation.type === 'staged') {
    requireRelease(
      verified.artifacts?.length && verified.manifestHash,
      'artifact-proof',
      'Validated immutable artifacts are required.'
    )
    if (platform.candidate) {
      requireRelease(
        releaseDigest(platform.candidate) === releaseDigest(verified),
        'candidate-conflict',
        'Signed identity cannot change.'
      )
      return finish({ status: 'duplicate' })
    }
    requireRelease(
      ['preparing', 'building', 'signing'].includes(platform.phase),
      'candidate-transition',
      'Candidate receipt arrived after its phase closed.'
    )
    platform.candidate = verified
    platform.phase = 'awaiting-acceptance'
  } else if (operation.type === 'acceptance') {
    requireRelease(
      platform.candidate &&
        ['PASS', 'waived'].includes(verified.status) &&
        verified.sourceSha === request.identity.sourceSha &&
        verified.releaseId === request.identity.releaseIds[operation.platform],
      'acceptance-proof',
      'Acceptance must bind the exact candidate.'
    )
    if (platform.acceptance) {
      requireRelease(
        releaseDigest(platform.acceptance) === releaseDigest(verified),
        'acceptance-conflict',
        'Acceptance identity cannot change.'
      )
      return finish({ status: 'duplicate' })
    }
    requireRelease(
      ['awaiting-acceptance', 'pilot'].includes(platform.phase),
      'acceptance-transition',
      'Acceptance cannot regress a completed phase.'
    )
    platform.acceptance = verified
    platform.phase = 'ready-to-publish'
  } else if (operation.type === 'claim') {
    if (state.publication) {
      if (ownsClaim && state.publication.status === 'active')
        return finish({ status: 'duplicate', claim: state.publication })
      return reject('publication-unreconciled')
    }
    const pilot = operation.stage === 'pilot'
    requireRelease(
      (pilot
        ? ['awaiting-acceptance', 'pilot'].includes(platform.phase)
        : platform.phase === 'ready-to-publish') &&
        platform.candidate &&
        (pilot || platform.acceptance) &&
        verified.eligible === true,
      'publication-ineligible',
      'Finalization requires revalidated artifacts, acceptance and eligibility.'
    )
    state.generation++
    state.publication = {
      requestId: operation.requestId,
      platform: operation.platform,
      generation: state.generation,
      stage: operation.stage ?? 'public',
      status: 'active',
      writes: {}
    }
    platform.phase = 'publishing'
    return finish({ status: 'applied', claim: state.publication })
  } else if (operation.type === 'write-intent' || operation.type === 'write-complete') {
    requireRelease(
      ownsClaim && state.publication.generation === operation.generation,
      'claim-mismatch',
      'Publication generation does not own the transaction.'
    )
    requireRelease(
      verified.write && typeof verified.write.key === 'string',
      'write-proof',
      'Publication write receipt is required.'
    )
    const prior = state.publication.writes[verified.write.key]
    if (prior)
      requireRelease(
        prior.sha256 === verified.write.sha256,
        'write-conflict',
        'A generation cannot rewrite a pointer with different bytes.'
      )
    state.publication.writes[verified.write.key] = {
      ...verified.write,
      status: operation.type === 'write-intent' ? 'intent' : 'verified'
    }
  } else if (operation.type === 'recover-publication') {
    requireRelease(
      ownsClaim &&
        verified.inspected === true &&
        verified.generation === state.publication.generation,
      'recovery-proof',
      'Recovery must inspect the exact unresolved generation.'
    )
    state.publication.status = 'active'
    platform.phase = 'publishing'
  } else if (operation.type === 'publication-unknown') {
    requireRelease(ownsClaim, 'claim-mismatch', 'Unknown publication must own its claim.')
    state.publication.status = 'unknown'
    platform.phase = 'publication-unknown'
  } else if (operation.type === 'published') {
    requireRelease(
      ownsClaim &&
        verified.publication &&
        verified.publication.generation === state.publication.generation,
      'publication-proof',
      'Exact verified publication receipt required.'
    )
    if (state.publication.stage === 'pilot') {
      platform.pilotPublication = verified.publication
      platform.phase = 'pilot'
      state.publication = null
      return finish({ status: 'applied' })
    }
    platform.publication = verified.publication
    state.lastPublished ??= {}
    state.lastPublished[operation.platform] = state.publication.generation
    platform.phase = 'verifying'
    state.publication = null
  } else if (operation.type === 'mirror-synced') {
    requireRelease(
      !state.publication &&
        platform.publication?.generation === state.lastPublished?.[operation.platform] &&
        verified.mirror?.generation === platform.publication.generation,
      'mirror-stale',
      'Cannot apply a stale mirror catch-up receipt.'
    )
    const origin = verified.mirror.origin
    platform.publication.origins = [...new Set([...platform.publication.origins, origin])]
    platform.publication.pendingOrigins = platform.publication.pendingOrigins.filter(
      (name) => name !== origin
    )
    platform.mirrorReceipts ??= {}
    platform.mirrorReceipts[origin] = verified.mirror
  } else if (operation.type === 'production') {
    requireRelease(
      platform.publication && verified.production?.complete === true,
      'production-proof',
      'Production checks must complete before live.'
    )
    if (platform.production) {
      requireRelease(
        releaseDigest(platform.production) === releaseDigest(verified.production) ||
          (verified.production.mirrorRoute === 'PASS' &&
            (platform.production.origins ?? []).every((origin) =>
              verified.production.origins.includes(origin)
            ) &&
            releaseDigest({ ...platform.production, origins: [], mirrorRoute: null }) ===
              releaseDigest({ ...verified.production, origins: [], mirrorRoute: null })),
        'production-conflict',
        'Production evidence changed.'
      )
      platform.production = verified.production
      return finish({ status: 'duplicate' })
    }
    requireRelease(
      platform.phase === 'verifying',
      'production-transition',
      'Production verification arrived out of order.'
    )
    platform.production = verified.production
    platform.phase = 'live'
  } else if (operation.type === 'announcement-intent' || operation.type === 'announcement-result') {
    requireRelease(
      platform.phase === 'live' && verified.announcement,
      'announcement-not-live',
      'Announcements require verified live bytes.'
    )
    const { key, ...receipt } = verified.announcement
    const old = platform.announcements[key]
    if (operation.type === 'announcement-intent') {
      if (old) return finish({ status: 'duplicate', announcement: old })
      platform.announcements[key] = { ...receipt, status: 'unknown' }
    } else {
      requireRelease(
        old && receipt.status === 'confirmed' && receipt.messageId,
        'announcement-proof',
        'A confirmed remote message identity is required.'
      )
      platform.announcements[key] = receipt
    }
  } else {
    requireRelease(false, 'operation-type', 'Unknown release operation.')
  }
  platform.receipts.push({
    operationId: operation.id,
    type: operation.type,
    digest: releaseDigest(verified)
  })
  return finish({ status: 'applied' })
}
