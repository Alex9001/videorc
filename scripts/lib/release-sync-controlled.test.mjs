import test from 'node:test'
import assert from 'node:assert/strict'
import { copyObjects } from '../sync-release-origins.mjs'
test('controlled flat updater binaries use frozen immutable history descriptors', async () => {
  for (const suffix of ['zip', 'exe', 'zip.blockmap']) {
    const objectKey = `updates/windows/Videorc-1.2.3.${suffix}`
    await assert.rejects(
      copyObjects({
        from: { name: 'primary', config: {} },
        to: { name: 'mirror', config: {} },
        objectKeys: [objectKey],
        expected: new Map([[objectKey, 'a'.repeat(64)]]),
        immutableKeys: new Set([objectKey]),
        strict: true,
        createTransport: () => ({ close() {} }),
        download: async () => ({ sha256: 'a'.repeat(64), sizeBytes: 10 }),
        publish: async ({ artifact }) => {
          assert.equal(artifact.immutable, true)
          throw Object.assign(new Error('existing immutable differs'), {
            code: 'immutable-artifact-collision'
          })
        }
      }),
      { code: 'immutable-artifact-collision' }
    )
  }
})
