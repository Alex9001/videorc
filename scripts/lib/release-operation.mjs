import { requireRelease } from './release-github.mjs'
import { validateReleaseIdentity } from './release-state.mjs'

const BASE = ['id', 'type', 'expectedRevision', 'requestId', 'platform']
const FIELDS = {
  activate: ['identity'],
  'retry-build': [],
  cancel: [],
  dispatch: ['stage'],
  'dispatch-start': ['stage'],
  run: ['stage', 'runId', 'attempt'],
  'sign-start': ['runId', 'attempt'],
  signed: [],
  staged: [],
  acceptance: ['recordUrl'],
  claim: ['stage'],
  'write-intent': ['generation', 'write'],
  'write-complete': ['generation', 'write'],
  'publication-unknown': [],
  'recover-publication': [],
  published: [],
  production: ['production'],
  'mirror-synced': ['generation', 'origin'],
  'announcement-intent': ['announcement'],
  'announcement-result': ['announcement']
}
export function validateReleaseOperation(operation) {
  requireRelease(
    operation &&
      typeof operation === 'object' &&
      !Array.isArray(operation) &&
      JSON.stringify(operation).length <= 12_000,
    'operation-shape',
    'Operation must be a bounded JSON object.'
  )
  requireRelease(
    Object.hasOwn(FIELDS, operation.type) &&
      Object.keys(operation).every((key) => [...BASE, ...FIELDS[operation.type]].includes(key)),
    'operation-fields',
    'Unsupported operation type or fields.'
  )
  requireRelease(
    /^[a-z0-9][a-z0-9-]{7,119}$/.test(operation.id) &&
      Number.isSafeInteger(operation.expectedRevision) &&
      operation.expectedRevision >= 0,
    'operation-identity',
    'Operation needs an ID and expected revision.'
  )
  if (operation.type === 'activate') validateReleaseIdentity(operation.identity)
  else
    requireRelease(
      /^[a-z0-9][a-z0-9-]{7,79}$/.test(operation.requestId) &&
        ['windows', 'macos'].includes(operation.platform),
      'operation-request',
      'Operation needs an exact request and platform.'
    )
  if (operation.origin)
    requireRelease(
      ['r2', 'hetzner', 'neon'].includes(operation.origin),
      'operation-origin',
      'Unknown origin.'
    )
  if (operation.stage)
    requireRelease(
      ['build', 'sign', 'pilot', 'public', 'macos-finalize'].includes(operation.stage),
      'operation-stage',
      'Unsupported stage.'
    )
  for (const field of ['runId', 'attempt', 'generation'])
    if (operation[field] !== undefined)
      requireRelease(
        Number.isSafeInteger(operation[field]) && operation[field] > 0,
        'operation-number',
        `Invalid ${field}.`
      )
  if (operation.recordUrl)
    requireRelease(
      /^https:\/\/(github\.com|raw\.githubusercontent\.com)\/TheOrcDev\/videorc\/(blob\/)?[a-f0-9]{40}\/docs\/acceptance\/windows-alpha\/[0-9.]+-alpha\.1\.json$/.test(
        operation.recordUrl
      ),
      'operation-record',
      'Acceptance URL must be exact commit-pinned repository JSON.'
    )
  for (const [name, allowed] of [
    ['write', ['origin', 'objectKey', 'sha256']],
    ['announcement', ['key', 'channel', 'contentHash', 'messageId', 'status']]
  ]) {
    if (operation[name])
      requireRelease(
        typeof operation[name] === 'object' &&
          !Array.isArray(operation[name]) &&
          Object.keys(operation[name]).every((key) => allowed.includes(key)) &&
          Object.values(operation[name]).every(
            (value) => typeof value === 'string' && value.length < 512 && !/[\r\n\0]/.test(value)
          ),
        'operation-payload',
        'Operation contains unexpected receipt fields.'
      )
  }
  if (operation.production)
    requireRelease(
      JSON.stringify(operation.production).length < 10_000 &&
        Object.keys(operation.production).every((key) =>
          [
            'requestId',
            'platform',
            'generation',
            'complete',
            'routes',
            'releasePage',
            'origins',
            'mirrorRoute'
          ].includes(key)
        ),
      'production-fields',
      'Unexpected production observation fields.'
    )
  if (operation.production) {
    const receipt = operation.production
    requireRelease(
      Array.isArray(receipt.routes) &&
        receipt.routes.length <= 12 &&
        receipt.routes.every(
          (route) =>
            Object.keys(route).every((key) =>
              ['label', 'status', 'sha256', 'sizeBytes'].includes(key)
            ) &&
            /^[a-z-]+$/.test(route.label) &&
            route.status === 'PASS' &&
            /^[a-f0-9]{64}$/.test(route.sha256) &&
            Number.isSafeInteger(route.sizeBytes)
        ),
      'production-routes',
      'Invalid production route observation.'
    )
    requireRelease(
      Array.isArray(receipt.origins) &&
        receipt.origins.every((origin) => ['r2', 'hetzner', 'neon'].includes(origin)) &&
        ['PASS', 'pending', 'not-configured'].includes(receipt.mirrorRoute),
      'production-origins',
      'Invalid production origin observation.'
    )
  }
  return operation
}
