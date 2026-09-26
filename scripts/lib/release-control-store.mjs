import { validateReleaseOperation } from './release-operation.mjs'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  buildSignedS3Request,
  createReleaseUploadS3Transport,
  getReleaseUploadS3Config,
  releaseUploadOriginCapabilities
} from './release-upload-s3.mjs'
import {
  canonicalJson,
  releaseDigest,
  newReleaseState,
  applyReleaseOperation
} from './release-state.mjs'
import { requireRelease, ReleaseError } from './release-github.mjs'

export function controlStoreConfig(env = process.env) {
  const mapped = Object.fromEntries(
    Object.entries(env)
      .filter(([key]) => key.startsWith('VIDEORC_RELEASE_CONTROL_S3_'))
      .map(([key, value]) => [
        key.replace('VIDEORC_RELEASE_CONTROL_S3_', 'VIDEORC_RELEASE_UPLOAD_S3_'),
        value
      ])
  )
  const config = getReleaseUploadS3Config(mapped)
  const dataEnvironment = Object.fromEntries(
    Object.entries(env)
      .filter(([key]) => key.startsWith('VIDEORC_RELEASE_CONTROL_DATA_S3_'))
      .map(([key, value]) => [
        key.replace('VIDEORC_RELEASE_CONTROL_DATA_S3_', 'VIDEORC_RELEASE_UPLOAD_S3_'),
        value
      ])
  )
  const dataConfig = getReleaseUploadS3Config(dataEnvironment)
  requireRelease(
    config.bucket !== dataConfig.bucket || config.endpointUrl !== dataConfig.endpointUrl,
    'control-authority-separation',
    'State and submission/evidence storage must be separate private destinations with separate credentials.'
  )
  const prefix = env.VIDEORC_RELEASE_CONTROL_PREFIX || 'videorc-release-control/v1'
  requireRelease(
    /^videorc-release-control\/(?:staging-[a-z0-9-]+|v1)$/.test(prefix),
    'control-prefix',
    'Control storage must use its reserved private prefix.'
  )
  return { config, dataConfig, prefix }
}

