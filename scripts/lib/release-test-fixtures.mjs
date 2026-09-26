import {
  newReleaseState,
  applyReleaseOperation,
  RELEASE_POLICY_VERSION,
  releaseDigest
} from './release-state.mjs'
import { ReleaseError } from './release-github.mjs'
export const identity = (id = 'request-one', version = '1.2.3') => ({
  id,
  version,
  platforms: ['macos', 'windows'],
  releaseIds: { macos: `${version}-beta.1`, windows: `${version}-alpha.1` },
  sourceSha: 'a'.repeat(40),
  toolingSha: 'a'.repeat(40),
  policyVersion: RELEASE_POLICY_VERSION,
  originIdentity: 'b'.repeat(64)
})
export function harness() {
  let state = newReleaseState()
  let sequence = 0
  return {
    get state() {
      return state
    },
    apply(type, fields = {}, verified = {}) {
      const op = {
        id: `operation-${++sequence}`,
        expectedRevision: state.revision,
        type,
        requestId: 'request-one',
        platform: 'windows',
        ...fields
      }
      const result = applyReleaseOperation(state, op, verified)
      state = result.state
      return result
    },
    activate(id = 'request-one', version = '1.2.3') {
      const value = identity(id, version)
      return this.apply('activate', { identity: value }, { identity: value })
    }
  }
}
export function ready(h) {
  h.activate()
  h.apply('signed', {}, { manifestHash: 'c'.repeat(64), artifacts: [{}] })
  h.apply(
    'acceptance',
    {},
    { status: 'PASS', sourceSha: 'a'.repeat(40), releaseId: '1.2.3-alpha.1' }
  )
}
export function memoryStore({ crashAfterState = false } = {}) {
  const data = new Map()
  return {
    data,
    async read(key) {
      return structuredClone(data.get(key) ?? null)
    },
    async write(key, value, etag = null) {
      if (data.has(key) && data.get(key).etag !== etag) {
        if (releaseDigest(data.get(key).value) === releaseDigest(value)) return data.get(key)
        throw new ReleaseError('control-conflict', 'conflict')
      }
      const result = { value: structuredClone(value), etag: releaseDigest(value) }
      data.set(key, result)
      if (key === 'state.json' && crashAfterState) {
        crashAfterState = false
        throw new Error('process died after durable write')
      }
      return result
    },
    async list(prefix) {
      return [...data.keys()].filter((key) => key.startsWith(prefix)).sort()
    }
  }
}
