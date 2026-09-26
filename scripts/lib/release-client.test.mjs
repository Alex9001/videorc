import test from 'node:test'
import assert from 'node:assert/strict'
import { createReleaseClient } from './release-client.mjs'
const run = (id) => ({
  id,
  path: '.github/workflows/release-control.yml',
  head_branch: 'main',
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success'
})
test('fresh status selects latest serialized upload even when its run was created before the last ten runs', async () => {
  let downloads = 0
  const client = createReleaseClient({
    github: {
      api: async (path, options) => {
        assert.equal(options, undefined)
        if (path.includes('/artifacts'))
          return {
            artifacts: [
              { id: 99, name: 'release-state-1', workflow_run: { id: 1 } },
              { id: 98, name: 'release-state-20', workflow_run: { id: 20 } }
            ]
          }
        assert.match(path, /runs\/1$/)
        return run(1)
      }
    },
    downloadSnapshot: async () => {
      downloads++
      return { revision: 21 }
    }
  })
  assert.equal((await client.snapshot()).revision, 21)
  assert.equal((await client.snapshot()).revision, 21)
  assert.equal(downloads, 1)
})
test('submission uses returned run ID and durably rebases only stale-revision', async () => {
  const operations = []
  const client = createReleaseClient({
    github: {
      api: async (path, options) => {
        if (options) {
          assert.equal(options.body.return_run_details, true)
          operations.push(JSON.parse(options.body.inputs.operation))
          return { workflow_run_id: operations.length }
        }
        assert.match(path, /actions\/runs\/[12]$/)
        return run(operations.length)
      }
    },
    downloadSnapshot: async (entry) => ({
      revision: entry.id + 4,
      operations: {
        [operations.at(-1).id]:
          entry.id === 1 ? { status: 'rejected', code: 'stale-revision' } : { status: 'applied' }
      }
    })
  })
  assert.equal(
    (
      await client.submit({
        id: 'first',
        expectedRevision: 1,
        type: 'signed',
        requestId: 'r',
        platform: 'windows'
      })
    ).status,
    'applied'
  )
  assert.equal(operations.length, 2)
  assert.notEqual(operations[1].id, operations[0].id)
  assert.equal(operations[1].expectedRevision, 5)
  assert.equal(operations[1].type, 'signed')
})