export function createReleaseControlStore({
  config,
  dataConfig = config,
  prefix,
  transport = createReleaseUploadS3Transport({ config }),
  dataTransport = createReleaseUploadS3Transport({ config: dataConfig })
}) {
  const stateKey = (key) => /^(state\.json|capability\.json|results\/|probes\/)/.test(key)
  const destination = (key) => (stateKey(key) ? config : dataConfig)
  const keyFor = (key) => {
    requireRelease(
      /^[a-zA-Z0-9][a-zA-Z0-9/._-]*$/.test(key) && !key.split('/').includes('..'),
      'control-key',
      'Unsafe control object key.'
    )
    return `${prefix}/${key}`
  }
  async function request(method, key, body = null, additionalHeaders = {}, listing = {}) {
    const signed = buildSignedS3Request({
      config: destination(key),
      method,
      objectKey: keyFor(key),
      additionalHeaders,
      ...listing
    })
    return (stateKey(key) ? transport : dataTransport).request(signed.url, {
      method,
      headers: {
        ...signed.headers,
        ...(body
          ? {
              'Content-Length': String(Buffer.byteLength(body)),
              'Content-Type': 'application/json'
            }
          : {})
      },
      body
    })
  }
  async function bytes(response) {
    const chunks = []
    let size = 0
    const iterator = response.body?.[Symbol.asyncIterator]?.()
    requireRelease(iterator, 'control-response', 'Control response has no readable body.')
    const deadline = Date.now() + 30_000
    try {
      while (true) {
        let timer
        const part = await Promise.race([
          iterator.next(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new ReleaseError('control-timeout', 'Control response timed out.')),
              Math.max(1, deadline - Date.now())
            )
          })
        ]).finally(() => clearTimeout(timer))
        if (part.done) break
        size += part.value.byteLength
        requireRelease(
          size <= 16 * 1024 * 1024,
          'control-size',
          'Control object exceeds bounded size.'
        )
        chunks.push(Buffer.from(part.value))
      }
      return Buffer.concat(chunks).toString('utf8')
    } finally {
      response.body?.destroy?.()
    }
  }
  const store = {
    async read(key) {
      const response = await request('GET', key)
      if (response.status === 404) {
        response.body?.destroy?.()
        return null
      }
      requireRelease(response.ok, 'control-read', `Control GET failed: HTTP ${response.status}.`)
      const etag = response.headers.get('etag')
      requireRelease(
        etag && !/[\r\n]/.test(etag),
        'control-etag',
        'Control store must supply an ETag.'
      )
      return { value: JSON.parse(await bytes(response)), etag }
    },
    async write(key, value, etag = null) {
      const body = canonicalJson(value)
      const condition =
        etag === null
          ? { 'If-None-Match': '*' }
          : {
              'If-Match':
                releaseUploadOriginCapabilities(destination(key)).ifMatchEtagForm === 'unquoted'
                  ? etag.replaceAll('"', '')
                  : etag
            }
      let response
      try {
        response = await request('PUT', key, body, condition)
      } catch {
        const actual = await store.read(key)
        if (actual && canonicalJson(actual.value) === body) return actual
        throw new ReleaseError(
          'control-write-unknown',
          'Control write response lost. Reconcile this operation before continuing.'
        )
      }
      response.body?.destroy?.()
      if ([409, 412].includes(response.status)) {
        const actual = await store.read(key)
        if (actual && canonicalJson(actual.value) === body) return actual
        throw new ReleaseError(
          'control-conflict',
          'Control object changed; reread before applying.'
        )
      }
      requireRelease(response.ok, 'control-write', `Control PUT failed: HTTP ${response.status}.`)
      const actual = await store.read(key)
      requireRelease(
        actual && canonicalJson(actual.value) === body,
        'control-write-verification',
        'Control write did not round trip exactly.'
      )
      return actual
    },
    async list(directory) {
      const result = []
      let token = null
      do {
        const response = await request(
          'GET',
          `${directory}listing`,
          null,
          {},
          { listPrefix: keyFor(directory), continuationToken: token }
        )
        requireRelease(
          response.ok,
          'control-list',
          `Control listing failed: HTTP ${response.status}.`
        )
        const xml = await bytes(response)
        requireRelease(
          !/<!DOCTYPE|<!ENTITY/.test(xml),
          'control-list-xml',
          'Unsafe XML in control listing.'
        )
        for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
          const key = decodeURIComponent(match[1])
          requireRelease(
            key.startsWith(`${prefix}/`),
            'control-list-prefix',
            'Listing escaped the private control prefix.'
          )
          result.push(key.slice(prefix.length + 1))
        }
        token =
          /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/
            .exec(xml)?.[1]
            ?.replaceAll('&amp;', '&') ?? null
        requireRelease(
          !/<IsTruncated>true<\/IsTruncated>/.test(xml) || token,
          'control-list-truncated',
          'Missing control continuation token.'
        )
      } while (token)
      return result.sort()
    },
    close() {
      transport.close()
      dataTransport.close()
    }
  }
  return store
}

export async function probeControlStore(store) {
  const key = `probes/${randomUUID()}.json`
  const first = await store.write(key, { value: 1 })
  let refused = false
  try {
    await store.write(key, { value: 2 })
  } catch (error) {
    refused = error.code === 'control-conflict'
  }
  requireRelease(
    refused,
    'conditional-create-unsupported',
    'Control store ignored If-None-Match. Do not enable the controller.'
  )
  await store.write(key, { value: 2 }, first.etag)
  refused = false
  try {
    await store.write(key, { value: 3 }, first.etag)
  } catch (error) {
    refused = error.code === 'control-conflict'
  }
  requireRelease(
    refused,
    'conditional-update-unsupported',
    'Control store ignored stale If-Match. Do not enable the controller.'
  )
  const dataKey = `data-probes/${randomUUID()}.json`
  const dataFirst = await store.write(dataKey, { value: 1 })
  refused = false
  try {
    await store.write(dataKey, { value: 2 })
  } catch (error) {
    refused = error.code === 'control-conflict'
  }
  requireRelease(
    refused,
    'conditional-data-create-unsupported',
    'Submission store ignored If-None-Match.'
  )
  await store.write(dataKey, { value: 2 }, dataFirst.etag)
  await store.write('capability.json', {
    schemaVersion: 1,
    conditionalCreate: true,
    conditionalUpdate: true
  })
  return { conditionalCreate: true, conditionalUpdate: true }
}

