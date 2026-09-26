import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyReadonlyStateCredential } from './release-readiness.mjs'
test('readiness proves server denial rather than trusting a role label', async () => {
  const store = {
    read: async () => ({ value: {} }),
    write: async () => {
      throw Object.assign(new Error('Control PUT failed: HTTP 403.'), { code: 'control-write' })
    }
  }
  assert.equal((await verifyReadonlyStateCredential(store)).stateWriteDenied, 'PASS')
  await assert.rejects(verifyReadonlyStateCredential({ ...store, write: async () => ({}) }), {
    code: 'readiness-state-writer'
  })
  await assert.rejects(
    verifyReadonlyStateCredential({
      ...store,
      write: async () => {
        throw new Error('network lost')
      }
    }),
    { code: 'readiness-state-writer' }
  )
})
