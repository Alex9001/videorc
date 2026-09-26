import test from 'node:test'
import assert from 'node:assert/strict'
import { releaseRunMetrics, summarizeReleaseMetrics } from './release-metrics.mjs'
test('blocked job timestamps never masquerade as CPU runtime', () => {
  const metrics = releaseRunMetrics({
    run: { id: 1, created_at: '2026-09-24T14:00:00Z', status: 'in_progress' },
    jobs: [{ name: 'sign', started_at: '2026-09-24T14:01:00Z', steps: [] }],
    pending: [{}],
    now: Date.parse('2026-09-24T20:00:00Z')
  })
  assert.equal(metrics.elapsedMs, 6 * 3600_000)
  assert.equal(metrics.phases[0].executionMs, null)
  assert.equal(metrics.blocker, 'environment-approval')
})
test('cold and warm percentile samples stay separate', () => {
  const result = summarizeReleaseMetrics([
    { cache: 'cold', candidateMs: 60 },
    { cache: 'warm', candidateMs: 20 },
    { cache: 'warm', candidateMs: 30 }
  ])
  assert.equal(result.cold.p95, 60)
  assert.equal(result.warm.p50, 20)
  assert.equal(result.warm.samples, 2)
})