export async function submitReleaseIntent(store, operation) {
  validateReleaseOperation(operation)
  requireRelease(
    /^[a-z0-9][a-z0-9-]{7,119}$/.test(operation.id),
    'operation-id',
    'Invalid operation ID.'
  )
  // No active-state authority in the submission job. Conditional create is mandatory.
  const key = `intents/${operation.id}.json`
  const existing = await store.read(key)
  if (existing)
    requireRelease(
      releaseDigest(existing.value) === releaseDigest(operation),
      'operation-id-reused',
      'Operation ID already has different input.'
    )
  else await store.write(key, operation)
  return operation.id
}

export async function reconcileReleaseIntents({ store, verifyOperation, onResult = () => {} }) {
  requireRelease(
    (await store.read('capability.json'))?.value?.conditionalCreate === true,
    'control-unprovisioned',
    'Probe the private control store before activation.'
  )
  for (const key of await store.list('intents/')) {
    const invalidKey = `results/invalid-${releaseDigest(key)}.json`
    if (await store.read(invalidKey)) continue
    let operation
    try {
      operation = (await store.read(key))?.value
      validateReleaseOperation(operation)
      requireRelease(
        key === `intents/${operation.id}.json`,
        'operation-key',
        'Intent key and operation identity differ.'
      )
    } catch (error) {
      // DATA writers are not trusted STATE writers. Malformed inbox documents
      // must never reach the reducer, snapshot, result key or stop other intents.
      if (
        !(error instanceof SyntaxError) &&
        !/^(operation-|request-|production-)/.test(error.code ?? '')
      )
        throw error
      await store.write(invalidKey, {
        status: 'rejected',
        code: 'malformed-intent',
        keyDigest: releaseDigest(key)
      })
      continue
    }
    if (await store.read(`results/${operation.id}.json`)) continue
    let current = await store.read('state.json')
    const previous = current?.value ?? newReleaseState()
    let applied
    if (previous.operations[operation.id])
      applied = { state: previous, result: previous.operations[operation.id], replay: true }
    else {
      try {
        const verified =
          operation.expectedRevision === previous.revision
            ? await verifyOperation(operation, previous)
            : {}
        applied = applyReleaseOperation(previous, operation, verified)
      } catch (error) {
        if (!error.code) throw error
        const state = structuredClone(previous)
        state.revision++
        const result = {
          status: 'rejected',
          code: error.code,
          digest: releaseDigest(operation),
          operationId: operation.id,
          revision: state.revision
        }
        state.operations[operation.id] = result
        applied = { state, result }
      }
      current = await store.write('state.json', applied.state, current?.etag ?? null)
    }
    // State embeds the result before the append-only copy: process death between
    // these writes is replayed from state, never reapplied.
    await store.write(`results/${operation.id}.json`, applied.result)
    await onResult(applied.result)
  }
  return (await store.read('state.json'))?.value ?? newReleaseState()
}

export async function waitControlResult(
  store,
  operationId,
  { timeoutMs = 120_000, sleep = delay } = {}
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await store.read(`results/${operationId}.json`)
    if (result) return result.value
    await sleep(2000)
  }
  throw new ReleaseError(
    'control-pending',
    'Control intent is durable but not yet applied. Reconcile; do not create a replacement operation.'
  )
}
